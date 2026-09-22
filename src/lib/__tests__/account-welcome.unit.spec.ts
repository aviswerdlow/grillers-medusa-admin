import { asValue, createContainer } from "awilix"
import { Modules } from "@medusajs/framework/utils"
import { captureAccountWelcomeResponse } from "../../api/middlewares/account-welcome"
import {
  ACCOUNT_WELCOME_CONTEXT,
  ACCOUNT_WELCOME_EVENT,
  ACCOUNT_WELCOME_SOURCE,
  captureWelcomeCustomers,
  welcomeFromResponse,
  validWelcomeSource,
  welcomeSourceFromRow,
  welcomeMeasurementProperties,
  welcomeServerLane,
  accountWelcomeEnabled,
} from "../account-welcome"
import { nativeSnapshotHash } from "../analytics/customer-measurement-context"
import {
  writeEventToGa4,
  writeEventToClickHouse,
} from "../communications/destinations"
const originalEnv = { ...process.env }
const at = new Date("2026-09-21T01:00:00Z")
const customer = {
  id: "cus_welcome",
  email: "original@example.test",
  first_name: "Original",
  has_account: true,
  created_at: at,
}
const header = (patch: any = {}) =>
  Buffer.from(
    JSON.stringify({
      analytics_consent: false,
      analytics_consent_at: at.getTime() - 1000,
      marketing_consent: false,
      test_event: false,
      analytics_environment: "production",
      ...patch,
    })
  ).toString("base64url")
