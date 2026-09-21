import { asValue, createContainer } from "awilix"
import {
  captureCustomerMeasurement,
  customerMeasurementContext,
  validCustomerSnapshot,
  customerSnapshotHash,
  CUSTOMER_MEASUREMENT_CONTEXT,
} from "../analytics/customer-measurement-context"
import { captureCustomerMeasurementRequest } from "../../api/middlewares/customer-measurement"
import {
  captureCustomerHook,
  compensateCustomerHook,
} from "../../workflows/hooks/customer-measurement"
import GpAnalyticsProviderService from "../../modules/gp-analytics/service"
import communicationsCommerceEvents from "../../subscribers/communications-commerce-events"
import {
  recordCommunicationEvent,
  upsertCustomerProfile,
} from "../communications/core"

jest.mock("@medusajs/medusa/core-flows", () => ({
  createCustomersWorkflow: { hooks: { customersCreated: jest.fn() } },
  updateCustomersWorkflow: { hooks: { customersUpdated: jest.fn() } },
}))
jest.mock("../communications/core", () => ({
  recordCommunicationEvent: jest.fn(),
  upsertCustomerProfile: jest.fn(),
  smsConsentFromCustomerMetadata: jest.fn(() => ({})),
}))
jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn() }))
const env = { ...process.env }
const at = new Date("2026-09-21T01:00:00Z")
const header = (override: any = {}) =>
  Buffer.from(
    JSON.stringify({
      analytics_consent: true,
      analytics_consent_at: at.getTime() - 1000,
      marketing_consent: false,
      test_event: false,
      analytics_environment: "production",
      experiment_context: {},
      experiment_context_status: "complete",
      ...override,
    })
  ).toString("base64url")
const context = () => customerMeasurementContext(header(), at.getTime())!
const customer = {
  id: "cus_native",
  created_at: at,
  updated_at: at,
  email: "private@example.test",
  phone: "+15555550100",
  first_name: "Private",
}
const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
beforeEach(() => {
  process.env = {
    ...env,
    STRIPE_API_KEY: "sk_live_fixture",
    GP_CUSTOMER_MEASUREMENT_ENABLED: "true",
  }
  jest.clearAllMocks()
  global.fetch = jest.fn(async () => ({
    ok: true,
    headers: new Headers(),
  })) as any
})
afterEach(() => {
  process.env = { ...env }
})

