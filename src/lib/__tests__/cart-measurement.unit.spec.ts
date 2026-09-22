import {
  captureCartResponse,
  cartSourceFromRow,
  cartMeasurementProperties,
  deriveCartMeasurement,
  validCartMeasurement,
} from "../cart-measurement"
import {
  nativeSnapshotHash,
  requestMeasurementContext,
  customerMeasurementContext,
} from "../analytics/customer-measurement-context"
import { captureCartMeasurementResponse } from "../../api/middlewares/cart-measurement"
import GpAnalyticsProviderService from "../../modules/gp-analytics/service"
import {
  writeEventToClickHouse,
  writeEventToGa4,
} from "../communications/destinations"
jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn() }))
const env = { ...process.env },
  originalFetch = global.fetch
const at = new Date(Date.now() - 10_000)
const uuid = "00000000-0000-4000-8000-000000000001"
const header = (patch: any = {}) =>
  Buffer.from(
    JSON.stringify({
      analytics_consent: true,
      analytics_consent_at: at.getTime() - 1000,
      marketing_consent: false,
      test_event: false,
      analytics_environment: "production",
      experiment_context: {},
      experiment_context_status: "complete",
      anonymous_id: uuid,
      session_id: uuid,
      ...patch,
    })
  ).toString("base64url")
const context = () => requestMeasurementContext(header(), at.getTime(), true)!
const cart = () => ({
  id: "cart_one",
  email: "private@example.test",
  customer_id: "cus_one",
  total: 0,
  currency_code: "USD",
  updated_at: new Date(at.getTime() - 1000),
  items: [{ id: "item_one", quantity: 2 }],
  shipping_address: { address_1: "Private street" },
  metadata: {},
})
beforeEach(() => {
  process.env = {
    ...env,
    STRIPE_API_KEY: "sk_live_fixture",
    GP_CART_MEASUREMENT_ENABLED: "true",
  }
  jest.clearAllMocks()
})
afterEach(() => {
  process.env = { ...env }
  global.fetch = originalFetch
})

it("keeps an explicit analytics denial without browser identities or assignment collection", () => {
  const c = requestMeasurementContext(
    header({ analytics_consent: false, marketing_consent: true }),
    at.getTime(),
    true
  )!
  expect(c).toMatchObject({
    analytics_consent: false,
    marketing_consent: true,
    test_order: false,
    experiment_context_status: "unverified",
  })
  expect(c).not.toHaveProperty("anonymous_id")
  expect(c).not.toHaveProperty("session_id")
  expect(c.experiment_assignments).toEqual([])
  expect(
    customerMeasurementContext(
      header({ analytics_consent: false }),
      at.getTime()
    )
  ).toBeNull()
})
it("preserves response observation time, native revision, true zero and immutable original context", () => {
  const c = context(),
    response = cart(),
    s = captureCartResponse(response, c, "production", at, uuid)!
  response.total = 99
  ;(c.experiment_assignments as any[]).push({ experiment_id: "later" })
  expect(s).toMatchObject({
    occurred_at: at.toISOString(),
    cart: {
      value: 0,
      native_updated_at: new Date(at.getTime() - 1000).toISOString(),
      item_count: 2,
    },
  })
  expect(s.context?.experiment_assignments).toEqual([])
  expect(JSON.stringify(s)).not.toContain("Private street")
  expect(validCartMeasurement(s)).toBe(true)
  expect(
    captureCartResponse(
      { ...cart(), total: null },
      null,
      "unavailable",
      at,
      uuid
    )?.cart.value
  ).toBeNull()
})
it.each([
  null,
  { id: "cart_one" },
  { ...cart(), metadata: { staff_target_customer_id: "cus_staff" } },
])("does not invent a complete native response %#", (value) => {
  expect(captureCartResponse(value, null, "production", at, uuid)).toBeNull()
})
it("preserves derived original lineage and detects source tampering after JSONB reordering", () => {
  const s = captureCartResponse(cart(), context(), "production", at, uuid)!
  const derived = deriveCartMeasurement(
    s,
    "expired",
    new Date(at.getTime() + 60000)
  )
  expect(validCartMeasurement(derived)).toBe(true)
  const reordered = Object.fromEntries(Object.entries(derived).reverse())
  expect(nativeSnapshotHash(reordered)).toBe(nativeSnapshotHash(derived))
  const row = {
    source: "medusa-native-cart-response-v1",
    event_id: derived.event_id,
    event_name: derived.event_name,
    context: {
      native_cart_snapshot: reordered,
      native_cart_hash: nativeSnapshotHash(derived),
    },
  }
  expect(cartSourceFromRow(row)).toEqual(derived)
  expect(
    cartSourceFromRow({ ...row, event_name: "order_completed" })
  ).toBeNull()
  expect(
    cartSourceFromRow({
      ...row,
      context: {
        ...row.context,
        native_cart_snapshot: { ...derived, lane: "rehearsal" },
      },
    })
  ).toBeNull()
})

