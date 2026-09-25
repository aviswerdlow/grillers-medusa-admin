import type { InstitutionalBridgeReadbacks } from "./gp-institutional-bridge-readback"
import {
  acceptedInstitutionalOrder,
  applyInstitutionalCollectionEvent,
  institutionalCollectionView,
  type InstitutionalCollectionView,
} from "./gp-institutional-collections"

function id(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error("Stable institutional order or invoice identity is missing")
  }
  return value
}

function cents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Institutional order amount is invalid")
  }
  return value
}

/**
 * Read-only projection for an order whose exact QBD invoice TxnID came from the
 * posting receipt. A bridge detail cannot discover an order by customer name.
 */
export function projectInstitutionalOrderCollection(input: {
  orderId: string
  acceptedCents: number
  invoiceTxnId: string | null
  finalCents: number | null
  readbacks: InstitutionalBridgeReadbacks
  cancelled?: boolean
}): InstitutionalCollectionView {
  const orderId = id(input.orderId)
  let state = acceptedInstitutionalOrder(orderId, cents(input.acceptedCents))
  if (input.invoiceTxnId === null && input.finalCents === null) {
    if (input.cancelled) {
      state = applyInstitutionalCollectionEvent(state, {
        type: "cancel_unposted", eventId: `unposted_cancel:${orderId}`,
      })
    }
    return institutionalCollectionView(state)
  }
  if (input.invoiceTxnId === null || input.finalCents === null) {
    throw new Error("Institutional posting receipt is incomplete")
  }
  const invoiceTxnId = id(input.invoiceTxnId)
  const finalCents = cents(input.finalCents)
  const invoice = input.readbacks.invoices.find((item) => item.invoiceTxnId === invoiceTxnId)
  if (!invoice || invoice.totalCents !== finalCents) {
    throw new Error("Exact QBD invoice does not match the institutional order posting")
  }
  state = applyInstitutionalCollectionEvent(state, {
    type: "invoice_posted", eventId: `qbd_invoice:${invoiceTxnId}`,
    invoiceTxnId, finalCents, sourceRevision: invoice.sourceRevision,
  })
  if (input.cancelled) {
    state = applyInstitutionalCollectionEvent(state, {
      type: "cancel_unposted", eventId: `posted_cancel:${orderId}`,
    })
    return institutionalCollectionView(state)
  }
  if (invoice.creditTxnIds.length > 0 || invoice.reconciliationStatus === "credit_pending_detail") {
    state = applyInstitutionalCollectionEvent(state, {
      type: "outcome_uncertain", eventId: `qbd_credit_pending:${invoiceTxnId}:${invoice.sourceRevision}`,
      requestKey: `qbd_credit:${invoiceTxnId}`,
    })
    return institutionalCollectionView(state)
  }
  const payments = input.readbacks.payments.filter((item) => item.invoiceTxnId === invoiceTxnId)
  for (const payment of payments) {
    if (payment.status !== "confirmed_by_invoice_readback") {
      throw new Error("Institutional payment is not reconciled to the invoice")
    }
    state = applyInstitutionalCollectionEvent(state, {
      type: "collection_confirmed",
      eventId: `qbd_payment:${payment.paymentTxnId}:${invoiceTxnId}:${payment.sourceRevision}`,
      requestKey: null,
      paymentTxnId: payment.paymentTxnId,
      invoiceTxnId,
      appliedCents: payment.appliedCents,
      sourceRevision: payment.sourceRevision,
    })
  }
  if (payments.length > 0) {
    state = applyInstitutionalCollectionEvent(state, {
      type: "invoice_readback",
      eventId: `qbd_invoice_balance:${invoiceTxnId}:${invoice.sourceRevision}`,
      invoiceTxnId,
      remainingCents: invoice.remainingCents,
      sourceRevision: invoice.sourceRevision,
    })
  }
  return institutionalCollectionView(state)
}
