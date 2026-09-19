import { randomUUID } from "node:crypto"

export const QBD_OUTBOX_TABLE = "gp_qbd_posting_outbox"
export const QBD_OUTBOX_VERSION = 1
const ACTIONS = new Set([
  "final_card_charge_accounting_record", "invoice_ar_accounting_record",
  "card_refund_accounting_record", "payment_capture_accounting_record",
  "record_offline_payment", "issue_account_credit", "pending_check_refund",
  "close_sales_order", "append_order_note", "update_sales_order_items",
])

export class QbdPostingConflict extends Error {
  readonly status = 409
}

export function qbdMetadata(value: unknown): Record<string, any> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  if (parsed == null) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QbdPostingConflict("Order accounting metadata cannot be verified.")
  }
  return { ...parsed }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isPending(metadata: Record<string, any>): boolean {
  return [true, "true"].includes(metadata.qbd_posting_required)
    && ["pending", "pending_manual", "queued", "failed"].includes(metadata.qbd_posting_status)
}

async function requireTrackedPrevious(db: any, orderId: string, metadata: Record<string, any>) {
  if (!isPending(metadata)) return
  const key = text(metadata.qbd_posting_request_key)
  const existing = key && await db(QBD_OUTBOX_TABLE).where({ order_id: orderId, request_key: key }).first("id")
  if (!existing) {
    throw new QbdPostingConflict(
      "This order has an older QuickBooks request that needs reconciliation before another accounting action. No new payment action should be retried or replayed."
    )
  }
}

/** Run before moving money. Missing schema or untracked legacy work fails closed. */
export async function assertQbdPostingReady(db: any, orderId: string): Promise<void> {
  await db(QBD_OUTBOX_TABLE).select("id").limit(1)
  const order = await db("order").where({ id: orderId }).whereNull("deleted_at").first("metadata")
  if (!order) throw new QbdPostingConflict("Order was not found for accounting.")
  await requireTrackedPrevious(db, orderId, qbdMetadata(order.metadata))
}

function postingFacts(metadata: Record<string, any>, currency: unknown) {
  const requestKey = text(metadata.qbd_posting_request_key)
  const action = text(metadata.qbd_posting_action)
  const amount = Number(metadata.qbd_posting_amount)
  const currencyCode = text(currency).toLowerCase()
  if (!requestKey || requestKey.length > 250 || !ACTIONS.has(action)
    || !Number.isSafeInteger(amount) || amount < 0 || !/^[a-z]{3}$/.test(currencyCode)) {
    throw new QbdPostingConflict("QuickBooks posting requires a stable key, supported action, minor-unit amount and currency.")
  }
  if (!isPending(metadata) || metadata.qbd_posting_status === "failed") {
    throw new QbdPostingConflict("Only a confirmed pending accounting action can enter the outbox.")
  }
  if ((action === "card_refund_accounting_record" && metadata.stripe_refund_status === "requested")
    || (action === "payment_capture_accounting_record" && metadata.payment_capture_status === "requested")
    || (action === "close_sales_order" && metadata.medusa_cancel_status === "requested")
    || (action === "update_sales_order_items" && metadata.staff_exception_status === "order_item_edit_requested")) {
    throw new QbdPostingConflict("The source action has not completed; it cannot be posted to QuickBooks.")
  }
  return { requestKey, action, amount, currencyCode }
}

export type QbdPostingInput = {
  db: any
  // A full graph result, never a list summary. Metadata is rebuilt under the row lock.
  order: Record<string, any>
  buildMetadata: (current: Record<string, any>) => Record<string, any>
}