function responseFixture(options: any = {}) {
  const emit = jest.fn(async (_event: any) => undefined),
    warn = jest.fn(),
    original = jest.fn()
  const req: any = {
    method: "POST",
    params: { id: "cart_one" },
    headers: { "x-gp-measurement-context": header() },
    body: { id: "cart_forged", total: 999999 },
    scope: {
      resolve: (key: string) => (key === "event_bus" ? { emit } : { warn }),
    },
    ...options,
  }
  const res: any = { statusCode: 200, json: original },
    next = jest.fn()
  captureCartMeasurementResponse(req, res, next)
  return { req, res, emit, warn, original, next }
}
it("captures the successful response exactly once, never request cart values or later configuration", async () => {
  const f = responseFixture(),
    body = { cart: cart() }
  process.env.STRIPE_API_KEY = "sk_test_later"
  f.res.json(body)
  f.res.json(body)
  expect(f.emit).toHaveBeenCalledTimes(1)
  const saved = f.emit.mock.calls[0][0] as any
  expect(saved.data.cart.value).toBe(0)
  expect(saved.data.lane).toBe("production")
  expect(saved.data.context.test_order).toBe(false)
  expect(f.original).toHaveBeenCalledWith(body)
})
it("captures the native parent response for line deletion", () => {
  const f = responseFixture({ method: "DELETE" })
  f.res.json({ deleted: true, object: "line-item", parent: cart() })
  expect(f.emit).toHaveBeenCalledTimes(1)
})
it.each([
  { method: "GET" },
  { gp_staff_cart: { actor_id: "staff" } },
  { params: { id: "cart_other" } },
])(
  "does not capture a read, staff action or mismatched response %#",
  (options) => {
    const f = responseFixture(options)
    f.res.json({ cart: cart() })
    expect(f.emit).not.toHaveBeenCalled()
  }
)
it.each([400, 403, 500])(
  "keeps failed native status %i out of the source",
  (status) => {
    const f = responseFixture()
    f.res.statusCode = status
    f.res.json({ cart: cart() })
    expect(f.emit).not.toHaveBeenCalled()
  }
)
it("does not capture native completion error envelopes returned with HTTP 200", () => {
  const f = responseFixture()
  f.res.json({
    type: "cart",
    cart: cart(),
    error: { message: "payment failed" },
  })
  expect(f.emit).not.toHaveBeenCalled()
})
it("does not relabel a conflicting test marker or malformed header as production", () => {
  for (const value of ["broken", header({ test_event: true })]) {
    const f = responseFixture({
      headers: { "x-gp-measurement-context": value },
    })
    f.res.json({ cart: cart() })
    expect((f.emit.mock.calls[0][0] as any).data).toMatchObject({
      lane: "unavailable",
      context: null,
    })
  }
})
it("does not delay/change a successful cart response when event-bus notification fails", async () => {
  const f = responseFixture()
  f.emit.mockRejectedValue(new Error("bus unavailable"))
  const body = { cart: cart() }
  f.res.json(body)
  expect(f.original).toHaveBeenCalledWith(body)
  await Promise.resolve()
  expect(f.warn).toHaveBeenCalledWith(
    "[cart-measurement] source notification unavailable"
  )
})
it("does not register source capture until activated", () => {
  delete process.env.GP_CART_MEASUREMENT_ENABLED
  const f = responseFixture()
  f.res.json({ cart: cart() })
  expect(f.emit).not.toHaveBeenCalled()
})

