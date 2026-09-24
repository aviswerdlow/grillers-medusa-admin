import {
  acceptedInstitutionalOrder,
  applyInstitutionalCollectionEvent as apply,
  institutionalCollectionView as view,
} from "../gp-institutional-collections"

describe("institutional collections (#370 synthetic fixtures)", () => {
  const invoice = { type: "invoice_posted" as const, eventId: "TEST_POST_E", invoiceTxnId: "TEST_INVOICE_E", finalCents: 50000, sourceRevision: "TEST_REV_1" }

  it("tracks accepted terms, posted invoice, pending collection and reconciliation", () => {
    let state = acceptedInstitutionalOrder("TEST_ORDER_E", 45000)
    expect(view(state).status).toBe("accepted_on_terms")
    state = apply(state, invoice)
    expect(view(state)).toMatchObject({ status: "invoice_outstanding", expectedRemainingCents: 50000 })
    state = apply(state, { type: "collection_requested", eventId: "TEST_REQUEST_EVENT_1", requestKey: "TEST_REQUEST_1", amountCents: 20000 })
    expect(view(state)).toMatchObject({ status: "collection_pending", confirmedCollectedCents: 0 })
    state = apply(state, { type: "collection_confirmed", eventId: "TEST_RECEIPT_EVENT_1", requestKey: "TEST_REQUEST_1", paymentTxnId: "TEST_PAYMENT_1", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" })
    expect(view(state)).toMatchObject({ status: "collection_confirmed", expectedRemainingCents: 30000, appliedReceiptCount: 1 })
    state = apply(state, { type: "invoice_readback", eventId: "TEST_READBACK_1", invoiceTxnId: "TEST_INVOICE_E", remainingCents: 30000, sourceRevision: "TEST_REV_3" })
    expect(view(state)).toMatchObject({ status: "reconciled", verifiedRemainingCents: 30000 })
  })

  it("partial collection replay counts one QBD payment TxnID only", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const receipt = { type: "collection_confirmed" as const, eventId: "TEST_RECEIPT_EVENT_1", requestKey: null, paymentTxnId: "TEST_PAYMENT_1", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" }
    const first = apply(posted, receipt)
    expect(apply(first, receipt)).toBe(first)
    const replay = apply(first, { ...receipt, eventId: "TEST_RECEIPT_EVENT_REPLAY" })
    expect(view(replay)).toMatchObject({ appliedReceiptCount: 1, expectedRemainingCents: 30000, confirmedCollectedCents: 20000 })
  })

  it("quarantines a second payment TxnID for the same collection request key", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const first = apply(posted, { type: "collection_confirmed", eventId: "TEST_PAYMENT_EVENT_1", requestKey: "TEST_REQUEST_1", paymentTxnId: "TEST_PAYMENT_1", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" })
    const duplicate = apply(first, { type: "collection_confirmed", eventId: "TEST_PAYMENT_EVENT_2", requestKey: "TEST_REQUEST_1", paymentTxnId: "TEST_PAYMENT_2", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_3" })
    expect(view(duplicate)).toMatchObject({ status: "quarantined", confirmedCollectedCents: 20000, appliedReceiptCount: 1 })
    expect(view(duplicate).quarantineReasons).toContain("conflicting_collection_request_key")
  })

  it("does not reopen a confirmed request or reuse it for a credit", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const first = apply(posted, { type: "collection_confirmed", eventId: "TEST_PAYMENT_EVENT_1", requestKey: "TEST_REQUEST_1", paymentTxnId: "TEST_PAYMENT_1", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" })
    const delayed = apply(first, { type: "collection_requested", eventId: "TEST_DELAYED_REQUEST", requestKey: "TEST_REQUEST_1", amountCents: 20000 })
    expect(view(delayed)).toMatchObject({ status: "collection_confirmed", confirmedCollectedCents: 20000 })
    expect(Object.keys(delayed.pending)).toHaveLength(0)
    const conflicting = apply(delayed, { type: "credit_requested", eventId: "TEST_CREDIT_REUSE", requestKey: "TEST_REQUEST_1", amountCents: 20000 })
    expect(view(conflicting).status).toBe("quarantined")
  })

  it("cancelled unposted commitment never claims a QBD invoice changed", () => {
    const state = apply(acceptedInstitutionalOrder("TEST_ORDER_F", 30000), { type: "cancel_unposted", eventId: "TEST_CANCEL_F" })
    expect(view(state)).toMatchObject({ status: "cancelled", expectedRemainingCents: null, verifiedRemainingCents: null })
    expect(state.invoiceTxnId).toBeNull()
  })

  it("quarantines a posted refund while QBD credit readback is absent", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_G", 40000), {
      ...invoice, eventId: "TEST_POST_G", invoiceTxnId: "TEST_INVOICE_G", finalCents: 40000,
    })
    const pending = apply(posted, { type: "credit_requested", eventId: "TEST_REFUND_REQUEST_G", requestKey: "TEST_REFUND_G", amountCents: 10000 })
    expect(view(pending)).toMatchObject({ status: "collection_pending", expectedRemainingCents: 40000, verifiedRemainingCents: null })
    const uncertain = apply(pending, { type: "outcome_uncertain", eventId: "TEST_REFUND_EVENT_G", requestKey: "TEST_REFUND_G" })
    expect(view(uncertain)).toMatchObject({ status: "quarantined", verifiedRemainingCents: null })
    expect(view(uncertain).quarantineReasons).toContain("uncertain_collection:TEST_REFUND_G")
  })

  it("applies a confirmed QBD credit once and reconciles only after invoice readback", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_G", 40000), {
      ...invoice, eventId: "TEST_POST_G", invoiceTxnId: "TEST_INVOICE_G", finalCents: 40000,
    })
    const credit = { type: "credit_confirmed" as const, eventId: "TEST_CREDIT_EVENT_1", requestKey: null, creditTxnId: "TEST_CREDIT_1", invoiceTxnId: "TEST_INVOICE_G", appliedCents: 10000, sourceRevision: "TEST_REV_2" }
    const first = apply(posted, credit)
    expect(view(first)).toMatchObject({ confirmedCreditCents: 10000, expectedRemainingCents: 30000, verifiedRemainingCents: null })
    const replay = apply(first, { ...credit, eventId: "TEST_CREDIT_EVENT_REPLAY" })
    expect(view(replay).confirmedCreditCents).toBe(10000)
    const readback = apply(replay, { type: "invoice_readback", eventId: "TEST_CREDIT_READBACK", invoiceTxnId: "TEST_INVOICE_G", remainingCents: 30000, sourceRevision: "TEST_REV_3" })
    expect(view(readback)).toMatchObject({ status: "reconciled", verifiedRemainingCents: 30000 })
  })

  it("quarantines conflicting replay, overcollection, and unexplained QBD balance", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    expect(view(apply(posted, { ...invoice, finalCents: 60000 })).status).toBe("quarantined")
    expect(view(apply(posted, { type: "collection_confirmed", eventId: "TEST_OVER", requestKey: null, paymentTxnId: "TEST_PAYMENT_OVER", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 60000, sourceRevision: "TEST_REV_2" }))).toMatchObject({ status: "quarantined", verifiedRemainingCents: null })
    expect(view(apply(posted, { type: "invoice_readback", eventId: "TEST_READ_MISMATCH", invoiceTxnId: "TEST_INVOICE_E", remainingCents: 40000, sourceRevision: "TEST_REV_2" }))).toMatchObject({ status: "quarantined", verifiedRemainingCents: null })
  })
})
