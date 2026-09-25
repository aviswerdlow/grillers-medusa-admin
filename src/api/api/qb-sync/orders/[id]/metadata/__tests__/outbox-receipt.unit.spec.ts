import { POST } from "../route"
import { acknowledgeQbdPosting, QbdPostingConflict } from "../../../../../../../lib/qbd-posting-outbox"
jest.mock("../../../../../../../lib/qbd-posting-outbox", () => ({
  ...jest.requireActual("../../../../../../../lib/qbd-posting-outbox"), acknowledgeQbdPosting: jest.fn(),
}))
jest.mock("../../../../../../../lib/ops-alert", () => ({ emitOpsAlert: jest.fn() }))

const savedToken = process.env.QB_SYNC_ORDER_IMPORT_TOKEN
afterAll(() => { process.env.QB_SYNC_ORDER_IMPORT_TOKEN = savedToken })
beforeEach(() => { jest.resetAllMocks(); process.env.QB_SYNC_ORDER_IMPORT_TOKEN = "fixture_sync_token" })
function fixture() {
  const req: any = { params: { id: "order_test" }, headers: { "x-qb-sync-token": "fixture_sync_token" },
    body: { posting_receipt: { request_key: "refund:re_test", bridge_job_id: "7", status: "posted", transactions: [{ kind: "card_refund", txn_id: "TEST-REFUND" }] } },
    scope: { resolve: jest.fn(() => ({})) } }
  const res: any = { status: jest.fn(function () { return this }), json: jest.fn() }
  return { req, res }
}
it.each(["", "wrong_token"])("rejects an unauthenticated receipt before touching the ledger", async (token) => {
  const f = fixture(); f.req.headers["x-qb-sync-token"] = token
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(401)
  expect(acknowledgeQbdPosting).not.toHaveBeenCalled()
})
it("acknowledges the exact ledger action and its replay result", async () => {
  const f = fixture()
  ;(acknowledgeQbdPosting as jest.Mock).mockResolvedValue({ replayed: true })
  await POST(f.req, f.res)
  expect(acknowledgeQbdPosting).toHaveBeenCalledWith({}, "order_test", f.req.body.posting_receipt)
  expect(f.res.json).toHaveBeenCalledWith({ ok: true, request_key: "refund:re_test", replayed: true })
})
it.each([[new QbdPostingConflict("Wrong action"), 409], [new Error("DB unavailable"), 503]])("does not acknowledge a rejected receipt", async (error, status) => {
  const f = fixture(); (acknowledgeQbdPosting as jest.Mock).mockRejectedValue(error)
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(status)
})
it("refuses a legacy metadata acknowledgement for an outbox-managed order", async () => {
  const f = fixture()
  const orderModule = { retrieveOrder: jest.fn(async () => ({ metadata: { qbd_posting_outbox_version: 1, qbd_posting_request_key: "refund:re_test" } })), updateOrders: jest.fn() }
  f.req.scope.resolve.mockReturnValue(orderModule)
  f.req.body = { metadata: { qbd_posting_status: "posted", qbd_posting_request_key: "refund:re_test" } }
  await POST(f.req, f.res)
  expect(f.res.status).toHaveBeenCalledWith(409)
  expect(orderModule.updateOrders).not.toHaveBeenCalled()
})