/** Commit the immutable action and order projection atomically; no network calls in this transaction. */
export async function persistQbdPosting({ db, order, buildMetadata }: QbdPostingInput) {
  if (!text(order.id) || !Array.isArray(order.items)) {
    throw new QbdPostingConflict("A full order snapshot is required before queuing accounting.")
  }
  return db.transaction(async (trx: any) => {
    const row = await trx("order").where({ id: order.id }).whereNull("deleted_at").forUpdate().first()
    if (!row) throw new QbdPostingConflict("Order was not found for accounting.")
    const current = qbdMetadata(row.metadata)
    const metadata = buildMetadata(current)
    const facts = postingFacts(metadata, order.currency_code)
    const existing = await trx(QBD_OUTBOX_TABLE).where({ request_key: facts.requestKey }).first()
    if (existing) {
      const original = qbdMetadata(existing.order_snapshot?.metadata)
      if (existing.order_id !== order.id || existing.action !== facts.action
        || Number(existing.amount_minor) !== facts.amount || existing.currency_code !== facts.currencyCode
        || (facts.action === "card_refund_accounting_record" && text(original.stripe_refund_id) !== text(metadata.stripe_refund_id))
        || text(original.stripe_payment_intent_id) !== text(metadata.stripe_payment_intent_id)) {
        throw new QbdPostingConflict("The accounting request key already identifies a different action.")
      }
      // A repeated older action must not replace a newer order projection.
      return { posting: existing, metadata: current, replayed: true }
    }
    await requireTrackedPrevious(trx, order.id, current)
    const previous = await trx(QBD_OUTBOX_TABLE).where({ order_id: order.id }).orderBy("sequence", "desc").first("request_key")
    const id = `qbdout_${randomUUID()}`
    const next = { ...metadata, qbd_posting_outbox_version: QBD_OUTBOX_VERSION, qbd_posting_outbox_id: id }
    const snapshot = { ...order, metadata: next }
    const [posting] = await trx(QBD_OUTBOX_TABLE).insert({
      id, order_id: order.id, request_key: facts.requestKey, action: facts.action,
      amount_minor: facts.amount, currency_code: facts.currencyCode,
      order_snapshot: JSON.stringify(snapshot), depends_on_request_key: previous?.request_key || null,
    }).returning("*")
    await trx("order").where({ id: order.id }).update({ metadata: JSON.stringify(next), updated_at: new Date() })
    return { posting, metadata: next, replayed: false }
  })
}

export async function retryQbdPosting(db: any, orderId: string, requestKey: string, audit?: (current: Record<string, any>) => Record<string, any>) {
  return db.transaction(async (trx: any) => {
    const order = await trx("order").where({ id: orderId }).whereNull("deleted_at").forUpdate().first("metadata")
    const posting = await trx(QBD_OUTBOX_TABLE).where({ order_id: orderId, request_key: requestKey }).forUpdate().first()
    if (!order || !posting || !["failed", "blocked"].includes(posting.status)) {
      throw new QbdPostingConflict("Select a failed or blocked durable accounting action. Legacy requests need reconciliation.")
    }
    await trx(QBD_OUTBOX_TABLE).where({ id: posting.id }).update({ status: "pending", retry_generation: Number(posting.retry_generation) + 1,
      available_at: new Date(), lease_id: null, leased_until: null, updated_at: new Date() })
    const current = qbdMetadata(order.metadata)
    const metadata = audit ? audit(current) : current
    if (metadata.qbd_posting_request_key === requestKey) {
      Object.assign(metadata, { qbd_posting_required: true, qbd_posting_status: "pending_manual", qbd_posting_error: null })
    }
    await trx("order").where({ id: orderId }).update({ metadata: JSON.stringify(metadata), updated_at: new Date() })
    return metadata
  })
}

export async function listQbdPostings(db: any, orderId: string) {
  return db(QBD_OUTBOX_TABLE).where({ order_id: orderId }).select("id", "request_key", "action", "amount_minor", "currency_code", "status",
    "depends_on_request_key", "bridge_job_id", "receipt", "last_error", "retry_generation", "created_at", "posted_at")
    .orderBy("sequence", "desc").limit(100)
}

type QbdTransaction = { kind: string; txn_id: string }
export type QbdPostingReceipt = {
  request_key: string
  bridge_job_id: string
  status: "posted" | "failed"
  transactions?: QbdTransaction[]
  error?: string
  retry_generation?: number
  no_effect_reason?: string
}

