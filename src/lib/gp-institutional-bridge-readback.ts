import type { InstitutionalInvoice } from "./gp-institutional-exposure"

export type InstitutionalInvoiceReadback = {
  invoiceTxnId: string
  totalCents: number
  remainingCents: number
  paymentTxnIds: string[]
  creditTxnIds: string[]
  sourceRevision: string
  reconciliationStatus: "outstanding" | "reconciled" | "credit_pending_detail"
}

export type InstitutionalPaymentReadback = {
  paymentTxnId: string
  invoiceTxnId: string
  receivedTotalCents: number
  appliedCents: number
  sourceRevision: string
  status: "confirmed_by_invoice_readback" | "pending_credit_detail"
}

export type InstitutionalBridgeReadbacks = {
  invoices: InstitutionalInvoiceReadback[]
  payments: InstitutionalPaymentReadback[]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Institutional QBD readback is missing")
  }
  return value as Record<string, unknown>
}

function id(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error("Stable institutional QBD identity is missing")
  }
  return value
}

function cents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Institutional QBD amount is invalid")
  }
  return value
}

function exactAccount(row: Record<string, unknown>, companyKey: string, customerListId: string) {
  if (row.source !== "quickbooks_desktop_test_company" ||
      row.company_key !== companyKey || row.customer_list_id !== customerListId) {
    throw new Error("Institutional QBD readback identity mismatch")
  }
}

/** Validate the complete test-company detail set before any receipt is trusted. */
export function parseInstitutionalBridgeReadbacks(input: {
  invoiceRows: unknown
  paymentRows: unknown
  companyKey: string
  customerListId: string
  openInvoices: InstitutionalInvoice[]
}): InstitutionalBridgeReadbacks {
  const companyKey = id(input.companyKey)
  const customerListId = id(input.customerListId)
  if (!Array.isArray(input.invoiceRows) || input.invoiceRows.length > 100 ||
      !Array.isArray(input.paymentRows) || input.paymentRows.length > 100) {
    throw new Error("Institutional QBD detail set is incomplete or oversized")
  }
  const current = new Map(input.openInvoices.map((invoice) => [id(invoice.txnId), cents(invoice.remainingCents)]))
  if (current.size !== input.openInvoices.length) throw new Error("Duplicate open invoice identity")
  const invoices: InstitutionalInvoiceReadback[] = []
  const invoiceIds = new Set<string>()
  for (const raw of input.invoiceRows) {
    const row = record(raw)
    exactAccount(row, companyKey, customerListId)
    const invoiceTxnId = id(row.invoice_txn_id)
    if (invoiceIds.has(invoiceTxnId)) throw new Error("Duplicate invoice readback identity")
    invoiceIds.add(invoiceTxnId)
    const totalCents = cents(row.invoice_total_cents)
    const remainingCents = cents(row.remaining_cents)
    if (remainingCents > totalCents ||
        (remainingCents > 0 && current.get(invoiceTxnId) !== remainingCents) ||
        (remainingCents === 0 && current.has(invoiceTxnId))) {
      throw new Error("Institutional invoice readback disagrees with open exposure")
    }
    if (!Array.isArray(row.linked_transactions)) throw new Error("Invoice links are unavailable")
    const paymentTxnIds: string[] = []
    const creditTxnIds: string[] = []
    const linkedIds = new Set<string>()
    for (const rawLink of row.linked_transactions) {
      const link = record(rawLink)
      const txnId = id(link.txn_id)
      const kind = link.txn_type
      if (kind !== "ReceivePayment" && kind !== "CreditMemo") {
        throw new Error("Unknown institutional invoice link")
      }
      const key = `${kind}:${txnId}`
      if (linkedIds.has(key)) throw new Error("Duplicate institutional invoice link")
      linkedIds.add(key)
      if (kind === "ReceivePayment") paymentTxnIds.push(txnId)
      else creditTxnIds.push(txnId)
    }
    const reconciliationStatus = row.reconciliation_status
    if (reconciliationStatus !== "outstanding" && reconciliationStatus !== "reconciled" &&
        reconciliationStatus !== "credit_pending_detail") {
      throw new Error("Unknown institutional reconciliation state")
    }
    invoices.push({
      invoiceTxnId, totalCents, remainingCents, paymentTxnIds, creditTxnIds,
      sourceRevision: id(row.source_revision), reconciliationStatus,
    })
  }
  for (const txnId of current.keys()) {
    if (!invoiceIds.has(txnId)) throw new Error("Open invoice has no exact QBD detail")
  }

  const payments: InstitutionalPaymentReadback[] = []
  const paymentPairs = new Set<string>()
  const paymentTotals = new Map<string, { received: number; applied: number }>()
  for (const raw of input.paymentRows) {
    const row = record(raw)
    exactAccount(row, companyKey, customerListId)
    const paymentTxnId = id(row.payment_txn_id)
    const invoiceTxnId = id(row.invoice_txn_id)
    const pair = JSON.stringify([paymentTxnId, invoiceTxnId])
    if (paymentPairs.has(pair)) throw new Error("Duplicate payment application")
    paymentPairs.add(pair)
    const invoice = invoices.find((item) => item.invoiceTxnId === invoiceTxnId)
    if (!invoice?.paymentTxnIds.includes(paymentTxnId)) {
      throw new Error("Payment is not linked to the exact invoice")
    }
    const receivedTotalCents = cents(row.received_total_cents)
    const appliedCents = cents(row.applied_to_invoice_cents)
    if (appliedCents === 0 || appliedCents > receivedTotalCents) {
      throw new Error("Invalid QBD payment application")
    }
    const status = row.status
    if (status !== "confirmed_by_invoice_readback" && status !== "pending_credit_detail") {
      throw new Error("Unknown institutional payment readback state")
    }
    const prior = paymentTotals.get(paymentTxnId)
    if (prior && prior.received !== receivedTotalCents) {
      throw new Error("Conflicting QBD payment total")
    }
    const applied = (prior?.applied ?? 0) + appliedCents
    if (!Number.isSafeInteger(applied) || applied > receivedTotalCents) {
      throw new Error("QBD payment applications exceed received amount")
    }
    paymentTotals.set(paymentTxnId, { received: receivedTotalCents, applied })
    payments.push({
      paymentTxnId, invoiceTxnId, receivedTotalCents, appliedCents,
      sourceRevision: id(row.source_revision), status,
    })
  }

  for (const invoice of invoices) {
    const applications = payments.filter((payment) => payment.invoiceTxnId === invoice.invoiceTxnId)
    if (applications.length !== invoice.paymentTxnIds.length) {
      throw new Error("Linked QBD payment detail is missing")
    }
    const paid = applications.reduce((total, payment) => total + payment.appliedCents, 0)
    const reduction = invoice.totalCents - invoice.remainingCents
    if (!Number.isSafeInteger(paid) || paid > reduction) {
      throw new Error("Payment detail exceeds invoice reduction")
    }
    if (invoice.creditTxnIds.length) {
      if (invoice.reconciliationStatus !== "credit_pending_detail" ||
          applications.some((payment) => payment.status !== "pending_credit_detail")) {
        throw new Error("Credit-linked invoice was prematurely reconciled")
      }
    } else if (paid !== reduction ||
        invoice.reconciliationStatus !== (paid > 0 ? "reconciled" : "outstanding") ||
        applications.some((payment) => payment.status !== "confirmed_by_invoice_readback")) {
      throw new Error("QBD invoice and payment readbacks do not reconcile")
    }
  }
  return { invoices, payments }
}