function setup(raw?: string) {
  const emit = jest.fn().mockResolvedValue(undefined),
    warn = jest.fn(),
    json = jest.fn()
  const scope = createContainer().register({
    [Modules.EVENT_BUS]: asValue({ emit }),
    logger: asValue({ warn }),
  })
  const req = {
    method: "POST",
    headers: raw === undefined ? {} : { "x-gp-measurement-context": raw },
    scope,
  } as any
  const res = { statusCode: 200, json } as any
  captureAccountWelcomeResponse(req, res, jest.fn())
  return { scope, res, emit, warn, json }
}
beforeEach(() => {
  process.env = {
    ...originalEnv,
    GP_ACCOUNT_WELCOME_ENABLED: "true",
    STRIPE_API_KEY: "sk_live_fixture",
  }
})
afterEach(() => {
  process.env = { ...originalEnv }
  jest.restoreAllMocks()
})
it.each([undefined, header()])(
  "captures service welcome independently of analytics permission %#",
  async (raw) => {
    const x = setup(raw)
    captureWelcomeCustomers([customer], {
      container: x.scope,
      transactionId: "tx1",
    })
    x.res.json({ customer: { id: customer.id } })
    expect(x.emit).toHaveBeenCalledTimes(1)
    const event = x.emit.mock.calls[0][0]
    expect(event.name).toBe(ACCOUNT_WELCOME_EVENT)
    expect(event.data).toMatchObject({
      lane: "production",
      customer: { email: customer.email },
      transaction_id: "tx1",
    })
    expect(validWelcomeSource(event.data)).toBe(true)
    expect(event.data.context?.analytics_consent ?? null).toBe(
      raw ? false : null
    )
  }
)
it("preserves hook evidence against sparse/changed refetch fields and repeated hook execution", () => {
  const x = setup()
  captureWelcomeCustomers([customer], {
    container: x.scope,
    transactionId: "tx1",
  })
  captureWelcomeCustomers([customer], {
    container: x.scope,
    transactionId: "tx1",
  })
  x.res.json({
    customer: { email: "later@example.test", first_name: "Later" },
  })
  x.res.json({ customer: { id: customer.id } })
  expect(x.emit).toHaveBeenCalledTimes(1)
  expect(x.emit.mock.calls[0][0].data.customer).toEqual({
    id: customer.id,
    email: customer.email,
    first_name: "Original",
  })
})
it.each([400, 500])(
  "never publishes a failed outer account response %s",
  (status) => {
    const x = setup()
    captureWelcomeCustomers([customer], {
      container: x.scope,
      transactionId: "tx1",
    })
    x.res.statusCode = status
    x.res.json({ error: "auth link failed" })
    expect(x.emit).not.toHaveBeenCalled()
  }
)
it.each([
  { ...customer, has_account: false },
  { ...customer, email: null },
  { ...customer, created_at: null },
])("does not invent missing account source %#", (native) => {
  const x = setup()
  captureWelcomeCustomers([native], {
    container: x.scope,
    transactionId: "tx1",
  })
  x.res.json({ customer: { id: customer.id } })
  expect(x.emit).not.toHaveBeenCalled()
})
it("holds malformed supplied context instead of promoting it to production", () => {
  const x = setup("invalid")
  captureWelcomeCustomers([customer], {
    container: x.scope,
    transactionId: "tx1",
  })
  x.res.json({ customer: { id: customer.id } })
  expect(x.emit.mock.calls[0][0].data.lane).toBe("unavailable")
})
it("freezes the original server test lane when configuration later changes", () => {
  process.env.STRIPE_API_KEY = "sk_test_fixture"
  const x = setup()
  process.env.STRIPE_API_KEY = "sk_live_fixture"
  captureWelcomeCustomers([customer], {
    container: x.scope,
    transactionId: "tx1",
  })
  x.res.json({ customer: { id: customer.id } })
  expect(x.emit.mock.calls[0][0].data.lane).toBe("rehearsal")
})
it("keeps successful signup independent of event-bus failure", async () => {
  const x = setup()
  x.emit.mockRejectedValue(new Error("bus unavailable"))
  captureWelcomeCustomers([customer], {
    container: x.scope,
    transactionId: "tx1",
  })
  const body = { customer: { id: customer.id } }
  x.res.json(body)
  await Promise.resolve()
  expect(x.json).toHaveBeenCalledWith(body)
  expect(x.warn).toHaveBeenCalledWith(
    "[account-welcome] source notification unavailable"
  )
})
it.each([undefined, "false", "invalid"])("retains original registration evidence with flag %s", (flag) => {
  if (flag === undefined) delete process.env.GP_ACCOUNT_WELCOME_ENABLED
  else process.env.GP_ACCOUNT_WELCOME_ENABLED = flag
  const x = setup()
  captureWelcomeCustomers([customer], { container: x.scope, transactionId: "tx_paused" })
  x.res.json({ customer: { id: customer.id } })
  expect(x.emit).toHaveBeenCalledTimes(1)
  expect(x.emit.mock.calls[0][0].data.customer.email).toBe(customer.email)
  expect(x.json).toHaveBeenCalledWith({ customer: { id: customer.id } })
})
it.each([
  [undefined, false], ["", false], ["true", true], ["false", false], ["invalid", false],
] as const)("replacement delivery requires explicit activation %s => %s", (flag, enabled) => {
  if (flag === undefined) delete process.env.GP_ACCOUNT_WELCOME_ENABLED
  else process.env.GP_ACCOUNT_WELCOME_ENABLED = flag
  expect(accountWelcomeEnabled()).toBe(enabled)
})
it("validates saved source hashes and keeps recipient/name out of measurement properties", () => {
  const x = setup()
  captureWelcomeCustomers([customer], {
    container: x.scope,
    transactionId: "tx1",
  })
  const snapshot = welcomeFromResponse(
    x.scope.resolve(ACCOUNT_WELCOME_CONTEXT),
    { customer },
    at
  )!
  const row = {
    source: ACCOUNT_WELCOME_SOURCE,
    event_id: snapshot.event_id,
    event_name: snapshot.event_name,
    context: {
      account_welcome_snapshot: snapshot,
      account_welcome_hash: nativeSnapshotHash(snapshot),
    },
  }
  expect(welcomeSourceFromRow(row)).toEqual(snapshot)
  expect(JSON.stringify(welcomeMeasurementProperties(snapshot))).not.toMatch(
    /original@example|Original/
  )
  row.context.account_welcome_snapshot.customer.email = "changed@example.test"
  expect(welcomeSourceFromRow(row)).toBeNull()
})
it("refuses an unknown server key", () => {
  delete process.env.STRIPE_API_KEY
  expect(welcomeServerLane()).toBe("unavailable")
})
it.each([
  {
    original_account_source_valid: true,
    analytics_consent: false,
    test_event: false,
    analytics_environment: "production",
  },
  {
    original_account_source_valid: true,
    analytics_consent: true,
    test_event: true,
    analytics_environment: "rehearsal",
  },
  {
    original_account_source_valid: false,
    analytics_consent: true,
    test_event: false,
    analytics_environment: "production",
  },
])(
  "prevents unpermitted welcome outcomes from both destinations %#",
  async (properties) => {
    const query: any = {
      insert: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      merge: jest.fn().mockResolvedValue([]),
    }
    const db: any = jest.fn(() => query)
    db.raw = jest.fn()
    const fetch = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("must not send"))
    process.env.CLICKHOUSE_URL = "http://127.0.0.1:1"
    process.env.GA4_MEASUREMENT_ID = "fixture"
    process.env.GA4_API_SECRET = "fixture"
    const event = {
      source: "communications-account",
      event_id: "outcome",
      event_name: "email_sent",
      properties,
    }
    expect(await writeEventToGa4(db, event)).toBe(false)
    expect(await writeEventToClickHouse(db, event)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }
)
