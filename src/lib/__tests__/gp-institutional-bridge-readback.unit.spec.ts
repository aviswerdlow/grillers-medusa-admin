import { parseInstitutionalBridgeReadbacks as parse } from "../gp-institutional-bridge-readback"

const companyKey = "a".repeat(64)
const invoice = {
  source: "quickbooks_desktop_test_company", company_key: companyKey,
  customer_list_id: "TEST_LIST_001", invoice_txn_id: "TEST_INVOICE_E",
  invoice_total_cents: 50000, remaining_cents: 30000,
  linked_transactions: [{ txn_type: "ReceivePayment", txn_id: "TEST_PAYMENT_1" }],
  source_revision: "test_invoice_rev", reconciliation_status: "reconciled",
}
const payment = {
  source: "quickbooks_desktop_test_company", company_key: companyKey,
  customer_list_id: "TEST_LIST_001", payment_txn_id: "TEST_PAYMENT_1",
  invoice_txn_id: "TEST_INVOICE_E", received_total_cents: 20000,
  applied_to_invoice_cents: 20000, source_revision: "test_payment_rev",
  status: "confirmed_by_invoice_readback",
}
const input = () => ({
  invoiceRows: [invoice], paymentRows: [payment], companyKey,
  customerListId: "TEST_LIST_001",
  openInvoices: [{ txnId: "TEST_INVOICE_E", remainingCents: 30000 }],
})

describe("exact QBD collection readback boundary", () => {
  it("accepts one linked payment and counts its stable TxnID once", () => {
    expect(parse(input())).toMatchObject({
      invoices: [{ invoiceTxnId: "TEST_INVOICE_E", reconciliationStatus: "reconciled" }],
      payments: [{ paymentTxnId: "TEST_PAYMENT_1", appliedCents: 20000 }],
    })
    expect(() => parse({ ...input(), paymentRows: [payment, payment] }))
      .toThrow("Duplicate payment application")
  })

  it("rejects a same-name account's different ListID and a forged unlinked payment", () => {
    expect(() => parse({ ...input(), paymentRows: [{ ...payment, customer_list_id: "TEST_LIST_999" }] }))
      .toThrow("identity mismatch")
    expect(() => parse({ ...input(), paymentRows: [{ ...payment, payment_txn_id: "TEST_OTHER" }] }))
      .toThrow("not linked")
  })

  it("rejects missing detail or an unexplained balance reduction", () => {
    expect(() => parse({ ...input(), paymentRows: [] })).toThrow("detail is missing")
    expect(() => parse({ ...input(), paymentRows: [{ ...payment, applied_to_invoice_cents: 10000 }] }))
      .toThrow("do not reconcile")
    expect(() => parse({ ...input(), invoiceRows: [] })).toThrow("no exact QBD detail")
  })

  it("holds credit-linked invoices and never confirms their payment early", () => {
    const creditInvoice = {
      ...invoice, linked_transactions: [
        ...invoice.linked_transactions,
        { txn_type: "CreditMemo", txn_id: "TEST_CREDIT_1" },
      ], reconciliation_status: "credit_pending_detail",
    }
    expect(parse({
      ...input(), invoiceRows: [creditInvoice],
      paymentRows: [{ ...payment, status: "pending_credit_detail" }],
    }).invoices[0].reconciliationStatus).toBe("credit_pending_detail")
    expect(() => parse({ ...input(), invoiceRows: [creditInvoice] }))
      .toThrow("prematurely reconciled")
  })

  it("rejects amounts beyond received money and a missing test-company detail set", () => {
    expect(() => parse({ ...input(), paymentRows: [{ ...payment, applied_to_invoice_cents: 30000 }] }))
      .toThrow("Invalid QBD payment application")
    expect(() => parse({ ...input(), invoiceRows: undefined }))
      .toThrow("incomplete")
  })
})
