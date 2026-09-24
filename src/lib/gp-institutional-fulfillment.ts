/** Final shipment gate for a flagged invoice order. A release marker on the
 * Medusa order alone is not enough: the packed finalization and durable credit
 * commitment must agree on the same amount. Unknown state holds fulfillment.
 */
type Db = (table: string) => any

type Decision =
  | { status: "allow" }
  | { status: "hold"; reason: string }

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value !== ""
    ? value : null
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value) : value
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed : null
}

function dollarsToCents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  const dollars = Number(value)
  if (!Number.isFinite(dollars) || dollars < 0) return null
  const cents = Math.round(dollars * 100)
  return Number.isSafeInteger(cents) && Math.abs(dollars * 100 - cents) < 0.000001
    ? cents : null
}

export async function institutionalFulfillmentDecision(input: {
  db: Db
  order: { id?: unknown; cart_id?: unknown; metadata?: Record<string, unknown> | null }
}): Promise<Decision> {
  const orderId = text(input.order.id)
  const cartId = text(input.order.cart_id)
  const metadata = input.order.metadata || {}
  const commitmentId = text(metadata.gp_institutional_commitment_id)
  if (!orderId || !cartId || commitmentId !== `cart:${cartId}` ||
      metadata.payment_workflow !== "invoice_ar" ||
      metadata.finalization_status !== "released_to_fulfillment" ||
      metadata.fulfillment_gate_status !== "released" ||
      metadata.qbd_posting_action !== "invoice_ar_accounting_record" ||
      metadata.qbd_posting_request_key !== `invoice_ar:${orderId}` ||
      !["pending", "pending_manual", "queued", "posted"].includes(String(metadata.qbd_posting_status))) {
    return { status: "hold", reason: "invoice_release_unverified" }
  }
  const postedAmount = integer(metadata.qbd_posting_amount)
  if (postedAmount === null) return { status: "hold", reason: "invoice_amount_unverified" }

  const finalizations = await input.db("gp_order_finalization")
    .where({ order_id: orderId })
    .whereNull("deleted_at")
  const commitments = await input.db("gp_institutional_credit_commitment")
    .where({ order_id: commitmentId })
    .whereNull("deleted_at")
  if (!Array.isArray(finalizations) || finalizations.length !== 1 ||
      !Array.isArray(commitments) || commitments.length !== 1) {
    return { status: "hold", reason: "invoice_release_rows_unverified" }
  }
  const finalization = finalizations[0]
  const commitment = commitments[0]
  const finalCents = dollarsToCents(finalization.final_order_total)
  if (finalization.status !== "released_to_fulfillment" ||
      !text(commitment.company_key) || !text(commitment.customer_list_id) ||
      !["accepted", "posting", "posted"].includes(String(commitment.state)) ||
      finalCents === null || finalCents !== postedAmount ||
      integer(commitment.amount_cents) !== finalCents) {
    return { status: "hold", reason: "invoice_credit_or_finalization_mismatch" }
  }
  return { status: "allow" }
}
