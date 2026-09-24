/**
 * #370: pure, replay-safe projection for one institutional order. A QuickBooks
 * receipt or invoice readback is required before the projection calls money
 * collected or reconciled. Adapter work on #29 / bridge #7 is separate.
 */
export type InstitutionalCollectionEvent =
  | { type: "invoice_posted"; eventId: string; invoiceTxnId: string; finalCents: number; sourceRevision: string }
  | { type: "collection_requested"; eventId: string; requestKey: string; amountCents: number }
  | { type: "collection_confirmed"; eventId: string; requestKey: string | null; paymentTxnId: string; invoiceTxnId: string; appliedCents: number; sourceRevision: string }
  | { type: "credit_requested"; eventId: string; requestKey: string; amountCents: number }
  | { type: "credit_confirmed"; eventId: string; requestKey: string | null; creditTxnId: string; invoiceTxnId: string; appliedCents: number; sourceRevision: string }
  | { type: "invoice_readback"; eventId: string; invoiceTxnId: string; remainingCents: number; sourceRevision: string }
  | { type: "cancel_unposted"; eventId: string }
  | { type: "outcome_uncertain"; eventId: string; requestKey: string }

export type InstitutionalCollectionState = {
  orderId: string
  acceptedCents: number
  invoiceTxnId: string | null
  invoiceCents: number | null
  invoiceRevision: string | null
  receipts: Record<string, { appliedCents: number; requestKey: string | null; sourceRevision: string }>
  credits: Record<string, { appliedCents: number; requestKey: string | null; sourceRevision: string }>
  pending: Record<string, { kind: "collection" | "credit"; amountCents: number }>
  seenEvents: Record<string, string>
  lastReadback: { remainingCents: number; sourceRevision: string } | null
  cancelled: boolean
  quarantineReasons: string[]
}

export type InstitutionalCollectionView = {
  status: "accepted_on_terms" | "invoice_outstanding" | "collection_pending" | "collection_confirmed" | "reconciled" | "cancelled" | "quarantined"
  confirmedCollectedCents: number
  confirmedCreditCents: number
  expectedRemainingCents: number | null
  verifiedRemainingCents: number | null
  appliedReceiptCount: number
  quarantineReasons: string[]
}

function id(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw new Error("Stable institutional document ID required")
  }
  return value
}

function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid institutional amount")
  return value
}

function quarantine(state: InstitutionalCollectionState, reason: string): InstitutionalCollectionState {
  return { ...state, quarantineReasons: [...new Set([...state.quarantineReasons, reason])] }
}

export function acceptedInstitutionalOrder(orderId: string, acceptedCents: number): InstitutionalCollectionState {
  return {
    orderId: id(orderId), acceptedCents: cents(acceptedCents),
    invoiceTxnId: null, invoiceCents: null, invoiceRevision: null,
    receipts: {}, credits: {}, pending: {}, seenEvents: {}, lastReadback: null,
    cancelled: false, quarantineReasons: [],
  }
}

