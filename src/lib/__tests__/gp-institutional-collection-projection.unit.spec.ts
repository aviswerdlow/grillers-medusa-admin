import { projectInstitutionalOrderCollection as project } from "../gp-institutional-collection-projection"
import type { InstitutionalBridgeReadbacks } from "../gp-institutional-bridge-readback"

const readbacks: InstitutionalBridgeReadbacks = {
  invoices: [{
    invoiceTxnId: "TEST_INVOICE_E", totalCents: 50000, remainingCents: 30000,
    paymentTxnIds: ["TEST_PAYMENT_1"], creditTxnIds: [], sourceRevision: "test_invoice_rev",
    reconciliationStatus: "reconciled",
  }],
  payments: [{
    paymentTxnId: "TEST_PAYMENT_1", invoiceTxnId: "TEST_INVOICE_E",
    receivedTotalCents: 20000, appliedCents: 20000,
    sourceRevision: "test_payment_rev", status: "confirmed_by_invoice_readback",
  }],
}
const input = () => ({
  orderId: "TEST_ORDER_E", acceptedCents: 45000,
  invoiceTxnId: "TEST_INVOICE_E", finalCents: 50000, readbacks,
})

describe("source-backed institutional collection projection", () => {
  it("moves from accepted on terms to verified partial collection", () => {
    expect(project({ ...input(), invoiceTxnId: null, finalCents: null }))
      .toMatchObject({ status: "accepted_on_terms", confirmedCollectedCents: 0 })
    expect(project(input())).toMatchObject({
      status: "balance_verified", confirmedCollectedCents: 20000,
      verifiedRemainingCents: 30000, appliedReceiptCount: 1,
    })
  })

  it("keeps an uncollected invoice outstanding and a cancelled unposted order cancelled", () => {
    const noCollection: InstitutionalBridgeReadbacks = {
      invoices: [{ ...readbacks.invoices[0], remainingCents: 50000,
        paymentTxnIds: [], reconciliationStatus: "outstanding" }],
      payments: [],
    }
    expect(project({ ...input(), readbacks: noCollection }).status).toBe("invoice_outstanding")
    expect(project({ ...input(), invoiceTxnId: null, finalCents: null, cancelled: true }).status)
      .toBe("cancelled")
  })

  it("quarantines posted cancellation and credit pending QBD detail", () => {
    expect(project({ ...input(), cancelled: true }).status).toBe("quarantined")
    const creditPending: InstitutionalBridgeReadbacks = {
      invoices: [{ ...readbacks.invoices[0], creditTxnIds: ["TEST_CREDIT_1"],
        reconciliationStatus: "credit_pending_detail" }],
      payments: [{ ...readbacks.payments[0], status: "pending_credit_detail" }],
    }
    expect(project({ ...input(), readbacks: creditPending })).toMatchObject({
      status: "quarantined", verifiedRemainingCents: null,
    })
  })

  it("rejects a posting receipt that points to another invoice or amount", () => {
    expect(() => project({ ...input(), invoiceTxnId: "TEST_OTHER" })).toThrow("does not match")
    expect(() => project({ ...input(), finalCents: 40000 })).toThrow("does not match")
  })
})