/** A receipt changes only its own action; the latest display slot is not the action identity. */
export async function acknowledgeQbdPosting(db: any, orderId: string, receipt: QbdPostingReceipt) {
  if (!text(receipt.request_key) || !text(receipt.bridge_job_id) || !["posted", "failed"].includes(receipt.status)) {
    throw new QbdPostingConflict("Invalid accounting receipt.")
  }
  return db.transaction(async (trx: any) => {
    // Use the same lock order as producers, to avoid producer/receipt deadlocks.
    const order = await trx("order").where({ id: orderId }).whereNull("deleted_at").forUpdate().first("metadata")
    const posting = await trx(QBD_OUTBOX_TABLE).where({ order_id: orderId, request_key: receipt.request_key }).forUpdate().first()
    if (!order || !posting) throw new QbdPostingConflict("Unknown accounting action; legacy work requires reconciliation.")
    if (posting.bridge_job_id && posting.bridge_job_id !== receipt.bridge_job_id) throw new QbdPostingConflict("Receipt identifies a different bridge job.")
    if ((receipt.retry_generation ?? 0) !== Number(posting.retry_generation)) throw new QbdPostingConflict("Receipt belongs to a different accounting retry.")
    const transactions = receipt.transactions || []
    const noEffect = (posting.action === "close_sales_order" && receipt.no_effect_reason === "canceled_before_sales_order")
      || (posting.action === "append_order_note" && receipt.no_effect_reason === "note_merged_into_pending_sales_order")
    if (receipt.status === "posted") {
      if ((!transactions.length && !noEffect) || transactions.some((entry) => !text(entry.kind) || !text(entry.txn_id))) {
        throw new QbdPostingConflict("Posting success requires QuickBooks transaction receipts.")
      }
      const kinds = new Set(transactions.map((entry) => entry.kind))
      if (posting.action === "final_card_charge_accounting_record" && (!kinds.has("invoice") || !kinds.has("payment"))) {
        throw new QbdPostingConflict("A final card charge needs both invoice and applied-payment receipts.")
      }
      if (posting.action === "invoice_ar_accounting_record" && !kinds.has("invoice")) {
        throw new QbdPostingConflict("The invoice receipt is missing.")
      }
    }
    if (posting.status === "posted") {
      if (receipt.status !== "posted" || JSON.stringify(posting.receipt?.transactions) !== JSON.stringify(transactions)
        || posting.receipt?.no_effect_reason !== receipt.no_effect_reason
        || posting.bridge_job_id !== receipt.bridge_job_id) {
        throw new QbdPostingConflict("A completed accounting receipt cannot be replaced.")
      }
      return { posting, replayed: true }
    }
    const now = new Date()
    await trx(QBD_OUTBOX_TABLE).where({ id: posting.id }).update({
      status: receipt.status, bridge_job_id: receipt.bridge_job_id,
      receipt: JSON.stringify(receipt), posted_at: receipt.status === "posted" ? now : null,
      last_error: receipt.status === "failed" ? text(receipt.error).slice(0, 500) : null,
      lease_id: null, leased_until: null, updated_at: now,
    })
    const metadata = qbdMetadata(order.metadata)
    const invoice = transactions.find((entry) => entry.kind === "invoice")
    if (invoice) metadata.qbd_invoice_txn_id = invoice.txn_id
    if (text(metadata.qbd_posting_request_key) === receipt.request_key) {
      Object.assign(metadata, {
        qbd_posting_required: receipt.status !== "posted", qbd_posting_status: receipt.status,
        qbd_write_job_id: receipt.bridge_job_id, qbd_posting_error: receipt.error || null,
        ...(receipt.status === "posted" ? { qbd_posted_at: now.toISOString(), qbd_txn_id: transactions[0]?.txn_id || null,
          qbd_posting_no_effect_reason: receipt.no_effect_reason || null } : {}),
      })
    }
    await trx("order").where({ id: orderId }).update({ metadata: JSON.stringify(metadata), updated_at: now })
    return { posting: { ...posting, status: receipt.status }, replayed: false }
  })
}

/** Read-only cutover report. It intentionally offers no replay switch. */
export async function untrackedQbdPostings(db: any, limit = 100) {
  return db("order as o").select("o.id", "o.metadata")
    .whereNull("o.deleted_at")
    .whereRaw("o.metadata->>'qbd_posting_required' = 'true'")
    .whereRaw("o.metadata->>'qbd_posting_status' in ('pending', 'pending_manual', 'queued', 'failed')")
    .whereNotExists(db(QBD_OUTBOX_TABLE + " as p").select(db.raw("1"))
      .whereRaw("p.order_id = o.id and p.request_key = o.metadata->>'qbd_posting_request_key'"))
    .orderBy("o.id").limit(Math.max(1, Math.min(limit, 1000)))
    .then((rows: any[]) => rows.map((row) => ({
      order_id: row.id, request_key: qbdMetadata(row.metadata).qbd_posting_request_key || null,
      action: qbdMetadata(row.metadata).qbd_posting_action || null,
      status: qbdMetadata(row.metadata).qbd_posting_status || null,
    })))
}