export function applyInstitutionalCollectionEvent(
  state: InstitutionalCollectionState,
  event: InstitutionalCollectionEvent
): InstitutionalCollectionState {
  const eventId = id(event.eventId)
  const fingerprint = JSON.stringify(event)
  if (state.seenEvents[eventId] === fingerprint) return state
  if (state.seenEvents[eventId]) return quarantine(state, `conflicting_event:${eventId}`)
  const next = { ...state, seenEvents: { ...state.seenEvents, [eventId]: fingerprint } }
  if (state.quarantineReasons.length) return quarantine(next, "event_after_quarantine")

  switch (event.type) {
    case "invoice_posted": {
      const invoiceTxnId = id(event.invoiceTxnId)
      const sourceRevision = id(event.sourceRevision)
      const finalCents = cents(event.finalCents)
      if (state.cancelled || (state.invoiceTxnId &&
          (state.invoiceTxnId !== invoiceTxnId || state.invoiceCents !== finalCents))) {
        return quarantine(next, "conflicting_invoice_posting")
      }
      return { ...next, invoiceTxnId, invoiceCents: finalCents, invoiceRevision: sourceRevision }
    }
    case "collection_requested": {
      const requestKey = id(event.requestKey)
      const amountCents = cents(event.amountCents)
      if (!state.invoiceTxnId || state.cancelled || amountCents === 0) {
        return quarantine(next, "collection_without_invoice")
      }
      if (state.pending[requestKey] !== undefined &&
          (state.pending[requestKey].kind !== "collection" || state.pending[requestKey].amountCents !== amountCents)) {
        return quarantine(next, "conflicting_collection_request")
      }
      return { ...next, pending: { ...state.pending, [requestKey]: { kind: "collection", amountCents } } }
    }
    case "credit_requested": {
      const requestKey = id(event.requestKey)
      const amountCents = cents(event.amountCents)
      if (!state.invoiceTxnId || amountCents === 0) {
        return quarantine(next, "credit_without_invoice")
      }
      if (state.pending[requestKey] !== undefined &&
          (state.pending[requestKey].kind !== "credit" || state.pending[requestKey].amountCents !== amountCents)) {
        return quarantine(next, "conflicting_credit_request")
      }
      return { ...next, pending: { ...state.pending, [requestKey]: { kind: "credit", amountCents } } }
    }
    case "collection_confirmed": {
      const paymentTxnId = id(event.paymentTxnId)
      const invoiceTxnId = id(event.invoiceTxnId)
      const sourceRevision = id(event.sourceRevision)
      const appliedCents = cents(event.appliedCents)
      const requestKey = event.requestKey === null ? null : id(event.requestKey)
      if (!state.invoiceTxnId || state.invoiceTxnId !== invoiceTxnId || appliedCents === 0) {
        return quarantine(next, "collection_identity_mismatch")
      }
      const prior = state.receipts[paymentTxnId]
      if (prior) {
        return prior.appliedCents === appliedCents && prior.requestKey === requestKey
          ? next : quarantine(next, "conflicting_payment_txn_id")
      }
      if (requestKey && state.pending[requestKey] !== undefined &&
          (state.pending[requestKey].kind !== "collection" || state.pending[requestKey].amountCents !== appliedCents)) {
        return quarantine(next, "collection_amount_mismatch")
      }
      const alreadyCollected = Object.values(state.receipts)
        .reduce((sum, receipt) => sum + receipt.appliedCents, 0) +
        Object.values(state.credits).reduce((sum, credit) => sum + credit.appliedCents, 0)
      if (!Number.isSafeInteger(alreadyCollected + appliedCents) ||
          alreadyCollected + appliedCents > state.invoiceCents!) {
        return quarantine(next, "collection_exceeds_invoice")
      }
      const pending = { ...state.pending }
      if (requestKey) delete pending[requestKey]
      return { ...next, pending, lastReadback: null, receipts: {
        ...state.receipts,
        [paymentTxnId]: { appliedCents, requestKey, sourceRevision },
      } }
    }
    case "credit_confirmed": {
      const creditTxnId = id(event.creditTxnId)
      const invoiceTxnId = id(event.invoiceTxnId)
      const sourceRevision = id(event.sourceRevision)
      const appliedCents = cents(event.appliedCents)
      const requestKey = event.requestKey === null ? null : id(event.requestKey)
      if (!state.invoiceTxnId || state.invoiceTxnId !== invoiceTxnId || appliedCents === 0) {
        return quarantine(next, "credit_identity_mismatch")
      }
      const prior = state.credits[creditTxnId]
      if (prior) {
        return prior.appliedCents === appliedCents && prior.requestKey === requestKey
          ? next : quarantine(next, "conflicting_credit_txn_id")
      }
      if (requestKey && state.pending[requestKey] !== undefined &&
          (state.pending[requestKey].kind !== "credit" || state.pending[requestKey].amountCents !== appliedCents)) {
        return quarantine(next, "credit_amount_mismatch")
      }
      const alreadyApplied = Object.values(state.receipts)
        .reduce((sum, receipt) => sum + receipt.appliedCents, 0) +
        Object.values(state.credits).reduce((sum, credit) => sum + credit.appliedCents, 0)
      if (!Number.isSafeInteger(alreadyApplied + appliedCents) ||
          alreadyApplied + appliedCents > state.invoiceCents!) {
        return quarantine(next, "credit_exceeds_invoice")
      }
      const pending = { ...state.pending }
      if (requestKey) delete pending[requestKey]
      return { ...next, pending, lastReadback: null, credits: {
        ...state.credits,
        [creditTxnId]: { appliedCents, requestKey, sourceRevision },
      } }
    }
    case "invoice_readback": {
      const invoiceTxnId = id(event.invoiceTxnId)
      const sourceRevision = id(event.sourceRevision)
      const remainingCents = cents(event.remainingCents)
      if (!state.invoiceTxnId || state.invoiceTxnId !== invoiceTxnId) {
        return quarantine(next, "invoice_readback_identity_mismatch")
      }
      const applied = Object.values(state.receipts).reduce((sum, receipt) => sum + receipt.appliedCents, 0) +
        Object.values(state.credits).reduce((sum, credit) => sum + credit.appliedCents, 0)
      if (remainingCents !== state.invoiceCents! - applied) {
        return quarantine(next, "invoice_balance_unexplained")
      }
      return { ...next, lastReadback: { remainingCents, sourceRevision } }
    }
    case "cancel_unposted":
      return state.invoiceTxnId ? quarantine(next, "posted_cancellation_needs_qbd_credit")
        : { ...next, cancelled: true }
    case "outcome_uncertain":
      return quarantine(next, `uncertain_collection:${id(event.requestKey)}`)
  }
}

export function institutionalCollectionView(state: InstitutionalCollectionState): InstitutionalCollectionView {
  const confirmedCollectedCents = Object.values(state.receipts)
    .reduce((sum, receipt) => sum + receipt.appliedCents, 0)
  const confirmedCreditCents = Object.values(state.credits)
    .reduce((sum, credit) => sum + credit.appliedCents, 0)
  const expectedRemainingCents = state.invoiceCents === null
    ? null : state.invoiceCents - confirmedCollectedCents - confirmedCreditCents
  const verifiedRemainingCents = state.quarantineReasons.length === 0
    ? state.lastReadback?.remainingCents ?? null : null
  const status = state.quarantineReasons.length ? "quarantined"
    : state.cancelled ? "cancelled"
    : !state.invoiceTxnId ? "accepted_on_terms"
    : Object.keys(state.pending).length ? "collection_pending"
    : state.lastReadback ? "reconciled"
    : confirmedCollectedCents || confirmedCreditCents ? "collection_confirmed"
    : "invoice_outstanding"
  return {
    status, confirmedCollectedCents, confirmedCreditCents, expectedRemainingCents, verifiedRemainingCents,
    appliedReceiptCount: Object.keys(state.receipts).length,
    quarantineReasons: state.quarantineReasons,
  }
}
