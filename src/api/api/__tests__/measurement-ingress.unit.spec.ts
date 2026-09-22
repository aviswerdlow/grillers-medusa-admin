import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  recordCommunicationEvent,
  recordIdentity,
  upsertCustomerProfile,
} from "../../../lib/communications/core"
import { emitOpsAlert } from "../../../lib/ops-alert"
import { classifyMeasurement } from "../_shared/measurement-ingress"
import * as track from "../track/route"
import * as batch from "../batch/route"
import * as identify from "../identify/route"

jest.mock("../../../lib/communications/core", () => ({
  ...jest.requireActual("../../../lib/communications/core"),
  recordCommunicationEvent: jest.fn(async (_db, event) => event),
  recordIdentity: jest.fn(),
  upsertCustomerProfile: jest.fn(async () => ({ id: "profile_fixture" })),
}))
jest.mock("../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true })),
}))

const originalEnv = { ...process.env }
const now = 1789940000000
function event(name = "product_viewed", index = 1): any {
  return {
    event_type: name,
    eventn_ctx: {
      event_id: `00000000-0000-4000-8000-00000000000${index}`,
      event_timestamp_ms: now,
      anonymous_id: "visitor_fixture",
      session_id: "session_fixture",
      analytics_consent: true,
      analytics_consent_at: now - 1000,
      analytics_environment: "production",
      test_event: false,
      marketing_consent: false,
      product_id: "product_fixture",
      experiment_context: {
        shipping: {
          variant_key: "control",
          version: "v1",
          assignment_id: "assignment_fixture",
        },
      },
    },
  }
}

function request(body: any) {
  return {
    body,
    headers: {
      "x-api-key": "public-fixture",
      origin: "https://grillerspride.com",
    },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return "db-fixture"
        return { warn: jest.fn(), error: jest.fn() }
      }),
    },
  } as any
}
function response() {
  const res: any = {
    code: 0,
    body: null,
    headers: {},
    status(code: number) {
      this.code = code
      return this
    },
    json(body: any) {
      this.body = body
      return this
    },
    send(body: any) {
      this.body = body
      return this
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value
      return this
    },
  }
  return res
}
const routes = { track, batch, identify }
function bodyFor(route: keyof typeof routes) {
  return route === "batch"
    ? { events: [event()] }
    : event(route === "identify" ? "identify" : "product_viewed")
}
function contextFor(route: keyof typeof routes, body: any) {
  return route === "batch" ? body.events[0].eventn_ctx : body.eventn_ctx
}
function noWritesOrAlerts() {
  expect(recordCommunicationEvent).not.toHaveBeenCalled()
  expect(upsertCustomerProfile).not.toHaveBeenCalled()
  expect(recordIdentity).not.toHaveBeenCalled()
  expect(emitOpsAlert).not.toHaveBeenCalled()
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    STRIPE_API_KEY: "sk_live_fixture",
    COMMUNICATIONS_PUBLIC_API_KEY: "public-fixture",
    COMMUNICATIONS_API_KEY: "",
    NEWSLETTER_API_KEY: "",
    STORE_CORS: "",
    COMMUNICATIONS_CORS: "",
    STOREFRONT_URL: "https://grillerspride.com",
    NEXT_PUBLIC_BASE_URL: "https://grillerspride.com",
  }
  jest.clearAllMocks()
})
afterEach(() => {
  process.env = { ...originalEnv }
})

describe.each(Object.keys(routes) as Array<keyof typeof routes>)(
  "%s measurement receiver",
  (route) => {
    it("accepts the production browser envelope with its original ID/time/context", async () => {
      const body = bodyFor(route)
      const ctx = contextFor(route, body)
      const res = response()
      await routes[route].POST(request(body), res)
      expect(res.code).toBe(202)
      expect(recordCommunicationEvent).toHaveBeenCalledTimes(1)
      expect(recordCommunicationEvent).toHaveBeenCalledWith(
        "db-fixture",
        expect.objectContaining({
          event_id: ctx.event_id,
          occurred_at: new Date(now),
          source: "storefront",
          properties: expect.objectContaining({
            analytics_consent: true,
            analytics_environment: "production",
            test_event: false,
            marketing_consent: false,
            experiment_context: ctx.experiment_context,
          }),
        })
      )
    })

    it("excludes a test server even when the caller claims production", async () => {
      process.env.STRIPE_API_KEY = "sk_test_fixture"
      const res = response()
      await routes[route].POST(request(bodyFor(route)), res)
      expect(res.code).toBe(202)
      expect(res.body.accepted).toBe(0)
      noWritesOrAlerts()
    })

    it.each(["test_event", "test_order", "rehearsal", "contradiction"])(
      "excludes declared test traffic (%s) before side effects",
      async (marker) => {
        const body = bodyFor(route)
        const ctx = contextFor(route, body)
        if (marker === "rehearsal") ctx.rehearsal_id = "launch-test"
        else if (marker === "contradiction") {
          const member = route === "batch" ? body.events[0] : body
          member.properties = {
            test_event: true,
            analytics_environment: "rehearsal",
          }
        } else ctx[marker] = true
        const res = response()
        await routes[route].POST(request(body), res)
        expect(res.code).toBe(202)
        expect(res.body.accepted).toBe(0)
        noWritesOrAlerts()
      }
    )

    it("refuses unknown server mode without claiming ingestion", async () => {
      process.env.STRIPE_API_KEY = ""
      const res = response()
      await routes[route].POST(request(bodyFor(route)), res)
      expect(res.code).toBe(503)
      noWritesOrAlerts()
    })

    it("ignores denied consent and refuses unknown consent", async () => {
      const body = bodyFor(route)
      const ctx = contextFor(route, body)
      ctx.analytics_consent = false
      const denied = response()
      await routes[route].POST(request(body), denied)
      expect(denied.code).toBe(202)
      noWritesOrAlerts()
      delete ctx.analytics_consent
      const unknown = response()
      await routes[route].POST(request(body), unknown)
      expect(unknown.code).toBe(422)
      noWritesOrAlerts()
    })

    it.each(["missing_config", "wrong_key"])(
      "requires a configured valid key (%s)",
      async (scenario) => {
        if (scenario === "missing_config")
          process.env.COMMUNICATIONS_PUBLIC_API_KEY = ""
        const req = request(bodyFor(route))
        if (scenario === "wrong_key") req.headers["x-api-key"] = "wrong-key"
        const res = response()
        await routes[route].POST(req, res)
        expect(res.code).toBe(401)
        noWritesOrAlerts()
      }
    )

    it("shares origin validation and preflight behavior", async () => {
      const req = request(bodyFor(route))
      req.headers.origin = "https://untrusted.example"
      const denied = response()
      await routes[route].POST(req, denied)
      expect(denied.code).toBe(403)
      noWritesOrAlerts()
      req.headers.origin = "https://grillerspride.com"
      const options = response()
      await routes[route].OPTIONS(req, options)
      expect(options.code).toBe(204)
      expect(options.headers["Access-Control-Allow-Origin"]).toBe(
        "https://grillerspride.com"
      )
    })
  }
)

