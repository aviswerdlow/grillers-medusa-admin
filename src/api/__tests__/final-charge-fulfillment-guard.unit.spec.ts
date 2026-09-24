import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import middlewares, { blockFulfillmentBeforeFinalCharge, blockFulfillmentOnSlackHold } from "../middlewares"
import { bindFulfillmentAudit } from "../middlewares/staff-capabilities"
import {
  PAYMENT_WORKFLOW_INVOICE_AR,
  PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE,
} from "../../lib/catch-weight-finalization"
import { emitOpsAlert } from "../../lib/ops-alert"

jest.mock("../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn().mockResolvedValue({ ok: true }),
}))

const orderId = "order_guard_fixture"
const paidOrder = {
  id: orderId,
  metadata: {
    payment_workflow: PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE,
    final_charge_status: "succeeded",
  },
}
const routes = [
  { matcher: "/admin/orders/:id/fulfillments", params: { id: orderId }, body: {} },
  {
    matcher: "/admin/orders/:id/fulfillments/*/shipments",
    params: { id: orderId },
    body: {},
  },
  { matcher: "/admin/fulfillments", params: {}, body: { order_id: orderId } },
]

function harness(route: (typeof routes)[number], rows: unknown[] = [paidOrder]) {
  const graph = jest.fn().mockResolvedValue({ data: rows })
  const finalizations = [{ status: "released_to_fulfillment", final_order_total: "500.00" }]
  const commitments = [{ company_key: "TEST_COMPANY", customer_list_id: "TEST_LIST", amount_cents: "50000", state: "accepted" }]
  const db = jest.fn((table: string) => ({
    where: () => ({ whereNull: async () => table === "gp_order_finalization" ? finalizations : commitments }),
  }))
  const logger = { warn: jest.fn(), error: jest.fn() }
  const req = {
    params: route.params,
    body: { ...route.body },
    gp_staff_principal: { id: "cus_fulfillment_fixture", kind: "customer", email: "staff@example.invalid", name: "Synthetic staff" },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.QUERY) return { graph }
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        throw new Error("Unexpected dependency")
      },
    },
  } as any
  const res = { status: jest.fn(), json: jest.fn() } as any
  res.status.mockReturnValue(res)
  // This is the side-effect boundary: the registered chain must never reach
  // the fulfillment/shipment handler for a blocked request.
  const createFulfillmentOrShipment = jest.fn()
  const registered = middlewares.routes?.find((entry) => entry.matcher === route.matcher)
  const handlers = registered?.middlewares
  expect(registered).toBeDefined()
  if (!handlers) throw new Error(`Missing fulfillment middleware for ${route.matcher}`)
  expect(registered!.methods).toContain("POST")
  // Staff attribution only decorates the request. Both fulfillment guards
  // must still execute in order before the side-effecting native handler.
  expect(handlers).toEqual([
    bindFulfillmentAudit,
    blockFulfillmentBeforeFinalCharge,
    blockFulfillmentOnSlackHold,
  ])

  const run = async () => {
    const chain = [...handlers, createFulfillmentOrShipment]
    const dispatch = async (index: number): Promise<void> => {
      if (index >= chain.length) return
      await (chain[index] as any)(req, res, () => dispatch(index + 1))
    }
    await dispatch(0)
  }
  return { req, res, graph, db, logger, createFulfillmentOrShipment, run }
}

