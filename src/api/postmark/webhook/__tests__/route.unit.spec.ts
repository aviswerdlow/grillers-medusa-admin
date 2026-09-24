import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updatePostmarkMessageState } from "../../../../lib/communications/core"
import { emitOpsAlert } from "../../../../lib/ops-alert"

jest.mock("../../../../lib/communications/core", () => ({
  updatePostmarkMessageState: jest.fn(),
}))

jest.mock("../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

// Import after mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../route")

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeReq(
  body: Record<string, unknown> = {
    RecordType: "Bounce",
    MessageID: "postmark-message-1",
    Recipient: "customer@example.com",
  },
  opts: { secret?: string; headerSecret?: string; traceId?: string } = {}
) {
  const logger = { error: jest.fn(), warn: jest.fn() }
  const db = jest.fn()
  const headers: Record<string, string> = {}
  if (opts.headerSecret) headers["x-postmark-webhook-secret"] = opts.headerSecret
  if (opts.traceId) headers["x-pm-webhook-trace-id"] = opts.traceId
  return {
    req: {
      body,
      query: opts.secret ? { secret: opts.secret } : {},
      headers,
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
          if (key === ContainerRegistrationKeys.LOGGER) return logger
          throw new Error(`Unexpected resolve(${key})`)
        },
      },
    } as any,
    db,
    logger,
  }
}

describe("postmark webhook route alerting", () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv, POSTMARK_WEBHOOK_SECRET: "expected-secret" }
    ;(updatePostmarkMessageState as jest.Mock).mockResolvedValue(null)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("passes the retry-stable trace ID and returns Postmark's required 200", async () => {
    const { req, db } = makeReq(undefined, {
      headerSecret: "expected-secret",
      traceId: "trace-123",
    })
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(updatePostmarkMessageState).toHaveBeenCalledWith(
      db,
      req.body,
      "trace-123"
    )
    expect(emitOpsAlert).not.toHaveBeenCalled()
  })

  it("fails closed and pages when the shared secret is missing", async () => {
    process.env = { ...originalEnv, POSTMARK_WEBHOOK_SECRET: "" }
    const { req, logger } = makeReq()
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ ok: false, error: "webhook_secret_missing" })
    expect(updatePostmarkMessageState).not.toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "postmark_webhook_secret_missing",
        title: "Postmark webhook secret is missing",
        path: "src/api/postmark/webhook/route.ts",
        severity: "page",
        fingerprint: "postmark_webhook:secret_missing",
        logger,
        meta: expect.objectContaining({
          reason: "POSTMARK_WEBHOOK_SECRET is not configured",
        }),
      })
    )
  })

  it("rejects an invalid shared secret without alerting", async () => {
    process.env = {
      ...originalEnv,
      POSTMARK_WEBHOOK_SECRET: "expected-secret",
    }
    const { req } = makeReq({}, { headerSecret: "wrong-secret" })
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ ok: false, error: "unauthorized" })
    expect(updatePostmarkMessageState).not.toHaveBeenCalled()
    expect(emitOpsAlert).not.toHaveBeenCalled()
  })

  it("alerts with redacted error text when processing fails", async () => {
    ;(updatePostmarkMessageState as jest.Mock).mockRejectedValue(
      new Error("insert failed for customer@example.com")
    )
    const { req, logger } = makeReq(undefined, {
      headerSecret: "expected-secret",
    })
    const res = makeRes()

    await POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: "webhook_processing_failed",
    })
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "postmark_webhook_processing_failed",
        title: "Postmark webhook processing failed",
        path: "src/api/postmark/webhook/route.ts",
        severity: "warn",
        fingerprint: "postmark_webhook:processing_failed:bounce",
        logger,
        meta: expect.objectContaining({
          record_type: "bounce",
          postmark_message_id: "postmark-message-1",
          has_recipient: true,
          error_message: "insert failed for [redacted-email]",
        }),
      })
    )
    expect(JSON.stringify((emitOpsAlert as jest.Mock).mock.calls[0][0].meta))
      .not.toContain("customer@example.com")
  })
})
