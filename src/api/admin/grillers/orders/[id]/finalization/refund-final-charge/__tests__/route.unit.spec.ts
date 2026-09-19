import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { POST } from "../route"
import { emitOpsAlert } from "../../../../../../../../lib/ops-alert"
import { assertQbdPostingReady, persistQbdPosting, QbdPostingConflict } from "../../../../../../../../lib/qbd-posting-outbox"
import { claimStaffRefundRequest, completeStaffRefundRequest, existingStaffRefundRequest, requireStaffRefundReconciliation } from "../../../../../../../../lib/staff-refund-request"
import { releaseAllocationLineQuantities } from "../../../../../../../../lib/inventory-allocation"

jest.mock("../../../../../../../../lib/ops-alert", () => ({ emitOpsAlert: jest.fn() }))
jest.mock("../../../../../../../../lib/inventory-allocation", () => ({ releaseAllocationLineQuantities: jest.fn() }))
jest.mock("../../../../../../../../lib/qbd-posting-outbox", () => ({
  ...jest.requireActual("../../../../../../../../lib/qbd-posting-outbox"),
  assertQbdPostingReady: jest.fn(), persistQbdPosting: jest.fn(),
}))
jest.mock("../../../../../../../../lib/staff-refund-request", () => ({
  ...jest.requireActual("../../../../../../../../lib/staff-refund-request"),
  claimStaffRefundRequest: jest.fn(), recordStaffRefundProvider: jest.fn(), existingStaffRefundRequest: jest.fn(),
  completeStaffRefundRequest: jest.fn(), requireStaffRefundReconciliation: jest.fn(),
}))

const originalFetch = global.fetch
const originalKey = process.env.STRIPE_API_KEY
beforeEach(() => {
  jest.resetAllMocks()
  process.env.STRIPE_API_KEY = "sk_test_fixture"
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ id: "re_test", status: "succeeded" }) })) as any
  ;(existingStaffRefundRequest as jest.Mock).mockResolvedValue(null)
  ;(claimStaffRefundRequest as jest.Mock).mockResolvedValue({ id: "intent_test", replay: null })
  ;(requireStaffRefundReconciliation as jest.Mock).mockResolvedValue(undefined)
  ;(persistQbdPosting as jest.Mock).mockImplementation(async ({ order, buildMetadata }) => ({ metadata: buildMetadata(order.metadata) }))
})
afterAll(() => { global.fetch = originalFetch; process.env.STRIPE_API_KEY = originalKey })

function fixture() {
  const order: any = { id: "order_test", currency_code: "usd", total: 100, items: [{ id: "line_test", quantity: 1 }],
    metadata: { final_charge_status: "succeeded", stripe_payment_intent_id: "pi_test", final_total: 100, final_charge_refunded_amount: 10 } }
  const orderModule = { listOrderTransactions: jest.fn(async () => [] as any[]), addOrderTransactions: jest.fn(), updateOrders: jest.fn() }
  const eventBus = { emit: jest.fn() }
  const db = {}
  const services: any = { [Modules.ORDER]: orderModule, [Modules.EVENT_BUS]: eventBus,
    [ContainerRegistrationKeys.QUERY]: { graph: jest.fn(async () => ({ data: [order] })) }, [ContainerRegistrationKeys.PG_CONNECTION]: db }
  const req: any = { params: { id: order.id }, headers: { "idempotency-key": "intent_test" },
    body: { amount: 12.5, note: "Synthetic test" }, auth_context: { actor_id: "staff_test" }, scope: { resolve: (key: string) => services[key] } }
  const res: any = { status: jest.fn(function () { return this }), json: jest.fn() }
  return { req, res, order, orderModule, eventBus, db }
}

it("refunds the final PaymentIntent once and queues its immutable accounting action", async () => {
  const f = fixture()
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(200)
  const init = (global.fetch as jest.Mock).mock.calls[0][1]
  expect(init.headers["Idempotency-Key"]).toBe("intent_test")
  expect(init.body.get("payment_intent")).toBe("pi_test")
  expect(init.body.get("amount")).toBe("1250")
  const posting = await (persistQbdPosting as jest.Mock).mock.results[0].value
  expect(posting.metadata).toEqual(expect.objectContaining({ final_charge_refunded_amount: 22.5,
    qbd_posting_request_key: "refund:re_test", qbd_posting_amount: 1250, stripe_refund_status: "submitted" }))
  expect(posting.metadata.final_charge_refunds).toEqual([expect.objectContaining({ id: "re_test", idempotency_key: "intent_test" })])
  expect(f.orderModule.updateOrders).not.toHaveBeenCalled()
  expect(f.orderModule.addOrderTransactions).toHaveBeenCalledWith(expect.objectContaining({ reference_id: "re_test", amount: -12.5 }))
  expect(f.eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ name: "payment.refunded" }))
  expect(completeStaffRefundRequest).toHaveBeenCalledTimes(1)
})

