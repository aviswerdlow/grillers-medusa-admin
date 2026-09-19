import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { POST } from "../[id]/refund/route"
import { config as refundIssuedEmailConfig } from "../../../../../subscribers/refund-issued-email"
import { emitOpsAlert } from "../../../../../lib/ops-alert"
import { assertQbdPostingReady, persistQbdPosting, QbdPostingConflict } from "../../../../../lib/qbd-posting-outbox"
import { claimStaffRefundRequest, completeStaffRefundRequest, requireStaffRefundReconciliation } from "../../../../../lib/staff-refund-request"
import { releaseAllocationLineQuantities } from "../../../../../lib/inventory-allocation"

jest.mock("../../../../../lib/ops-alert", () => ({ emitOpsAlert: jest.fn() }))
jest.mock("../../../../../lib/inventory-allocation", () => ({ releaseAllocationLineQuantities: jest.fn() }))
jest.mock("../../../../../lib/qbd-posting-outbox", () => ({
  ...jest.requireActual("../../../../../lib/qbd-posting-outbox"),
  assertQbdPostingReady: jest.fn(), persistQbdPosting: jest.fn(),
}))
jest.mock("../../../../../lib/staff-refund-request", () => ({
  ...jest.requireActual("../../../../../lib/staff-refund-request"),
  claimStaffRefundRequest: jest.fn(), recordStaffRefundProvider: jest.fn(),
  completeStaffRefundRequest: jest.fn(), requireStaffRefundReconciliation: jest.fn(),
}))

function fixture() {
  const refund = { id: "refund_test", amount: 5, raw_amount: { value: "5" }, data: { id: "re_test" } }
  const paymentModule = {
    retrievePayment: jest.fn(async () => ({ id: "pay_test", payment_collection_id: "pc_test", currency_code: "usd", refunds: [] })),
    refundPayment: jest.fn(async () => ({ id: "pay_test", currency_code: "usd", refunds: [refund] })),
  }
  const orderModule = { listOrderTransactions: jest.fn(async () => [] as any[]), addOrderTransactions: jest.fn(), updateOrders: jest.fn() }
  const order = { id: "order_test", currency_code: "usd", items: [{ id: "line_test", quantity: 1 }], metadata: { qbd_existing: "kept" } }
  const query = { graph: jest.fn(async ({ entity }: any) => ({ data: entity === "order" ? [order] : [{ order_id: order.id }] })) }
  const eventBus = { emit: jest.fn() }
  const db = {}
  const services: any = { [Modules.PAYMENT]: paymentModule, [Modules.ORDER]: orderModule,
    [Modules.EVENT_BUS]: eventBus, [ContainerRegistrationKeys.QUERY]: query, [ContainerRegistrationKeys.PG_CONNECTION]: db }
  const req: any = { params: { id: "pay_test" }, headers: { "idempotency-key": "intent_test" },
    body: { amount: 5, note: "Synthetic test" }, auth_context: { actor_id: "staff_test" }, scope: { resolve: (key: string) => services[key] } }
  const res: any = { status: jest.fn(function () { return this }), json: jest.fn() }
  return { req, res, refund, paymentModule, orderModule, query, eventBus, order, db }
}

beforeEach(() => {
  jest.resetAllMocks()
  ;(assertQbdPostingReady as jest.Mock).mockResolvedValue(undefined)
  ;(claimStaffRefundRequest as jest.Mock).mockResolvedValue({ id: "intent_test", replay: null })
  ;(requireStaffRefundReconciliation as jest.Mock).mockResolvedValue(undefined)
  ;(persistQbdPosting as jest.Mock).mockImplementation(async ({ order, buildMetadata }) => ({ metadata: buildMetadata(order.metadata) }))
})