it("keeps explicit consent, verified empty context and no caller-native identity or PII", () => {
  const c = customerMeasurementContext(
    header({ customer_id: "other", email: "private@example.test" }),
    at.getTime()
  )!
  expect(c).toMatchObject({
    analytics_consent: true,
    marketing_consent: false,
    test_order: false,
    experiment_context_status: "complete",
  })
  expect(JSON.stringify(c)).not.toMatch(/private|other/)
})
it.each([
  undefined,
  "not-json",
  "x".repeat(12001),
  header({ analytics_consent: false }),
  header({ analytics_consent_at: at.getTime() + 1 }),
  header({ analytics_consent_at: "yesterday" }),
  header({ test_event: true }),
  header({ analytics_environment: "rehearsal" }),
])("refuses missing/invalid/denied/conflicting request context %#", (value) => {
  expect(customerMeasurementContext(value, at.getTime())).toBeNull()
})
it("cannot turn a test backend or unknown key into a production event", () => {
  for (const key of ["sk_test_fixture", ""]) {
    process.env.STRIPE_API_KEY = key
    expect(customerMeasurementContext(header(), at.getTime())).toBeNull()
  }
})
it("accepts an explicitly named rehearsal only against the server's configured run", () => {
  process.env.STRIPE_API_KEY = "sk_test_fixture"
  process.env.GP_ORDER_REHEARSAL_ENABLED = "true"
  process.env.GP_REHEARSAL_ID = "launch-fixture"
  const c = customerMeasurementContext(
    header({
      test_event: true,
      analytics_environment: "rehearsal",
      rehearsal_id: "launch-fixture",
    }),
    at.getTime()
  )
  expect(c).toMatchObject({ test_order: true, rehearsal_id: "launch-fixture" })
  expect(
    customerMeasurementContext(
      header({
        test_event: true,
        analytics_environment: "rehearsal",
        rehearsal_id: "other-run",
      }),
      at.getTime()
    )
  ).toBeNull()
})
it("does not call missing assignment evidence a known empty set", () => {
  expect(
    customerMeasurementContext(
      header({ experiment_context_status: undefined }),
      at.getTime()
    )?.experiment_context_status
  ).toBe("unverified")
})
it("freezes the actual mutation revision with a distinct workflow ID for each change", () => {
  const c = context()
  const a = captureCustomerMeasurement("updated", customer, c, "tx-a")!
  const b = captureCustomerMeasurement("updated", customer, c, "tx-b")!
  expect(a.event_id).not.toBe(b.event_id)
  expect(validCustomerSnapshot(a)).toBe(true)
  expect(a.occurred_at).toBe(at.toISOString())
  expect(JSON.stringify(a)).not.toMatch(/private|15555550100/)
  expect(
    captureCustomerMeasurement("updated", customer, null, "tx-a")
  ).toBeNull()
  expect(
    captureCustomerMeasurement(
      "updated",
      { ...customer, updated_at: null },
      c,
      "tx-a"
    )
  ).toBeNull()
  expect(customerSnapshotHash(a)).toBe(
    customerSnapshotHash(JSON.parse(JSON.stringify(a)))
  )
})
it("isolates concurrent request containers and does not inherit another customer's consent", async () => {
  const root = createContainer(),
    left = root.createScope(),
    right = root.createScope()
  const next = jest.fn()
  captureCustomerMeasurementRequest(
    { scope: left, headers: { "x-gp-measurement-context": header() } } as any,
    {} as any,
    next
  )
  captureCustomerMeasurementRequest(
    { scope: right, headers: {} } as any,
    {} as any,
    next
  )
  expect(left.resolve(CUSTOMER_MEASUREMENT_CONTEXT)).toMatchObject({
    analytics_consent: true,
  })
  expect(right.resolve(CUSTOMER_MEASUREMENT_CONTEXT)).toBeNull()
  expect(() => root.resolve(CUSTOMER_MEASUREMENT_CONTEXT)).toThrow()
  expect(next).toHaveBeenCalledTimes(2)
})
it("groups source capture with native success and removes it on compensation", async () => {
  const emit = jest.fn(),
    clearGroupedEvents = jest.fn()
  const container = createContainer()
  container.register({
    [CUSTOMER_MEASUREMENT_CONTEXT]: asValue(context()),
    event_bus: asValue({ emit, clearGroupedEvents }),
    logger: asValue(logger),
  })
  const execution = {
    container,
    eventGroupId: "group-1",
    transactionId: "tx-native",
  }
  const saved = await captureCustomerHook("updated", [customer], execution)
  expect(emit).toHaveBeenCalledWith([
    expect.objectContaining({
      metadata: { eventGroupId: "group-1" },
      data: expect.objectContaining({
        customer_id: "cus_native",
        transaction_id: "tx-native",
      }),
    }),
  ])
  await compensateCustomerHook(saved, execution)
  expect(clearGroupedEvents).toHaveBeenCalledWith("group-1", {
    eventNames: ["gp.customer_measurement_captured"],
  })
  emit.mockClear()
  await captureCustomerHook("updated", [customer], {
    ...execution,
    eventGroupId: undefined,
  })
  expect(emit).not.toHaveBeenCalled()
})
it("keeps a source-notification outage from failing the native account operation", async () => {
  const container = createContainer()
  container.register({
    [CUSTOMER_MEASUREMENT_CONTEXT]: asValue(context()),
    event_bus: asValue({
      emit: jest.fn().mockRejectedValue(new Error("offline")),
    }),
    logger: asValue(logger),
  })
  await expect(
    captureCustomerHook("created", [customer], {
      container,
      eventGroupId: "group",
      transactionId: "tx",
    })
  ).resolves.toBeUndefined()
  expect(logger.warn).toHaveBeenCalledWith(
    "[customer-measurement] source notification unavailable"
  )
})
it("preserves operational profile updates without an analytics event", async () => {
  const container = {
    resolve: (key: string) =>
      key === "query"
        ? { graph: async () => ({ data: [customer] }) }
        : key === "logger"
        ? logger
        : {},
  }
  await communicationsCommerceEvents({
    container,
    event: { name: "customer.updated", data: { id: customer.id } },
  } as any)
  expect(upsertCustomerProfile).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      medusa_customer_id: customer.id,
      email: customer.email,
    })
  )
  expect(recordCommunicationEvent).not.toHaveBeenCalled()
})
const service = () =>
  new GpAnalyticsProviderService({ logger } as any, {
    jitsuHost: "https://jitsu.production.example",
    jitsuServerSecret: "production-jitsu",
    gpAnalyticsEndpoint: "https://gp.production.example",
    gpAnalyticsServerKey: "production-gp",
    rehearsal: {
      id: "launch-fixture",
      jitsuHost: "https://jitsu.test.example",
      jitsuServerSecret: "test-jitsu",
      gpAnalyticsEndpoint: "https://gp.test.example",
      gpAnalyticsServerKey: "test-gp",
    },
  })
