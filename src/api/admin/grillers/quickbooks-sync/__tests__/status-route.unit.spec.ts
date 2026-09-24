import { GET } from "../status/route"
import { emitOpsAlert } from "../../../../../lib/ops-alert"

jest.mock("../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: any) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeReq(query: Record<string, unknown> = {}) {
  return {
    query,
    auth_context: { actor_id: "user_ops" },
    scope: {
      resolve: (key: string) => {
        if (key === "logger") {
          return { warn: jest.fn(), error: jest.fn() }
        }
        return undefined
      },
    },
  } as any
}

describe("QuickBooks sync status route alerting", () => {
  const previousUrl = process.env.QB_SYNC_STATUS_URL
  const previousToken = process.env.QB_SYNC_STATUS_TOKEN
  const previousImportUrl = process.env.QB_SYNC_ORDER_IMPORT_URL
  const previousImportToken = process.env.QB_SYNC_ORDER_IMPORT_TOKEN
  const previousFetch = global.fetch

  beforeEach(() => {
    process.env.QB_SYNC_STATUS_URL = "https://sync.example.test"
    process.env.QB_SYNC_STATUS_TOKEN = "sync-token"
    delete process.env.QB_SYNC_ORDER_IMPORT_URL
    delete process.env.QB_SYNC_ORDER_IMPORT_TOKEN
    ;(emitOpsAlert as jest.Mock).mockClear()
  })

  afterEach(() => {
    process.env.QB_SYNC_STATUS_URL = previousUrl
    process.env.QB_SYNC_STATUS_TOKEN = previousToken
    process.env.QB_SYNC_ORDER_IMPORT_URL = previousImportUrl
    process.env.QB_SYNC_ORDER_IMPORT_TOKEN = previousImportToken
    global.fetch = previousFetch
  })

  it("emits a warn alert when the sync status upstream returns an error", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "sync db unavailable" }), {
          status: 500,
        })
    ) as any

    const res = makeRes()
    await GET(makeReq({ page: "2" }), res)

    expect(res.statusCode).toBe(500)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "qbd_sync_dashboard_failed",
        severity: "warn",
        fingerprint: "qbd_sync_dashboard:status:upstream_error:500",
        meta: expect.objectContaining({
          operation: "status",
          reason: "upstream_error",
          status: 500,
          sync_host: "sync.example.test",
          staff_actor_id: "user_ops",
        }),
      })
    )
  })

  it("emits a warn alert when the sync status upstream is unreachable", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("connect ECONNREFUSED")
    }) as any

    const res = makeRes()
    await GET(makeReq(), res)

    expect(res.statusCode).toBe(502)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "qbd_sync_dashboard_failed",
        severity: "warn",
        fingerprint: "qbd_sync_dashboard:status:unreachable:network",
        meta: expect.objectContaining({
          operation: "status",
          reason: "unreachable",
          error_message: "connect ECONNREFUSED",
        }),
      })
    )
  })

  it.each([
    "<html>Bad gateway</html>",
    JSON.stringify({ error: "not configured" }),
    "null",
  ])("rejects a malformed successful upstream response: %s", async (body) => {
    global.fetch = jest.fn(
      async () => new Response(body, { status: 200 })
    ) as any
    const res = makeRes()
    await GET(makeReq(), res)
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toHaveProperty("summary")
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ reason: "invalid_response" }),
      })
    )
  })

  it("recovers with verified fresh session evidence and independent queue counts", async () => {
    const payload = {
      summary: {
        total_orders: 9,
        open: 7,
        waiting: 7,
        stale_pending: 0,
        blocked: 0,
        error: 0,
        warning: 0,
        skipped: 0,
        synced: 2,
      },
      sync_status: {
        active: false,
        health: {
          version: 1,
          state: "fresh",
          activity: "idle",
          observed_at: "2026-09-20T16:00:00Z",
          last_auth_at: "2026-09-20T15:59:00Z",
          last_accepted_auth_at: "2026-09-20T15:59:00Z",
          last_auth_status: "success",
          age_seconds: 60,
          max_age_seconds: 900,
          expires_at: "2026-09-20T16:14:00Z",
          issue: null,
        },
      },
      orders: {
        data: [],
        current_page: 1,
        per_page: 25,
        total: 7,
        last_page: 1,
        has_more_pages: false,
      },
      recent_logs: [],
    }
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify(payload))
    ) as any
    const res = makeRes()
    await GET(makeReq(), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.summary).toEqual(payload.summary)
    expect(res.body.sync_status.active).toBe(false)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: "no-store" })
    )
    expect(emitOpsAlert).not.toHaveBeenCalled()
    payload.sync_status.health.age_seconds = 0
    const inconsistent = makeRes()
    await GET(makeReq(), inconsistent)
    expect(inconsistent.statusCode).toBe(502)
  })

  it("returns unavailable on a bounded timeout without retaining a successful payload", async () => {
    jest.useFakeTimers()
    try {
      global.fetch = jest.fn(
        (_url, init: any) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("request timed out"))
            )
          })
      ) as any
      const res = makeRes()
      const pending = GET(makeReq(), res)
      await jest.advanceTimersByTimeAsync(12_000)
      await pending
      expect(res.statusCode).toBe(502)
      expect(res.body).not.toHaveProperty("sync_status")
    } finally {
      jest.useRealTimers()
    }
  })
})