it("emits the refund event and durably records the backend refund identity", async () => {
  const f = fixture()
  await POST(f.req, f.res)
  expect(refundIssuedEmailConfig.event).toBe("payment.refunded")
  expect(f.res.status).toHaveBeenCalledWith(200)
  expect(f.paymentModule.refundPayment).toHaveBeenCalledTimes(1)
  const posting = await (persistQbdPosting as jest.Mock).mock.results[0].value
  expect(posting.metadata).toEqual(expect.objectContaining({ qbd_existing: "kept", qbd_posting_request_key: "refund:refund_test",
    qbd_posting_action: "card_refund_accounting_record", qbd_posting_amount: 500, stripe_provider_refund_id: "re_test", stripe_refund_status: "submitted" }))
  expect(f.orderModule.updateOrders).not.toHaveBeenCalled()
  expect(f.orderModule.addOrderTransactions).toHaveBeenCalledWith(expect.objectContaining({ reference_id: "refund_test", amount: -5 }))
  expect(f.eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ name: "payment.refunded", data: expect.objectContaining({ refund_id: "refund_test", order_id: "order_test" }) }))
  expect(completeStaffRefundRequest).toHaveBeenCalledTimes(1)
})

it("returns a confirmed replay without refunding, emitting or releasing inventory again", async () => {
  const f = fixture()
  ;(claimStaffRefundRequest as jest.Mock).mockResolvedValue({ id: "intent_test", replay: { payment: { refunds: [f.refund] } } })
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(200)
  expect(f.paymentModule.refundPayment).not.toHaveBeenCalled()
  expect(f.eventBus.emit).not.toHaveBeenCalled()
  expect(releaseAllocationLineQuantities).not.toHaveBeenCalled()
})

it.each(["missing_key", "untracked_legacy", "unresolved_attempt"])("blocks %s before calling the provider", async (reason) => {
  const f = fixture()
  if (reason === "missing_key") f.req.headers = {}
  if (reason === "untracked_legacy") (assertQbdPostingReady as jest.Mock).mockRejectedValue(new QbdPostingConflict("Legacy request needs reconciliation"))
  if (reason === "unresolved_attempt") (claimStaffRefundRequest as jest.Mock).mockRejectedValue(new QbdPostingConflict("Refund needs reconciliation"))
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(409)
  expect(f.paymentModule.refundPayment).not.toHaveBeenCalled()
})

it("keeps a provider timeout blocked and tells staff not to refund again", async () => {
  const f = fixture()
  f.paymentModule.refundPayment.mockRejectedValue(new Error("Provider timeout") as never)
  await POST(f.req, f.res)
  expect(requireStaffRefundReconciliation).toHaveBeenCalledWith(f.db, "intent_test")
  expect(f.res.status).toHaveBeenCalledWith(500)
  expect(f.res.json).toHaveBeenCalledWith({ message: expect.stringContaining("Do not submit another refund") })
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ stage: "refund_payment", refund_completed: false }) }))
})

it("pages and retains reconciliation when accounting fails after a confirmed refund", async () => {
  const f = fixture()
  ;(persistQbdPosting as jest.Mock).mockRejectedValue(new Error("DB unavailable"))
  await POST(f.req, f.res)
  expect(requireStaffRefundReconciliation).toHaveBeenCalledWith(f.db, "intent_test")
  expect(completeStaffRefundRequest).not.toHaveBeenCalled()
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ refund_id: "refund_test", refund_completed: true }) }))
})

it("releases only explicitly submitted quantities from the refunded order", async () => {
  const f = fixture()
  f.req.body.allocation_releases = [{ order_id: "order_test", line_item_id: "line_test", quantity: 1 }]
  await POST(f.req, f.res)
  expect(releaseAllocationLineQuantities).toHaveBeenCalledWith(expect.objectContaining({ orderId: "order_test", lines: [{ line_item_id: "line_test", quantity: 1 }] }))
})

it("rejects allocation releases for another order before refunding", async () => {
  const f = fixture()
  f.req.body.allocation_releases = [{ order_id: "another_order", line_item_id: "line_test", quantity: 1 }]
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(400)
  expect(f.paymentModule.refundPayment).not.toHaveBeenCalled()
})