const dto = () => ({
  event: "customer_updated",
  actor_id: customer.id,
  properties: {
    ...context(),
    idempotency_key: "native-customer:updated:cus_native:tx-native",
    event_timestamp_ms: at.getTime(),
    email: customer.email,
  },
})
it("preserves one source ID/time across retries while removing PII from both targets", async () => {
  const s = service()
  await s.deliverCustomerMeasurement("jitsu", dto())
  await s.deliverCustomerMeasurement("jitsu", dto())
  await s.deliverCustomerMeasurement("gp_analytics", dto())
  const calls = (fetch as jest.Mock).mock.calls
  const bodies = calls.map(([, opts]) => JSON.parse(opts.body))
  expect(bodies[0].eventn_ctx.event_id).toBe(bodies[1].eventn_ctx.event_id)
  expect(bodies[0].eventn_ctx.event_id).toBe(bodies[2].event_id)
  expect(bodies[2].event_timestamp_ms).toBe(at.getTime())
  expect(JSON.stringify(bodies)).not.toContain(customer.email)
  expect(
    calls.every(([, opts]) => opts.redirect === "error" && opts.signal)
  ).toBe(true)
})
it("refuses public/native purchase impersonation and the retired customer/PII fallback", async () => {
  const s = service()
  await expect(
    s.deliverCustomerMeasurement("jitsu", {
      ...dto(),
      event: "order_completed",
    })
  ).rejects.toThrow("contract_invalid")
  await s.track(dto())
  await s.identify({
    actor_id: customer.id,
    properties: { email: customer.email },
  })
  expect(fetch).not.toHaveBeenCalled()
})
it("routes original tests only to the isolated run and requires its receiver acknowledgment", async () => {
  const s = service(),
    d = dto()
  d.properties = {
    ...d.properties,
    test_order: true,
    analytics_environment: "rehearsal",
    rehearsal_id: "launch-fixture",
  } as any
  expect(await s.deliverCustomerMeasurement("jitsu", d)).toMatchObject({
    status: "excluded",
  })
  await s.deliverCustomerMeasurement("jitsu_rehearsal", d)
  expect((fetch as jest.Mock).mock.calls[0][0]).toBe(
    "https://jitsu.test.example/api/v1/s2s/event"
  )
  await expect(
    s.deliverCustomerMeasurement("gp_analytics_rehearsal", d)
  ).rejects.toThrow("rehearsal_receiver_not_acknowledged")
})
