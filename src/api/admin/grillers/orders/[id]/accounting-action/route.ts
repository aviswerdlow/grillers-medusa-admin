import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { assertQbdPostingReady, listQbdPostings, persistQbdPosting, QbdPostingConflict, qbdMetadata, retryQbdPosting } from "../../../../../../lib/qbd-posting-outbox"
import { appendQbdStaffAudit, loadQbdOrder, persistQbdOrderAudit } from "../../../../../../lib/qbd-order-metadata"

// Uses the existing authenticated admin boundary; it never executes a money action.
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const actions = await listQbdPostings(req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION), req.params.id)
    return res.status(200).json({ actions, limit: 100, may_be_truncated: actions.length === 100 })
  } catch {
    return res.status(503).json({ message: "Accounting history is unavailable; do not assume pending work is complete." })
  }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  try {
    const body = (req.body || {}) as Record<string, any>
    const patch = qbdMetadata(body.patch)
    const entry = qbdMetadata(body.entry)
    if (!entry.action || !req.params.id || req.params.id.startsWith("lgord_")) {
      return res.status(422).json({ message: "An active order and staff action are required." })
    }
    entry.staff_actor_id = (req as any).auth_context?.actor_id || null
    if (["refund_payment", "capture_payment", "cancel_order", "edit_order_items"].includes(entry.action) && entry.status === "requested") {
      await assertQbdPostingReady(db, req.params.id)
    }
    const order = await loadQbdOrder(req.scope.resolve(ContainerRegistrationKeys.QUERY), req.params.id)
    if (entry.action === "retry_qbd_posting") {
      const metadata = await retryQbdPosting(db, order.id, String(entry.qbd_posting_request_key || ""),
        (current) => appendQbdStaffAudit(current, {}, entry))
      return res.status(200).json({ order: { ...order, metadata } })
    }
    const enqueue = entry.status !== "requested" && entry.action !== "refund_payment"
      && patch.qbd_posting_required === true && ["pending", "pending_manual"].includes(patch.qbd_posting_status)
    if (entry.action === "refund_payment") {
      for (const key of Object.keys(patch)) if (key.startsWith("stripe_refund_") || key === "stripe_provider_refund_id") delete patch[key]
    }
    if (!enqueue) {
      // Preliminary requests and failures cannot erase or acknowledge earlier accounting work.
      for (const key of Object.keys(patch)) {
        if (key.startsWith("qbd_posting_") || ["qbd_write_job_id", "qbd_txn_id", "qbd_error"].includes(key)) delete patch[key]
      }
    }
    const buildMetadata = (current: Record<string, any>) => appendQbdStaffAudit(current, patch, entry)
    const metadata = enqueue
      ? (await persistQbdPosting({ db, order, buildMetadata })).metadata
      : await persistQbdOrderAudit(db, order.id, buildMetadata)
    return res.status(200).json({ order: { ...order, metadata } })
  } catch (error) {
    return res.status(error instanceof QbdPostingConflict ? 409 : 503).json({
      message: error instanceof QbdPostingConflict ? error.message : "Order accounting or audit could not be recorded. No accounting request was acknowledged.",
    })
  }
}