it.each([
  "order_completed",
  "purchase",
  "order_refund_updated",
  "shipment_created",
  "customer_created",
  "email_sent",
  "gp_cart_expired",
])("refuses public native/derived event %s", async (name) => {
  const res = response()
  await track.POST(request(event(name)), res)
  expect(res.code).toBe(400)
  noWritesOrAlerts()
})

it("prevalidates an entire batch before accepting any member", async () => {
  const res = response()
  await batch.POST(
    request({ events: [event(), event("order_completed", 2)] }),
    res
  )
  expect(res.code).toBe(400)
  noWritesOrAlerts()
})

it("counts ignored members without buffering or blocking permitted events", async () => {
  const denied = event("cart_viewed", 2)
  denied.eventn_ctx.analytics_consent = false
  const res = response()
  await batch.POST(request({ events: [event(), denied] }), res)
  expect(res.body).toEqual({ ok: true, accepted: 1, ignored: 1 })
  expect(recordCommunicationEvent).toHaveBeenCalledTimes(1)
})

it.each([
  { test_event: true },
  { eventn_ctx: { analytics_environment: "rehearsal" } },
  { context: { analytics_consent: false } },
])(
  "honors a batch-level exclusion before accepting production members (%j)",
  async (marker) => {
    const res = response()
    await batch.POST(request({ ...marker, events: [event()] }), res)
    expect(res.body).toEqual({ ok: true, accepted: 0, ignored: 1 })
    noWritesOrAlerts()
  }
)

it("does not borrow missing member consent or classification from the batch wrapper", async () => {
  const member = event()
  delete member.eventn_ctx.analytics_consent
  const res = response()
  await batch.POST(request({ ...event(), events: [member] }), res)
  expect(res.code).toBe(422)
  noWritesOrAlerts()
})

it("cannot use public fields to choose native owners or override transport context", async () => {
  const body = event()
  Object.assign(body, {
    source: "medusa-server",
    profile_id: "victim_profile",
    customer_id: "victim_customer",
    order_id: "victim_order",
    flow_id: "victim_flow",
    template_key: "victim_template",
  })
  Object.assign(body.eventn_ctx, {
    source: "medusa-server",
    user_id: "victim_customer",
    user: { id: "victim_customer", email: "fixture@example.test" },
    profile_id: "victim_profile",
    order_id: "victim_order",
    sms_consent: true,
    email_consent: true,
  })
  const res = response()
  await track.POST(request(body), res)
  expect(res.code).toBe(202)
  const recorded = (recordCommunicationEvent as jest.Mock).mock.calls[0][1]
  expect(recorded.source).toBe("storefront")
  expect(recorded.email).toBe("fixture@example.test")
  for (const key of [
    "profile_id",
    "medusa_customer_id",
    "order_id",
    "flow_id",
    "template_key",
  ])
    expect(recorded).not.toHaveProperty(key)
  for (const key of [
    "profile_id",
    "user",
    "user_id",
    "order_id",
    "sms_consent",
    "email_consent",
  ])
    expect(recorded.properties).not.toHaveProperty(key)
  expect(JSON.stringify(recorded)).not.toContain("victim_")
})

it.each([
  "server_id",
  "id_conflict",
  "missing_time",
  "before_consent",
  "time_conflict",
  "consent_time_conflict",
  "unknown_lane",
])("refuses ambiguous measurement evidence (%s)", (scenario) => {
  const body = event()
  const ctx = body.eventn_ctx
  if (scenario === "server_id")
    ctx.event_id = "order.placed:order_fixture:order_completed"
  if (scenario === "id_conflict")
    body.event_id = "00000000-0000-4000-8000-000000000002"
  if (scenario === "missing_time") delete ctx.event_timestamp_ms
  if (scenario === "before_consent") ctx.event_timestamp_ms = now - 2000
  if (scenario === "time_conflict") body.event_timestamp_ms = now + 1
  if (scenario === "consent_time_conflict")
    body.analytics_consent_at = now - 2000
  if (scenario === "unknown_lane") delete ctx.analytics_environment
  expect(classifyMeasurement(body)).toMatchObject({
    status: "rejected",
    httpStatus: 422,
  })
})