const priorInstitutionalFlag = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
})
afterAll(() => {
  if (priorInstitutionalFlag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = priorInstitutionalFlag
})

const releasedInvoice = {
  id: orderId,
  cart_id: "cart_guard_fixture",
  metadata: {
    payment_workflow: PAYMENT_WORKFLOW_INVOICE_AR,
    gp_institutional_commitment_id: "cart:cart_guard_fixture",
    finalization_status: "released_to_fulfillment",
    fulfillment_gate_status: "released",
    qbd_posting_action: "invoice_ar_accounting_record",
    qbd_posting_request_key: `invoice_ar:${orderId}`,
    qbd_posting_status: "pending_manual",
    qbd_posting_amount: 50000,
  },
}

describe.each(routes)("institutional invoice gate on $matcher", (route) => {
  beforeEach(() => { process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true" })

  it("allows a release only when the order, finalization and credit row agree", async () => {
    const h = harness(route, [releasedInvoice])
    await h.run()
    expect(h.createFulfillmentOrShipment).toHaveBeenCalledTimes(1)
    expect(h.db).toHaveBeenCalledWith("gp_order_finalization")
    expect(h.db).toHaveBeenCalledWith("gp_institutional_credit_commitment")
  })

  it("blocks a forged metadata release with no durable credit row", async () => {
    const h = harness(route, [releasedInvoice])
    h.db.mockImplementation((table: string) => ({
      where: () => ({ whereNull: async () => table === "gp_order_finalization"
        ? [{ status: "released_to_fulfillment", final_order_total: "500.00" }] : [] }),
    }))
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(409)
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })

  it("blocks a packed total that exceeds its durable commitment", async () => {
    const h = harness(route, [releasedInvoice])
    h.db.mockImplementation((table: string) => ({
      where: () => ({ whereNull: async () => table === "gp_order_finalization"
        ? [{ status: "released_to_fulfillment", final_order_total: "501.00" }]
        : [{ company_key: "TEST_COMPANY", customer_list_id: "TEST_LIST", amount_cents: "50000", state: "accepted" }] }),
    }))
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(409)
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })

  it("holds a failed QBD posting without reading the ledger", async () => {
    const h = harness(route, [{
      ...releasedInvoice,
      metadata: { ...releasedInvoice.metadata, qbd_posting_status: "failed" },
    }])
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(409)
    expect(h.db).not.toHaveBeenCalled()
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })

  it("fails closed when the ledger read is unavailable", async () => {
    const h = harness(route, [releasedInvoice])
    h.db.mockImplementation(() => { throw new Error("ledger unavailable") })
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(503)
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })
})

describe.each(routes)("final-charge gate on $matcher", (route) => {
  it("blocks repeated lookup failures and pages without reaching the handler", async () => {
    const h = harness(route)
    h.graph.mockRejectedValue(new Error("database unavailable"))

    await h.run()
    await h.run()

    expect(h.res.status).toHaveBeenNthCalledWith(1, 503)
    expect(h.res.status).toHaveBeenNthCalledWith(2, 503)
    expect(h.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment_verification_unavailable", retryable: true })
    )
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ alertKind: "mw_fulfillment_gate_failed", severity: "page" })
    )
  })

  it.each([
    { state: "missing order", rows: [] },
    { state: "different order", rows: [{ ...paidOrder, id: "order_other" }] },
    { state: "missing metadata", rows: [{ id: orderId }] },
    { state: "malformed metadata", rows: [{ id: orderId, metadata: "unavailable" }] },
    { state: "array metadata", rows: [{ id: orderId, metadata: [] }] },
    { state: "scalar JSON metadata", rows: [{ id: orderId, metadata: "42" }] },
  ])("blocks $state without reaching the handler", async ({ rows }) => {
    const h = harness(route, rows)
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(503)
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })

  it("blocks an unpaid card order even if the request claims payment succeeded", async () => {
    const h = harness(route, [{
      id: orderId,
      metadata: { payment_workflow: PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE },
    }])
    h.req.body = { ...h.req.body, metadata: paidOrder.metadata }
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(409)
    expect(h.res.json).toHaveBeenCalledWith(expect.objectContaining({ type: "payment_required" }))
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })

  it.each([
    { state: "paid card order", order: paidOrder },
    { state: "paid order with serialized metadata", order: {
      ...paidOrder, metadata: JSON.stringify(paidOrder.metadata),
    } },
    { state: "approved invoice workflow", order: {
      id: orderId,
      metadata: { payment_workflow: PAYMENT_WORKFLOW_INVOICE_AR },
    } },
    { state: "known legacy order with null metadata", order: { id: orderId, metadata: null } },
  ])("preserves $state", async ({ order }) => {
    const h = harness(route, [order])
    await h.run()
    expect(h.res.status).not.toHaveBeenCalled()
    expect(h.createFulfillmentOrShipment).toHaveBeenCalledTimes(1)
    expect(h.req.body.metadata).toMatchObject({ staff_actor_customer_id: "cus_fulfillment_fixture" })
      expect(h.graph).toHaveBeenCalledWith({
      entity: "order", fields: ["id", "cart_id", "metadata"], filters: { id: orderId },
    })
  })

  it("allows a retry only after the stored payment state can be verified", async () => {
    const h = harness(route)
    h.graph.mockRejectedValueOnce(new Error("transient lookup failure"))
    await h.run()
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
    await h.run()
    expect(h.res.status).toHaveBeenCalledTimes(1)
    expect(h.createFulfillmentOrShipment).toHaveBeenCalledTimes(1)
  })

  it("blocks serialized unpaid-card metadata", async () => {
    const h = harness(route, [{
      id: orderId,
      metadata: JSON.stringify({ payment_workflow: PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE }),
    }])
    await h.run()
    expect(h.res.status).toHaveBeenCalledWith(409)
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })
})

describe("fulfillment order identity", () => {
  it.each([undefined, "", "   ", 42, [orderId], {}])(
    "rejects a missing or malformed ID (%j) before querying or creating anything",
    async (id) => {
      const h = harness(routes[2])
      h.req.body = { order_id: id }
      await h.run()
      expect(h.res.status).toHaveBeenCalledWith(400)
      expect(h.res.json).toHaveBeenCalledWith(expect.objectContaining({ type: "invalid_request" }))
      expect(h.graph).not.toHaveBeenCalled()
      expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
    }
  )

  it("verifies a nested order ID against the stored order", async () => {
    const h = harness(routes[2])
    h.req.body = { order: { id: orderId } }
    await h.run()
    expect(h.graph).toHaveBeenCalledWith(expect.objectContaining({ filters: { id: orderId } }))
    expect(h.createFulfillmentOrShipment).toHaveBeenCalledTimes(1)
  })

  it("does not let a paid body order override an unpaid route order", async () => {
    const h = harness(routes[0], [{
      id: orderId,
      metadata: { payment_workflow: PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE },
    }])
    h.req.body = { order_id: "order_other" }
    await h.run()
    expect(h.graph).toHaveBeenCalledWith(expect.objectContaining({ filters: { id: orderId } }))
    expect(h.createFulfillmentOrShipment).not.toHaveBeenCalled()
  })
})