it("returns a durable replay even when the remaining balance is now zero", async () => {
  const f = fixture()
  f.order.metadata.final_charge_refunded_amount = 100
  ;(existingStaffRefundRequest as jest.Mock).mockResolvedValue({ id: "intent_test", replay: { payment: { refunds: [{ id: "re_test" }] } } })
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(200)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(f.eventBus.emit).not.toHaveBeenCalled()
})

it("preserves legacy confirmed-refund replay without reissuing money", async () => {
  const f = fixture()
  f.order.metadata.final_charge_refunds = [{ id: "re_old", idempotency_key: "intent_test", amount: 12.5 }]
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(200)
  expect(global.fetch).not.toHaveBeenCalled()
})

it.each([0, -1, 90.01, 1.111])("rejects an invalid amount %s before Stripe", async (amount) => {
  const f = fixture()
  f.req.body.amount = amount
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(422)
  expect(global.fetch).not.toHaveBeenCalled()
})

it.each(["missing_key", "untracked_legacy", "unresolved_attempt"])("blocks %s before Stripe", async (reason) => {
  const f = fixture()
  if (reason === "missing_key") f.req.headers = {}
  if (reason === "untracked_legacy") (assertQbdPostingReady as jest.Mock).mockRejectedValue(new QbdPostingConflict("Legacy request needs reconciliation"))
  if (reason === "unresolved_attempt") (existingStaffRefundRequest as jest.Mock).mockRejectedValue(new QbdPostingConflict("Refund needs reconciliation"))
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(409)
  expect(global.fetch).not.toHaveBeenCalled()
})

it("retains an uncertain provider attempt for reconciliation", async () => {
  const f = fixture()
  ;(global.fetch as jest.Mock).mockRejectedValue(new Error("Provider timeout"))
  await POST(f.req, f.res)
  expect(requireStaffRefundReconciliation).toHaveBeenCalledWith(f.db, "intent_test")
  expect(persistQbdPosting).not.toHaveBeenCalled()
  expect(f.res.json).toHaveBeenCalledWith({ message: expect.stringContaining("Do not submit another refund") })
})

it("retains the provider receipt and pages when Medusa recording fails", async () => {
  const f = fixture()
  ;(persistQbdPosting as jest.Mock).mockRejectedValue(new Error("DB unavailable"))
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(500)
  expect(completeStaffRefundRequest).not.toHaveBeenCalled()
  expect(requireStaffRefundReconciliation).toHaveBeenCalledWith(f.db, "intent_test")
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ alertKind: "refund_recorded_mismatch", meta: expect.objectContaining({ stripe_refund_id: "re_test" }) }))
})

it("does not duplicate an existing order transaction and releases only explicit lines", async () => {
  const f = fixture()
  f.orderModule.listOrderTransactions.mockResolvedValue([{ id: "transaction_test" }])
  f.req.body.allocation_releases = [{ order_id: f.order.id, line_item_id: "line_test", quantity: 1 }]
  await POST(f.req, f.res)
  expect(f.orderModule.addOrderTransactions).not.toHaveBeenCalled()
  expect(releaseAllocationLineQuantities).toHaveBeenCalledWith(expect.objectContaining({ orderId: f.order.id, lines: [{ line_item_id: "line_test", quantity: 1 }] }))
})

it("does not release another order's allocation or refund an order without a successful final charge", async () => {
  const f = fixture()
  f.req.body.allocation_releases = [{ order_id: "another_order", line_item_id: "line_test", quantity: 1 }]
  await POST(f.req, f.res)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(f.res.status).toHaveBeenCalledWith(422)
  f.req.body.allocation_releases = []
  f.order.metadata.final_charge_status = "failed"
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(409)
  expect(global.fetch).not.toHaveBeenCalled()
})
