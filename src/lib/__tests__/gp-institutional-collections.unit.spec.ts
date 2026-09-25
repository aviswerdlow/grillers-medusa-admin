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
    expect(view(state)).toMatchObject({ status: "balance_verified", verifiedRemainingCents: 30000 })
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
    expect(view(readback)).toMatchObject({ status: "balance_verified", verifiedRemainingCents: 30000 })
  })

  it("quarantines conflicting replay, overcollection, and unexplained QBD balance", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    expect(view(apply(posted, { ...invoice, finalCents: 60000 })).status).toBe("quarantined")
    expect(view(apply(posted, { type: "collection_confirmed", eventId: "TEST_OVER", requestKey: null, paymentTxnId: "TEST_PAYMENT_OVER", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 60000, sourceRevision: "TEST_REV_2" }))).toMatchObject({ status: "quarantined", verifiedRemainingCents: null })
    expect(view(apply(posted, { type: "invoice_readback", eventId: "TEST_READ_MISMATCH", invoiceTxnId: "TEST_INVOICE_E", remainingCents: 40000, sourceRevision: "TEST_REV_2" }))).toMatchObject({ status: "quarantined", verifiedRemainingCents: null })
  })

  it("distinguishes a verified unpaid balance from a paid-in-full invoice", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const unpaid = apply(posted, { type: "invoice_readback", eventId: "TEST_UNPAID_READ", invoiceTxnId: "TEST_INVOICE_E", remainingCents: 50000, sourceRevision: "TEST_REV_2" })
    expect(view(unpaid)).toMatchObject({ status: "balance_verified", verifiedRemainingCents: 50000, confirmedCollectedCents: 0 })

    const collected = apply(posted, { type: "collection_confirmed", eventId: "TEST_PAID_EVENT", requestKey: null, paymentTxnId: "TEST_PAID_TXN", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 50000, sourceRevision: "TEST_REV_2" })
    const paid = apply(collected, { type: "invoice_readback", eventId: "TEST_PAID_READ", invoiceTxnId: "TEST_INVOICE_E", remainingCents: 0, sourceRevision: "TEST_REV_3" })
    expect(view(paid)).toMatchObject({ status: "paid_in_full", verifiedRemainingCents: 0, confirmedCollectedCents: 50000 })
  })

  it("treats reordered keys on the same event as an idempotent replay", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const receipt = { type: "collection_confirmed" as const, eventId: "TEST_REORDERED_EVENT", requestKey: null, paymentTxnId: "TEST_REORDERED_TXN", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" }
    const first = apply(posted, receipt)
    const reordered = { sourceRevision: "TEST_REV_2", appliedCents: 20000, invoiceTxnId: "TEST_INVOICE_E", paymentTxnId: "TEST_REORDERED_TXN", requestKey: null, eventId: "TEST_REORDERED_EVENT", type: "collection_confirmed" as const }
    expect(apply(first, reordered)).toBe(first)
    expect(view(first)).toMatchObject({ status: "collection_confirmed", confirmedCollectedCents: 20000, appliedReceiptCount: 1 })
  })

  it("sends unknown event types and malformed IDs or amounts to review", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    expect(view(apply(posted, { type: "mystery", eventId: "TEST_UNKNOWN" } as any)).quarantineReasons).toContain("unknown_event_type")
    expect(view(apply(posted, { type: "cancel_unposted", eventId: " " })).quarantineReasons).toContain("malformed_event")
    expect(view(apply(posted, { type: "collection_requested", eventId: "TEST_BAD_AMOUNT", requestKey: "TEST_REQUEST", amountCents: 1.5 })).quarantineReasons).toContain("malformed_event")
  })

  it("does not apply events after quarantine", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const held = apply(posted, { type: "outcome_uncertain", eventId: "TEST_UNCERTAIN", requestKey: "TEST_REQUEST" })
    const after = apply(held, { type: "collection_confirmed", eventId: "TEST_AFTER_HOLD", requestKey: null, paymentTxnId: "TEST_PAYMENT_AFTER", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" })
    expect(after.receipts).toEqual({})
    expect(view(after).quarantineReasons).toContain("event_after_quarantine")
  })

  it("quarantines a cancellation before posting and later conflicting invoice identity or amount", () => {
    const cancelled = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), { type: "cancel_unposted", eventId: "TEST_CANCEL_FIRST" })
    expect(view(apply(cancelled, invoice)).quarantineReasons).toContain("conflicting_invoice_posting")
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    expect(view(apply(posted, { ...invoice, eventId: "TEST_OTHER_INVOICE", invoiceTxnId: "TEST_INVOICE_OTHER" })).quarantineReasons).toContain("conflicting_invoice_posting")
    expect(view(apply(posted, { ...invoice, eventId: "TEST_OTHER_AMOUNT", finalCents: 60000 })).quarantineReasons).toContain("conflicting_invoice_posting")
  })

  it("quarantines changed or cross-kind collection request keys", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const requested = apply(posted, { type: "collection_requested", eventId: "TEST_REQUEST_FIRST", requestKey: "TEST_REQUEST", amountCents: 20000 })
    expect(view(apply(requested, { type: "collection_requested", eventId: "TEST_REQUEST_CHANGED", requestKey: "TEST_REQUEST", amountCents: 10000 })).quarantineReasons).toContain("conflicting_collection_request")
    expect(view(apply(requested, { type: "credit_requested", eventId: "TEST_CREDIT_SAME_KEY", requestKey: "TEST_REQUEST", amountCents: 20000 })).quarantineReasons).toContain("conflicting_credit_request")
    expect(view(apply(posted, { type: "collection_requested", eventId: "TEST_ZERO_REQUEST", requestKey: "TEST_ZERO", amountCents: 0 })).quarantineReasons).toContain("collection_without_invoice")
  })

  it("quarantines conflicting payment receipts before changing the collected balance", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const requested = apply(posted, { type: "collection_requested", eventId: "TEST_REQUEST_FIRST", requestKey: "TEST_REQUEST", amountCents: 20000 })
    const receipt = { type: "collection_confirmed" as const, eventId: "TEST_RECEIPT", requestKey: "TEST_REQUEST", paymentTxnId: "TEST_PAYMENT", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" }
    expect(view(apply(requested, { ...receipt, appliedCents: 10000 })).quarantineReasons).toContain("collection_amount_mismatch")
    expect(view(apply(requested, { ...receipt, invoiceTxnId: "TEST_OTHER_INVOICE" })).quarantineReasons).toContain("collection_identity_mismatch")
    const confirmed = apply(requested, receipt)
    expect(view(apply(confirmed, { ...receipt, eventId: "TEST_RECEIPT_CONFLICT", requestKey: null, appliedCents: 10000 })).quarantineReasons).toContain("conflicting_payment_txn_id")
    expect(view(confirmed)).toMatchObject({ confirmedCollectedCents: 20000, expectedRemainingCents: 30000 })
  })

  it("quarantines conflicting credit receipts and mismatched invoice readback", () => {
    const posted = apply(acceptedInstitutionalOrder("TEST_ORDER_E", 50000), invoice)
    const requested = apply(posted, { type: "credit_requested", eventId: "TEST_CREDIT_REQUEST", requestKey: "TEST_CREDIT_KEY", amountCents: 20000 })
    const credit = { type: "credit_confirmed" as const, eventId: "TEST_CREDIT_RECEIPT", requestKey: "TEST_CREDIT_KEY", creditTxnId: "TEST_CREDIT_TXN", invoiceTxnId: "TEST_INVOICE_E", appliedCents: 20000, sourceRevision: "TEST_REV_2" }
    expect(view(apply(requested, { ...credit, appliedCents: 10000 })).quarantineReasons).toContain("credit_amount_mismatch")
    expect(view(apply(requested, { ...credit, invoiceTxnId: "TEST_OTHER_INVOICE" })).quarantineReasons).toContain("credit_identity_mismatch")
    const confirmed = apply(requested, credit)
    expect(view(apply(confirmed, { ...credit, eventId: "TEST_CREDIT_CONFLICT", requestKey: null, appliedCents: 10000 })).quarantineReasons).toContain("conflicting_credit_txn_id")
    expect(view(apply(confirmed, { type: "invoice_readback", eventId: "TEST_OTHER_READ", invoiceTxnId: "TEST_OTHER_INVOICE", remainingCents: 30000, sourceRevision: "TEST_REV_3" })).quarantineReasons).toContain("invoice_readback_identity_mismatch")
    expect(view(confirmed)).toMatchObject({ confirmedCreditCents: 20000, expectedRemainingCents: 30000 })
  })
})
