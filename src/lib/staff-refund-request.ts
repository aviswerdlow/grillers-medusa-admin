import { createHash, randomUUID } from "node:crypto"
import { QbdPostingConflict } from "./qbd-posting-outbox"

export const STAFF_REFUND_REQUEST_TABLE = "gp_staff_refund_request"

export function refundRequestKey(req: any): string {
  const value = req.headers?.["idempotency-key"] || req.headers?.["Idempotency-Key"] || req.get?.("Idempotency-Key")
  if (typeof value !== "string" || !value.trim() || value.length > 250) {
    throw new QbdPostingConflict("A stable Idempotency-Key is required before issuing a refund.")
  }
  return value.trim()
}

type RefundRequestInput = {
  orderId: string; paymentId: string; requestKey: string; amount?: number; currencyCode: string
  note?: string; reasonId?: string; allocationLines?: Array<{ line_item_id: string; quantity: number }>
}

function fingerprintFor(input: RefundRequestInput) {
  return createHash("sha256").update(JSON.stringify([
    input.paymentId, input.amount ?? null, input.currencyCode.toLowerCase(), input.note || "", input.reasonId || "",
    [...(input.allocationLines || [])].sort((a, b) => a.line_item_id.localeCompare(b.line_item_id)),
  ])).digest("hex")
}

export async function existingStaffRefundRequest(db: any, input: RefundRequestInput) {
  const previous = await db(STAFF_REFUND_REQUEST_TABLE).where({ order_id: input.orderId, request_key: input.requestKey }).first()
  if (!previous) return null
  if (previous.fingerprint !== fingerprintFor(input)) throw new QbdPostingConflict("The refund request key was already used with different details.")
  if (previous.status === "succeeded") return { id: previous.id, replay: previous.response }
  throw new QbdPostingConflict("This refund is in progress or needs reconciliation. Do not submit another refund until its provider and accounting records are checked.")
}

/** One provider attempt per intent. A timeout is an unknown result, never permission to refund again. */
export async function claimStaffRefundRequest(db: any, input: RefundRequestInput) {
  const fingerprint = fingerprintFor(input)
  return db.transaction(async (trx: any) => {
    const order = await trx("order").where({ id: input.orderId }).whereNull("deleted_at").forUpdate().first("id")
    if (!order) throw new QbdPostingConflict("Refund order was not found.")
    const previous = await existingStaffRefundRequest(trx, input)
    if (previous) return previous
    const unresolved = await trx(STAFF_REFUND_REQUEST_TABLE).where({ order_id: input.orderId }).whereNot({ status: "succeeded" }).first("id")
    if (unresolved) throw new QbdPostingConflict("An earlier refund on this order needs reconciliation before another refund can be issued.")
    const id = `refundreq_${randomUUID()}`
    await trx(STAFF_REFUND_REQUEST_TABLE).insert({ id, order_id: input.orderId, payment_id: input.paymentId,
      request_key: input.requestKey, fingerprint, status: "started",
      request_details: JSON.stringify({ amount: input.amount ?? null, currency_code: input.currencyCode,
        note: input.note || null, refund_reason_id: input.reasonId || null, allocation_lines: input.allocationLines || [] }),
    })
    return { id, replay: null }
  })
}

export async function recordStaffRefundProvider(db: any, id: string, providerRefundId: string) {
  await db(STAFF_REFUND_REQUEST_TABLE).where({ id, status: "started" }).update({ provider_refund_id: providerRefundId, updated_at: new Date() })
}

export async function completeStaffRefundRequest(db: any, id: string, response: Record<string, any>) {
  await db(STAFF_REFUND_REQUEST_TABLE).where({ id, status: "started" }).update({ status: "succeeded", response: JSON.stringify(response), updated_at: new Date() })
}

export async function requireStaffRefundReconciliation(db: any, id: string) {
  await db(STAFF_REFUND_REQUEST_TABLE).where({ id, status: "started" }).update({ status: "reconcile", updated_at: new Date() })
}
