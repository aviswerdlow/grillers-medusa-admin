import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { GET } from "../../api/admin/grillers/orders/[id]/institutional-collection/route"
import { readInstitutionalBridgeAccount } from "../gp-institutional-source"
import { adminRouteCapability } from "../staff-route-capabilities"

jest.mock("../gp-institutional-source", () => ({ readInstitutionalBridgeAccount: jest.fn() }))

const companyKey = "a".repeat(64)
const previous = {
  flag: process.env.GP_INSTITUTIONAL_TERMS_ENABLED,
  company: process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256,
}

afterAll(() => {
  if (previous.flag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = previous.flag
  if (previous.company === undefined) delete process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256
  else process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = previous.company
})

function request(invoiceTxnId = "TEST_INVOICE_E") {
  const order = {
    id: "TEST_ORDER_E", customer_id: "medusa_institution_01",
    metadata: {
      payment_workflow: "invoice_ar", gp_institutional_commitment_id: "TEST_CART_E",
      qbd_posting_status: "posted", qbd_txn_id: invoiceTxnId, qbd_posting_amount: 50000,
    },
  }
  const query = {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockResolvedValue([{ amount_cents: "45000", state: "posted" }]),
  }
  const db = jest.fn(() => query)
  const orderModule = { retrieveOrder: jest.fn(async () => order) }
  const req = {
    params: { id: "TEST_ORDER_E" },
    scope: { resolve: jest.fn((key) => {
      if (key === Modules.ORDER) return orderModule
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      throw new Error("Unexpected scope key")
    }) },
  } as any
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
  return { req, res, db, orderModule }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = companyKey
  ;(readInstitutionalBridgeAccount as jest.Mock).mockResolvedValue({
    sourceStatus: "success",
    link: { companyKey, customerListId: "TEST_LIST_001", medusaCustomerId: "medusa_institution_01", status: "verified" },
    snapshot: { customerListId: "TEST_LIST_001", sourceRevision: "test_account_rev", lastSuccess: new Date().toISOString() },
    readbacks: {
      invoices: [{
        invoiceTxnId: "TEST_INVOICE_E", totalCents: 50000, remainingCents: 30000,
        paymentTxnIds: ["TEST_PAYMENT_1"], creditTxnIds: [], sourceRevision: "test_invoice_rev",
        reconciliationStatus: "reconciled",
      }],
      payments: [{
        paymentTxnId: "TEST_PAYMENT_1", invoiceTxnId: "TEST_INVOICE_E", receivedTotalCents: 20000,
        appliedCents: 20000, sourceRevision: "test_payment_rev", status: "confirmed_by_invoice_readback",
      }],
    },
  })
})

it("stays off by default without an order or bridge read", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const { req, res } = request()
  await GET(req, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith({ status: "disabled" })
  expect(req.scope.resolve).not.toHaveBeenCalled()
})

it("shows staff one exact posted invoice's verified partial collection", async () => {
  const { req, res, db } = request()
  await GET(req, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    status: "balance_verified", invoiceTxnId: "TEST_INVOICE_E",
    collection: expect.objectContaining({ confirmedCollectedCents: 20000, verifiedRemainingCents: 30000 }),
  }))
  expect(db).toHaveBeenCalledWith("gp_institutional_credit_commitment")
  expect(adminRouteCapability("/admin/grillers/orders/TEST_ORDER_E/institutional-collection", "GET"))
    .toBe("orders.read")
  expect(adminRouteCapability("/admin/grillers/orders/TEST_ORDER_E/institutional-collection", "POST"))
    .toBeNull()
})

it("does not join a posting receipt to another invoice or default its collection to zero", async () => {
  const { req, res } = request("TEST_OTHER_INVOICE")
  await GET(req, res)
  expect(res.status).toHaveBeenCalledWith(503)
  expect(res.json).toHaveBeenCalledWith({ status: "collection_unavailable" })
})
