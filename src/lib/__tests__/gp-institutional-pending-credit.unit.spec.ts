import { readInstitutionalBridgeAccount } from "../gp-institutional-source"
import { institutionalCheckoutAuthority, reserveInstitutionalCheckout } from "../gp-institutional-checkout"

jest.mock("../gp-institutional-source", () => ({ readInstitutionalBridgeAccount: jest.fn() }))

const companyKey = "a".repeat(64)
const prior = {
  flag: process.env.GP_INSTITUTIONAL_TERMS_ENABLED,
  company: process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256,
}

afterAll(() => {
  if (prior.flag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = prior.flag
  if (prior.company === undefined) delete process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256
  else process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = prior.company
})

it("holds new terms while an exact QBD credit memo still needs detail readback", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = companyKey
  ;(readInstitutionalBridgeAccount as jest.Mock).mockResolvedValue({
    sourceStatus: "success",
    link: { companyKey, customerListId: "TEST_LIST_001", medusaCustomerId: "TEST_CUSTOMER", status: "verified" },
    snapshot: {
      source: "quickbooks_desktop_test_company", companyKey,
      customerListId: "TEST_LIST_001", medusaCustomerId: "TEST_CUSTOMER",
      sourceRevision: "test_rev", lastSuccess: new Date().toISOString(),
      approvalField: "Pay By Check Approval", approvalValue: "Yes", approvalVerified: true,
      creditLimitCents: 100000, termsListId: "TEST_NET10", termsName: "Net 10", onHold: false,
    },
    invoices: [{ txnId: "TEST_INVOICE_G", remainingCents: 30000 }],
    readbacks: {
      invoices: [{ invoiceTxnId: "TEST_INVOICE_G", creditTxnIds: ["TEST_CREDIT_1"] }],
      payments: [],
    },
  })
  const authority = await institutionalCheckoutAuthority("TEST_CUSTOMER")
  expect(authority.status).toBe("allow")
  if (authority.status !== "allow") throw new Error("Fixture must be otherwise eligible")
  expect(authority.account.pendingCreditTxnIds).toEqual(["TEST_CREDIT_1"])

  const raw = jest.fn(async (sql: string) => sql.includes("select order_id") ? { rows: [] } : undefined)
  const db = { transaction: async (run: (trx: { raw: typeof raw }) => Promise<unknown>) => run({ raw }) }
  const result = await reserveInstitutionalCheckout({
    db, account: authority.account, reservationId: "cart:TEST_CART_G", amountCents: 20000,
  })
  expect(result).toMatchObject({ status: "hold", reason: "qbd_reconciliation_uncertain" })
  expect(raw).not.toHaveBeenCalledWith(expect.stringContaining("insert into"), expect.anything())
})