it("retains original cart identity/context on isolated transports without leaking recipient PII", async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    headers: new Headers({
      "x-gp-analytics-environment": "rehearsal",
      "x-gp-rehearsal-id": "cart-fixture",
    }),
  })) as any
  const provider = new GpAnalyticsProviderService(
    { logger: { warn: jest.fn(), error: jest.fn() } } as any,
    {
      jitsuHost: "https://jitsu.example.test",
      jitsuServerSecret: "live-key",
      gpAnalyticsEndpoint: "https://analytics.example.test",
      gpAnalyticsServerKey: "live-gp",
      rehearsal: {
        id: "cart-fixture",
        jitsuHost: "https://isolated-jitsu.example.test",
        jitsuServerSecret: "isolated-key",
        gpAnalyticsEndpoint: "https://isolated-gp.example.test",
        gpAnalyticsServerKey: "isolated-gp-key",
      },
    }
  )
  const input: any = {
    event: "cart_updated",
    properties: {
      ...cartMeasurementProperties(
        captureCartResponse(cart(), context(), "production", at, uuid)!
      ),
      cart_id: "cart_one",
      idempotency_key: `native-cart:activity:cart_one:${uuid}`,
      event_timestamp_ms: at.getTime(),
      analytics_environment: "rehearsal",
      test_event: true,
      test_order: true,
      rehearsal_id: "cart-fixture",
      email: "private@example.test",
    },
  }
  for (const target of ["jitsu_rehearsal", "gp_analytics_rehearsal"] as const)
    expect(await provider.deliverCartMeasurement(target, input)).toEqual({
      status: "accepted",
    })
  const calls = (global.fetch as jest.Mock).mock.calls
  expect(calls.every(([url]) => String(url).includes("isolated"))).toBe(true)
  expect(JSON.stringify(calls)).not.toContain("private@example.test")
  expect(JSON.parse(calls[0][1].body).eventn_ctx.event_timestamp_ms).toBe(
    at.getTime()
  )
  expect(JSON.parse(calls[1][1].body).event_timestamp_ms).toBe(at.getTime())
  await expect(
    provider.deliverCartMeasurement("jitsu", {
      ...input,
      event: "order_completed",
    })
  ).rejects.toThrow("contract_invalid")
  await provider.track({ event: "cart_updated", properties: {} } as any)
  await provider.track({ event: "checkout_completed", properties: {} } as any)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})
it.each([
  {},
  {
    original_cart_source_valid: true,
    analytics_consent: false,
    test_event: false,
    analytics_environment: "production",
  },
  {
    original_cart_source_valid: true,
    analytics_consent: true,
    test_event: true,
    analytics_environment: "rehearsal",
  },
])(
  "excludes unavailable, denied or test cart-derived email measurement before configured destinations %#",
  async (properties) => {
    process.env.GA4_MEASUREMENT_ID = "G-FIXTURE"
    process.env.GA4_API_SECRET = "fixture"
    process.env.CLICKHOUSE_URL = "https://unreachable.example.test"
    global.fetch = jest.fn() as any
    const merge = jest.fn(async () => undefined)
    const db: any = () => ({
      insert: () => ({ onConflict: () => ({ merge }) }),
    })
    db.raw = (s: string) => s
    const event = {
      source: "communications-cart",
      event_id: "message-fixture",
      event_name: "email_sent",
      properties,
    }
    expect(await writeEventToGa4(db, event)).toBe(false)
    expect(await writeEventToClickHouse(db, event)).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(merge).toHaveBeenCalledTimes(2)
  }
)
