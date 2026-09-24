/**
 * #370 — document-level institutional A/R math. All amounts are integer USD cents.
 * The QBD read supplies invoice balances; only a confirmed QBD read may reduce them.
 */

export type InstitutionalInvoice = {
  txnId: string
  remainingCents: number
}

export type InstitutionalCommitment = {
  orderId: string
  amountCents: number
  state: "accepted" | "posting" | "posted" | "cancelled" | "reconciled"
  invoiceTxnId?: string | null
}

export type InstitutionalExposureInput = {
  invoices: InstitutionalInvoice[]
  commitments: InstitutionalCommitment[]
  pendingCreditTxnIds?: string[]
}

export type InstitutionalExposure = {
  invoiceCents: number
  commitmentCents: number
  totalCents: number
  quarantined: boolean
  reasons: string[]
}

function validCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function requiredId(value: string): string {
  const id = typeof value === "string" ? value.trim() : ""
  if (!id) throw new Error("Stable document ID is required")
  return id
}

export function calculateInstitutionalExposure(
  input: InstitutionalExposureInput
): InstitutionalExposure {
  const invoiceIds = new Set<string>()
  let invoiceCents = 0
  for (const invoice of input.invoices) {
    const txnId = requiredId(invoice.txnId)
    if (invoiceIds.has(txnId)) throw new Error("Duplicate QBD invoice TxnID")
    if (!validCents(invoice.remainingCents)) {
      throw new Error("Invalid QBD remaining invoice balance")
    }
    invoiceIds.add(txnId)
    invoiceCents += invoice.remainingCents
  }

  const orderIds = new Set<string>()
  const mappedInvoiceIds = new Set<string>()
  const reasons: string[] = []
  let commitmentCents = 0
  for (const commitment of input.commitments) {
    const orderId = requiredId(commitment.orderId)
    if (orderIds.has(orderId)) throw new Error("Duplicate institutional order commitment")
    if (!validCents(commitment.amountCents)) {
      throw new Error("Invalid institutional order commitment")
    }
    orderIds.add(orderId)

    const invoiceTxnId = commitment.invoiceTxnId
      ? requiredId(commitment.invoiceTxnId)
      : null
    if (invoiceTxnId) {
      if (mappedInvoiceIds.has(invoiceTxnId)) {
        throw new Error("QBD invoice TxnID linked to multiple orders")
      }
      mappedInvoiceIds.add(invoiceTxnId)
    }

    // The exact QBD document replaces its local commitment once it appears in
    // a complete source read. Retaining both would consume the same credit twice.
    if (invoiceTxnId && invoiceIds.has(invoiceTxnId)) {
      // QBD still owns the receivable, but a cancelled posted order also
      // needs an explicit credit/readback before further terms are offered.
      if (commitment.state === "cancelled") {
        reasons.push(`posted_cancellation_waiting_for_qbd:${orderId}`)
      }
      continue
    }

    // Cancelling an unposted order releases its commitment. A posted cancellation
    // remains outstanding until QBD confirms the corresponding credit/payment.
    if (commitment.state === "reconciled" || (commitment.state === "cancelled" && !invoiceTxnId)) {
      continue
    }

    commitmentCents += commitment.amountCents
    if (commitment.state === "posted" && !invoiceTxnId) {
      reasons.push(`posted_order_without_invoice_identity:${orderId}`)
    }
    if (commitment.state === "posted" && invoiceTxnId && !invoiceIds.has(invoiceTxnId)) {
      reasons.push(`posted_invoice_not_in_qbd_read:${orderId}`)
    }
    if (commitment.state === "cancelled" && invoiceTxnId) {
      reasons.push(`posted_cancellation_waiting_for_qbd:${orderId}`)
    }
  }

  if ((input.pendingCreditTxnIds ?? []).length > 0) {
    reasons.push("credit_waiting_for_qbd_readback")
  }
  if (!Number.isSafeInteger(invoiceCents + commitmentCents)) {
    throw new Error("Institutional exposure exceeds safe integer precision")
  }

  return {
    invoiceCents,
    commitmentCents,
    totalCents: invoiceCents + commitmentCents,
    quarantined: reasons.length > 0,
    reasons,
  }
}

export type CreditReservationDecision =
  | { status: "reserved"; projectedCents: number; exposure: InstitutionalExposure }
  | { status: "hold"; reason: string; projectedCents: number | null; exposure?: InstitutionalExposure }

type CreditTransaction = {
  raw(sql: string, bindings: unknown[]): Promise<unknown>
}

type CreditDatabase = {
  transaction<T>(run: (trx: CreditTransaction) => Promise<T>): Promise<T>
}

export type CreditReservationStore = {
  list(trx: CreditTransaction, companyKey: string, customerListId: string): Promise<InstitutionalCommitment[]>
  reserve(
    trx: CreditTransaction,
    account: { companyKey: string; customerListId: string },
    commitment: InstitutionalCommitment
  ): Promise<void>
}

/**
 * Serializes all credit reservations for one QBD account within one Postgres
 * transaction. The durable store is supplied by the checkout integration.
 */
export async function reserveInstitutionalCredit(input: {
  db: CreditDatabase
  store: CreditReservationStore
  companyKey: string
  customerListId: string
  sourceFresh: boolean
  limitCents: number | null
  invoices: InstitutionalInvoice[]
  pendingCreditTxnIds?: string[]
  commitment: InstitutionalCommitment
}): Promise<CreditReservationDecision> {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") {
    return { status: "hold", reason: "feature_disabled", projectedCents: null }
  }
  const companyKey = requiredId(input.companyKey)
  const customerListId = requiredId(input.customerListId)
  if (!input.sourceFresh) {
    return { status: "hold", reason: "stale_qbd_exposure", projectedCents: null }
  }
  if (!validCents(input.limitCents as number) || !input.limitCents) {
    return { status: "hold", reason: "missing_qbd_credit_limit", projectedCents: null }
  }
  if (input.commitment.state !== "accepted" || !validCents(input.commitment.amountCents)) {
    throw new Error("Only a valid accepted order can reserve institutional credit")
  }

  return input.db.transaction(async (trx) => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp_institutional_credit:${companyKey}:${customerListId}`,
    ])
    const existing = await input.store.list(trx, companyKey, customerListId)
    const other = existing.filter((row) => row.orderId !== input.commitment.orderId)
    const exposure = calculateInstitutionalExposure({
      invoices: input.invoices,
      commitments: other,
      pendingCreditTxnIds: input.pendingCreditTxnIds,
    })
    const projectedCents = exposure.totalCents + input.commitment.amountCents
    if (!Number.isSafeInteger(projectedCents)) {
      throw new Error("Projected institutional exposure exceeds safe integer precision")
    }
    if (exposure.quarantined) {
      return { status: "hold", reason: "qbd_reconciliation_uncertain", projectedCents, exposure }
    }
    if (projectedCents > input.limitCents!) {
      return { status: "hold", reason: "credit_limit_exceeded", projectedCents, exposure }
    }
    // Same order ID is an idempotent refresh; the store must upsert by stable
    // order ID under this account lock rather than create another commitment.
    await input.store.reserve(trx, { companyKey, customerListId }, input.commitment)
    return { status: "reserved", projectedCents, exposure }
  })
}
