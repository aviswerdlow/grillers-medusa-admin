import { readInstitutionalBridgeAccount, type InstitutionalBridgeRead } from "./gp-institutional-source"
import type { InstitutionalInvoiceReadback } from "./gp-institutional-bridge-readback"

type Result =
  | { status: "pending"; reason: string }
  | { status: "posted" | "reconciled"; invoiceTxnId: string }
  | { status: "quarantined"; reason: string }

function id(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.trim() === value ? value : null
}

function cents(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function freshSource(source: InstitutionalBridgeRead, now: Date): boolean {
  const seconds = Number(process.env.GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS || "900")
  const maxAge = Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 3600
    ? seconds * 1000 : 0
  const readAt = Date.parse(source.snapshot?.lastSuccess || "")
  return source.sourceStatus === "success" && !!source.snapshot && !!source.readbacks &&
    maxAge > 0 && Number.isFinite(readAt) && readAt <= now.getTime() &&
    now.getTime() - readAt <= maxAge
}

/**
 * Bind a final posted QBD invoice to the exact checkout commitment only after
 * the authenticated accounting receipt and a fresh test-company source agree.
 * The account lock is the same one used by checkout reservations.
 */
export async function reconcileInstitutionalPostingHandoff(input: {
  db: any
  order: Record<string, any>
  readSource?: typeof readInstitutionalBridgeAccount
  now?: Date
}): Promise<Result> {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") {
    return { status: "pending", reason: "feature_disabled" }
  }
  const orderId = id(input.order?.id)
  const cartId = id(input.order?.cart_id)
  const customerId = id(input.order?.customer_id)
  const metadata = input.order?.metadata || {}
  const commitmentId = id(metadata.gp_institutional_commitment_id)
  if (!orderId || !cartId || !customerId || commitmentId !== `cart:${cartId}` ||
      metadata.payment_workflow !== "invoice_ar") {
    return { status: "quarantined", reason: "institutional_order_identity_mismatch" }
  }
  if (metadata.qbd_posting_status !== "posted") {
    return { status: "pending", reason: "invoice_posting_not_confirmed" }
  }

  const rows = await input.db("gp_institutional_credit_commitment")
    .where({ order_id: commitmentId }).whereNull("deleted_at")
  if (!Array.isArray(rows) || rows.length !== 1 ||
      !id(rows[0].company_key) || !id(rows[0].customer_list_id)) {
    return { status: "quarantined", reason: "commitment_identity_unavailable" }
  }
  const account = { companyKey: rows[0].company_key as string, customerListId: rows[0].customer_list_id as string }
  const invoiceTxnId = id(metadata.qbd_txn_id)
  const finalCents = cents(metadata.qbd_posting_amount)
  let hardReason: string | null =
    metadata.qbd_posting_action !== "invoice_ar_accounting_record" ||
    metadata.qbd_posting_request_key !== `invoice_ar:${orderId}` ||
    !invoiceTxnId || finalCents === null || finalCents === 0
      ? "posting_receipt_mismatch" : null
  let source: InstitutionalBridgeRead | null = null
  let invoice: InstitutionalInvoiceReadback | undefined
  if (!hardReason) {
    source = await (input.readSource || readInstitutionalBridgeAccount)(customerId)
    if (!freshSource(source, input.now || new Date())) {
      return { status: "pending", reason: "qbd_source_unavailable_or_stale" }
    }
    const expectedCompany = process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 || ""
    if (!/^[a-f0-9]{64}$/.test(expectedCompany) ||
        source.link?.status !== "verified" ||
        source.link.companyKey !== expectedCompany ||
        source.link.companyKey !== account.companyKey ||
        source.link.customerListId !== account.customerListId ||
        source.link.medusaCustomerId !== customerId ||
        source.snapshot?.source !== "quickbooks_desktop_test_company" ||
        source.snapshot?.companyKey !== account.companyKey ||
        source.snapshot.customerListId !== account.customerListId) {
      hardReason = "qbd_account_identity_mismatch"
    } else {
      invoice = source.readbacks!.invoices.find((row) => row.invoiceTxnId === invoiceTxnId)
      if (!invoice) return { status: "pending", reason: "posted_invoice_not_in_qbd_read" }
      if (invoice.totalCents !== finalCents) hardReason = "posted_invoice_amount_mismatch"
    }
  }

  return input.db.transaction(async (trx: any): Promise<Result> => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp_institutional_credit:${account.companyKey}:${account.customerListId}`,
    ])
    const locked = await trx("gp_institutional_credit_commitment")
      .where({
        order_id: commitmentId,
        company_key: account.companyKey,
        customer_list_id: account.customerListId,
      }).whereNull("deleted_at").forUpdate()
    if (!Array.isArray(locked) || locked.length !== 1) {
      return { status: "quarantined", reason: "commitment_changed_during_handoff" }
    }
    const row = locked[0]
    if (row.state === "quarantined") {
      return { status: "quarantined", reason: "commitment_already_quarantined" }
    }
    if (cents(row.amount_cents) !== finalCents ||
        !["accepted", "posting", "posted", "reconciled"].includes(String(row.state)) ||
        row.invoice_txn_id && row.invoice_txn_id !== invoiceTxnId) {
      hardReason = hardReason || "commitment_posting_conflict"
    }
    if (!hardReason && invoiceTxnId) {
      const linked = await trx("gp_institutional_credit_commitment")
        .where({
          company_key: account.companyKey,
          customer_list_id: account.customerListId,
          invoice_txn_id: invoiceTxnId,
        }).whereNull("deleted_at")
      if (!Array.isArray(linked) || linked.some((other: any) => other.id !== row.id)) {
        hardReason = "invoice_linked_to_another_commitment"
      }
    }
    const settled = invoice?.remainingCents === 0 &&
      invoice?.reconciliationStatus === "reconciled"
    if (!hardReason && row.state === "reconciled" && !settled) {
      hardReason = "reconciled_invoice_regressed"
    }
    if (hardReason) {
      const written = await trx("gp_institutional_credit_commitment")
        .where({ id: row.id }).update({ state: "quarantined", updated_at: new Date() })
      if (written !== 1) throw new Error("Institutional quarantine was not persisted")
      return { status: "quarantined", reason: hardReason }
    }
    const state = settled ? "reconciled" : "posted"
    if (row.state !== state || row.invoice_txn_id !== invoiceTxnId) {
      const written = await trx("gp_institutional_credit_commitment")
        .where({ id: row.id }).update({
          state, invoice_txn_id: invoiceTxnId, updated_at: new Date(),
        })
      if (written !== 1) throw new Error("Institutional invoice handoff was not persisted")
    }
    return { status: state, invoiceTxnId: invoiceTxnId! }
  })
}
