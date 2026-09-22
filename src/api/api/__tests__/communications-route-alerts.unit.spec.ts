import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  recordCommunicationEvent,
  recordIdentity,
  recordSuppression,
  subscribeProfile,
  upsertCustomerProfile,
  verifyServiceApiKey,
} from "../../../lib/communications/core"
import { emitOpsAlert } from "../../../lib/ops-alert"

jest.mock("../../../lib/communications/core", () => ({
  DEFAULT_NEWSLETTER_PREFERENCES: { marketing: true, recipes: true },
  MARKETING_SUPPRESSION_SCOPES: ["marketing", "lifecycle", "broadcast"],
  normalizeEmail: (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : "",
  preferenceUrl: (token: string) => `https://example.com/preferences/${token}`,
  recordCommunicationEvent: jest.fn(),
  recordIdentity: jest.fn(),
  recordSuppression: jest.fn(),
  subscribeProfile: jest.fn(),
  upsertCustomerProfile: jest.fn(),
  verifyServiceApiKey: jest.fn(() => true),
  withoutSmsConsentEvidence: (value: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !key.toLowerCase().startsWith("sms_")
      )
    ),
}))

jest.mock("../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

// Import after mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const trackRoute = require("../track/route")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const batchRoute = require("../batch/route")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const identifyRoute = require("../identify/route")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const subscribeRoute = require("../subscribe/route")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lookupRoute = require("../lookup/route")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const preferencesRoute = require("../preferences/[token]/route")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const unsubscribeRoute = require("../unsubscribe/[token]/route")

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    send(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeDb(profile: Record<string, any> | null = null) {
  const chain: any = {
    whereNull: jest.fn(() => chain),
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    first: jest.fn(async () => profile),
    update: jest.fn(async () => 1),
  }
  const db = jest.fn(() => chain)
  return { db, chain }
}

const originalEnvironment = { ...process.env }
const consentContext = {
  event_id: "00000000-0000-4000-8000-000000000001",
  event_timestamp_ms: 1789940000000,
  analytics_consent: true,
  analytics_consent_at: 1789930000000,
  analytics_environment: "production",
  test_event: false,
}

function makeReq(
  options: {
    body?: Record<string, any>
    db?: unknown
    params?: Record<string, string>
    headers?: Record<string, string>
  } = {}
) {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
  return {
    req: {
      body: {
        ...(options.body || {}),
        eventn_ctx: consentContext,
        ...(options.body?.events
          ? {
              events: options.body.events.map(
                (event: any, index: number) =>
                  event && {
                    ...event,
                    eventn_ctx: {
                      ...consentContext,
                      event_id: `00000000-0000-4000-8000-00000000000${
                        index + 1
                      }`,
                    },
                  }
              ),
            }
          : {}),
      },
      params: options.params || {},
      headers: options.headers || { authorization: "Bearer service-key" },
      scope: {
        resolve: (key: string) => {
          if (key === ContainerRegistrationKeys.PG_CONNECTION) {
            return options.db || jest.fn()
          }
          if (key === ContainerRegistrationKeys.LOGGER) return logger
          throw new Error(`Unexpected resolve(${key})`)
        },
      },
    } as any,
    logger,
  }
}

function expectCommunicationsAlert(operation: string, extraMeta = {}) {
  expect(emitOpsAlert).toHaveBeenCalledWith(
    expect.objectContaining({
      alertKind: "communications_api_request_failed",
      severity: "warn",
      fingerprint: `communications_api_request_failed:${operation}`,
      meta: expect.objectContaining({
        operation,
        ...extraMeta,
      }),
    })
  )
}

describe("communications public API route alerting", () => {
  afterEach(() => {
    process.env = { ...originalEnvironment }
  })
  beforeEach(() => {
    process.env.STRIPE_API_KEY = "sk_live_fixture"
    process.env.COMMUNICATIONS_PUBLIC_API_KEY = "service-key"
    jest.clearAllMocks()
    ;(verifyServiceApiKey as jest.Mock).mockReturnValue(true)
    ;(recordCommunicationEvent as jest.Mock).mockResolvedValue({
      event_id: "evt_ok",
    })
    ;(upsertCustomerProfile as jest.Mock).mockResolvedValue({
      id: "gpcprof_1",
      email: "shopper@example.com",
    })
    ;(recordIdentity as jest.Mock).mockResolvedValue(undefined)
    ;(subscribeProfile as jest.Mock).mockResolvedValue({
      id: "gpcprof_1",
      email: "shopper@example.com",
      email_consent: true,
      preferences: {},
      preference_token: "pref-token",
    })
    ;(recordSuppression as jest.Mock).mockResolvedValue(undefined)
  })

  it("alerts when /api/track cannot persist an event", async () => {
    ;(recordCommunicationEvent as jest.Mock).mockRejectedValueOnce(
      new Error("insert failed for shopper@example.com")
    )
    const { req } = makeReq({
      body: {
        event: "product_viewed",
        email: "shopper@example.com",
      },
    })
    const res = makeRes()

    await trackRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "event_record_failed" })
    expectCommunicationsAlert("track", {
      event_name: "product_viewed",
      has_email: true,
      error_message: "insert failed for [redacted-email]",
    })
  })

  it("alerts when /api/track rejects a malformed event", async () => {
    const { req } = makeReq({
      body: {
        email: "shopper@example.com",
        properties: { sku: "10-01" },
      },
    })
    const res = makeRes()

    await trackRoute.POST(req, res)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: "event is required" })
    expect(recordCommunicationEvent).not.toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "communications_api_events_dropped",
        severity: "warn",
        fingerprint:
          "communications_api_events_dropped:track:missing_event_name",
        meta: expect.objectContaining({
          operation: "track",
          reason: "missing_event_name",
          event_count: 1,
          accepted_count: 0,
          dropped_count: 1,
          sample_event_keys: ["email", "properties", "eventn_ctx"],
        }),
      })
    )
    expect(
      JSON.stringify((emitOpsAlert as jest.Mock).mock.calls[0][0].meta)
    ).not.toContain("shopper@example.com")
  })

  it("alerts when /api/batch cannot persist a batched event", async () => {
    ;(recordCommunicationEvent as jest.Mock).mockRejectedValueOnce(
      new Error("batch insert failed")
    )
    const { req } = makeReq({
      body: {
        events: [{ event: "product_viewed" }, { event: "cart_viewed" }],
      },
    })
    const res = makeRes()

    await batchRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "batch_record_failed" })
    expectCommunicationsAlert("batch", { event_count: 2 })
  })

  it("alerts when /api/batch drops malformed events without failing the request", async () => {
    const { req } = makeReq({
      body: {
        events: [
          {
            email: "shopper@example.com",
            properties: { sku: "10-01" },
          },
          null,
        ],
      },
    })
    const res = makeRes()

    await batchRoute.POST(req, res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({ ok: true, accepted: 0 })
    expect(recordCommunicationEvent).not.toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "communications_api_events_dropped",
        severity: "warn",
        fingerprint:
          "communications_api_events_dropped:batch:missing_event_name",
        meta: expect.objectContaining({
          operation: "batch",
          reason: "missing_event_name",
          event_count: 2,
          accepted_count: 0,
          dropped_count: 2,
          sample_event_keys: ["email", "properties", "eventn_ctx"],
        }),
      })
    )
    expect(
      JSON.stringify((emitOpsAlert as jest.Mock).mock.calls[0][0].meta)
    ).not.toContain("shopper@example.com")
  })

  it("alerts when /api/identify cannot write profile state", async () => {
    ;(upsertCustomerProfile as jest.Mock).mockRejectedValueOnce(
      new Error("identity upsert failed for shopper@example.com")
    )
    const { req } = makeReq({
      body: {
        user_id: "cus_1",
        traits: { email: "shopper@example.com" },
      },
    })
    const res = makeRes()

    await identifyRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "identify_failed" })
    expectCommunicationsAlert("identify", {
      event_name: "identify",
      has_email: true,
      error_message: "identity upsert failed for [redacted-email]",
    })
  })

  it("keeps public identify away from authoritative phone and customer identity", async () => {
    const { req } = makeReq({
      body: {
        user_id: "cus_claimed",
        anonymous_id: "anon_1",
        traits: {
          email: "shopper@example.com",
          phone: "+14045550100",
          first_name: "Overwritten",
          sms_consent: true,
          sms_program: "forged",
          locale: "en-US",
          timezone: "America/New_York",
        },
      },
    })
    const res = makeRes()

    await identifyRoute.POST(req, res)

    expect(res.statusCode).toBe(202)
    expect(upsertCustomerProfile).toHaveBeenCalledWith(expect.anything(), {
      email: "shopper@example.com",
      metadata: {
        locale: "en-US",
        timezone: "America/New_York",
      },
    })
    expect(recordIdentity).toHaveBeenCalledWith(
      expect.anything(),
      "gpcprof_1",
      expect.not.objectContaining({ medusa_customer_id: expect.anything() })
    )
    expect(recordCommunicationEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ medusa_customer_id: expect.anything() })
    )
  })

  it("alerts when /api/subscribe cannot persist signup state", async () => {
    ;(subscribeProfile as jest.Mock).mockRejectedValueOnce(
      new Error("signup failed for shopper@example.com")
    )
    const { req } = makeReq({
      body: { email: "shopper@example.com" },
    })
    const res = makeRes()

    await subscribeRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "subscribe_failed" })
    expectCommunicationsAlert("subscribe", {
      event_name: "email_signup",
      has_email: true,
      error_message: "signup failed for [redacted-email]",
    })
  })

  it("alerts when subscriber lookup cannot query profile state", async () => {
    const { db, chain } = makeDb()
    chain.first.mockRejectedValueOnce(
      new Error("lookup failed for shopper@example.com")
    )
    const { req } = makeReq({
      db,
      body: { email: "shopper@example.com" },
    })
    const res = makeRes()

    await lookupRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "lookup_failed" })
    expectCommunicationsAlert("lookup", {
      event_name: "subscriber_lookup",
      has_email: true,
      error_message: "lookup failed for [redacted-email]",
    })
  })

  it("alerts when preferences token lookup fails", async () => {
    const { db, chain } = makeDb()
    chain.first.mockRejectedValueOnce(
      new Error("preferences lookup failed for shopper@example.com")
    )
    const { req } = makeReq({
      db,
      params: { token: "pref-token" },
    })
    const res = makeRes()

    await preferencesRoute.GET(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: "preferences_lookup_failed",
    })
    expectCommunicationsAlert("preferences_lookup", {
      event_name: "email_preferences_lookup",
      has_token: true,
      error_message: "preferences lookup failed for [redacted-email]",
    })
  })

  it("alerts when preferences update cannot load profile state", async () => {
    const { db, chain } = makeDb()
    chain.first.mockRejectedValueOnce(
      new Error("preferences update lookup failed")
    )
    const { req } = makeReq({
      db,
      params: { token: "pref-token" },
      body: { preferences: { recipes: false } },
    })
    const res = makeRes()

    await preferencesRoute.PATCH(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: "preferences_update_failed",
    })
    expectCommunicationsAlert("preferences_update", {
      event_name: "email_preferences_updated",
      has_email: false,
      has_token: true,
      error_message: "preferences update lookup failed",
    })
  })

  it("alerts when preferences token updates fail after profile lookup", async () => {
    const { db } = makeDb({
      id: "gpcprof_1",
      email: "shopper@example.com",
      email_lower: "shopper@example.com",
      email_consent: true,
      preferences: { marketing: true, recipes: true },
    })
    ;(recordSuppression as jest.Mock).mockRejectedValueOnce(
      new Error("suppression failed for shopper@example.com")
    )
    const { req } = makeReq({
      db,
      params: { token: "pref-token" },
      body: { preferences: { recipes: false } },
    })
    const res = makeRes()

    await preferencesRoute.PATCH(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({
      ok: false,
      error: "preferences_update_failed",
    })
    expectCommunicationsAlert("preferences_update", {
      event_name: "email_preferences_updated",
      has_email: true,
      has_token: true,
      error_message: "suppression failed for [redacted-email]",
    })
  })

  it("alerts when unsubscribe cannot load profile state", async () => {
    const { db, chain } = makeDb()
    chain.first.mockRejectedValueOnce(new Error("unsubscribe lookup failed"))
    const { req } = makeReq({
      db,
      params: { token: "pref-token" },
    })
    const res = makeRes()

    await unsubscribeRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "unsubscribe_failed" })
    expectCommunicationsAlert("unsubscribe", {
      event_name: "email_unsubscribed",
      has_email: false,
      has_token: true,
      error_message: "unsubscribe lookup failed",
    })
  })

  it("alerts when unsubscribe token persistence fails after profile lookup", async () => {
    const { db, chain } = makeDb({
      id: "gpcprof_1",
      email: "shopper@example.com",
    })
    chain.update.mockRejectedValueOnce(
      new Error("unsubscribe failed for shopper@example.com")
    )
    const { req } = makeReq({
      db,
      params: { token: "pref-token" },
    })
    const res = makeRes()

    await unsubscribeRoute.POST(req, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: "unsubscribe_failed" })
    expectCommunicationsAlert("unsubscribe", {
      event_name: "email_unsubscribed",
      has_email: true,
      has_token: true,
      error_message: "unsubscribe failed for [redacted-email]",
    })
  })
})
