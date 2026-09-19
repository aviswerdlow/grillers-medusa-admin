import { GET, POST } from "../route"
import { listQbdPostings, persistQbdPosting, retryQbdPosting } from "../../../../../../../lib/qbd-posting-outbox"
import { persistQbdOrderAudit } from "../../../../../../../lib/qbd-order-metadata"
jest.mock("../../../../../../../lib/qbd-posting-outbox", () => ({
  ...jest.requireActual("../../../../../../../lib/qbd-posting-outbox"), assertQbdPostingReady: jest.fn(),
  persistQbdPosting: jest.fn(), retryQbdPosting: jest.fn(), listQbdPostings: jest.fn(),
}))
jest.mock("../../../../../../../lib/qbd-order-metadata", () => ({
  ...jest.requireActual("../../../../../../../lib/qbd-order-metadata"), persistQbdOrderAudit: jest.fn(),
  loadQbdOrder: jest.fn(async () => ({ id: "order_test", items: [], currency_code: "usd" })),
}))
beforeEach(() => {
  jest.resetAllMocks()
  const helpers = require("../../../../../../../lib/qbd-order-metadata")
  helpers.loadQbdOrder.mockResolvedValue({ id: "order_test", items: [], currency_code: "usd" })
  ;(persistQbdOrderAudit as jest.Mock).mockImplementation(async (_db, _id, build) => build({ qbd_posting_request_key: "final_charge:old", stripe_refund_status: "submitted" }))
})
function fixture() {
  const req: any = { params: { id: "order_test" }, auth_context: { actor_id: "staff_actual" }, scope: { resolve: () => ({}) }, body: {} }
  const res: any = { status: jest.fn(function () { return this }), json: jest.fn() }
  return { req, res }
}
it.each(["requested", "failed", "pending_manual"])("keeps %s frontend refund bookkeeping out of the accounting ledger", async (status) => {
  const f = fixture()
  f.req.body = { entry: { action: "refund_payment", status, staff_actor_id: "spoofed" },
    patch: { qbd_posting_required: true, qbd_posting_status: "pending_manual", qbd_posting_request_key: "frontend:duplicate", stripe_refund_status: "failed" } }
  await POST(f.req, f.res)
  expect(persistQbdPosting).not.toHaveBeenCalled()
  const response = f.res.json.mock.calls[0][0]
  expect(response.order.metadata.qbd_posting_request_key).toBe("final_charge:old")
  expect(response.order.metadata.stripe_refund_status).toBe("submitted")
  expect(JSON.parse(response.order.metadata.staff_audit_log)[0].staff_actor_id).toBe("staff_actual")
})
it("targets an explicit earlier action for accounting retry", async () => {
  const f = fixture()
  ;(retryQbdPosting as jest.Mock).mockResolvedValue({ qbd_posting_request_key: "refund:new" })
  f.req.body = { entry: { action: "retry_qbd_posting", qbd_posting_request_key: "invoice:old" } }
  await POST(f.req, f.res)
  expect(retryQbdPosting).toHaveBeenCalledWith({}, "order_test", "invoice:old", expect.any(Function))
  expect(persistQbdPosting).not.toHaveBeenCalled()
})
it("reports an unavailable ledger explicitly", async () => {
  const f = fixture(); (listQbdPostings as jest.Mock).mockRejectedValue(new Error("DB unavailable"))
  await GET(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(503)
})
