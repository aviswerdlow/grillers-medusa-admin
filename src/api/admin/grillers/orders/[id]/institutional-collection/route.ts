import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { readInstitutionalBridgeAccount } from "../../../../../../lib/gp-institutional-source"
import { projectInstitutionalOrderCollection } from "../../../../../../lib/gp-institutional-collection-projection"

function id(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.trim() === value ? value : null
}

function cents(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Staff-only read of one order's exact QBD collection evidence. No QBD write. */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") {
    return res.status(200).json({ status: "disabled" })
  }
  const orderId = id(req.params.id)
  if (!orderId) return res.status(400).json({ status: "order_id_required" })
  try {
    const orderModule = req.scope.resolve(Modules.ORDER)
    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "customer_id", "metadata"],
    })
    const customerId = id(order?.customer_id)
    if (order?.id !== orderId || order.metadata?.payment_workflow !== "invoice_ar" ||
        !customerId) {
      return res.status(404).json({ status: "institutional_order_not_found" })
    }
    const metadata = order.metadata as Record<string, unknown>
    const commitmentId = id(metadata.gp_institutional_commitment_id)
    if (!commitmentId) return res.status(503).json({ status: "commitment_unavailable" })

    const bridge = await readInstitutionalBridgeAccount(customerId)
    const expectedCompany = process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 || ""
    const ageSeconds = Number(process.env.GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS || "900")
    const ageMs = Number.isSafeInteger(ageSeconds) && ageSeconds >= 60 && ageSeconds <= 3600
      ? ageSeconds * 1000 : 0
    const readTime = Date.parse(bridge.snapshot?.lastSuccess || "")
    if (bridge.sourceStatus !== "success" || !bridge.link || !bridge.snapshot ||
        !bridge.readbacks || bridge.link.status !== "verified" ||
        bridge.link.companyKey !== expectedCompany ||
        bridge.link.customerListId !== bridge.snapshot.customerListId ||
        bridge.link.medusaCustomerId !== customerId ||
        !ageMs || !Number.isFinite(readTime) || readTime > Date.now() ||
        Date.now() - readTime > ageMs) {
      return res.status(503).json({ status: "source_unavailable" })
    }

    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const commitments = await db("gp_institutional_credit_commitment")
      .where({
        order_id: commitmentId,
        company_key: bridge.link.companyKey,
        customer_list_id: bridge.link.customerListId,
      })
      .whereNull("deleted_at")
    if (!Array.isArray(commitments) || commitments.length !== 1) {
      return res.status(503).json({ status: "commitment_unavailable" })
    }
    if (commitments[0].state === "quarantined") {
      return res.status(200).json({ status: "quarantined", reason: "commitment_quarantined" })
    }
    const acceptedCents = cents(commitments[0].amount_cents)
    if (acceptedCents === null) {
      return res.status(503).json({ status: "commitment_unavailable" })
    }
    const posted = metadata.qbd_posting_status === "posted"
    const invoiceTxnId = posted ? id(metadata.qbd_txn_id) : null
    const finalCents = posted ? cents(metadata.qbd_posting_amount) : null
    if (posted && (!invoiceTxnId || finalCents === null) ||
        !posted && id(metadata.qbd_txn_id)) {
      return res.status(503).json({ status: "posting_receipt_unavailable" })
    }
    const collection = projectInstitutionalOrderCollection({
      orderId,
      acceptedCents,
      invoiceTxnId,
      finalCents,
      readbacks: bridge.readbacks,
      cancelled: commitments[0].state === "cancelled",
    })
    return res.status(200).json({
      status: collection.status,
      collection,
      source: {
        revision: bridge.snapshot.sourceRevision,
        lastSuccess: bridge.snapshot.lastSuccess,
      },
      invoiceTxnId,
    })
  } catch {
    return res.status(503).json({ status: "collection_unavailable" })
  }
}
