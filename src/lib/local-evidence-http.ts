import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { LocalEvidenceError } from "./local-evidence-contract"
import { configuredEvidenceRetention, PgLocalEvidenceStorage } from "./local-evidence-storage"
import { resolveStaffPrincipal, StaffAccessDenied, type StaffPrincipal } from "./staff-principal"
import { GP_LOCAL_EVIDENCE_MODULE } from "../modules/gp-local-evidence"
import type GpLocalEvidenceFileService from "../modules/gp-local-evidence/service"

export function requireEvidenceEnabled() {
  if (process.env.GP_LOCAL_MILESTONES_ENABLED !== "true")
    throw new LocalEvidenceError("local_milestones_disabled")
}

async function mayReadOrder(db: any, actor: StaffPrincipal, orderId: string) {
  if (actor.kind === "service") return false
  const state = await db("gp_local_milestone_state").where({ order_id: orderId }).first()
  if (!state || state.mode !== "local_delivery") return false
  if (actor.kind === "operator" || (actor.capabilities as Set<string>).has("milestones.office")) return true
  return (actor.capabilities as Set<string>).has("milestones.drive") && state.driver_customer_id === actor.id
}

export async function authorizedEvidence(req: MedusaRequest, orderId: string) {
  requireEvidenceEnabled()
  const actor = await resolveStaffPrincipal(req)
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  if (!await mayReadOrder(db, actor, orderId))
    throw new StaffAccessDenied("Delivery evidence is unavailable for this order.")
  const provider = req.scope.resolve(GP_LOCAL_EVIDENCE_MODULE) as GpLocalEvidenceFileService
  const storage = new PgLocalEvidenceStorage(db, provider, actor.id,
    async (actorId, storedOrderId) => actorId === actor.id && storedOrderId === orderId &&
      mayReadOrder(db, actor, storedOrderId), configuredEvidenceRetention())
  return { storage, actor }
}

export function evidenceFailure(res: MedusaResponse, error: unknown) {
  if (error instanceof StaffAccessDenied) return res.status(403).json({ message: "Delivery evidence access denied." })
  if (error instanceof LocalEvidenceError) {
    const code = error.code
    const status = code === "local_milestones_disabled" || code === "evidence_upload_not_found" ? 404
      : code === "evidence_access_denied" ? 403
      : code === "evidence_upload_id_conflict" ? 409
      : code === "invalid_evidence_upload" || code === "evidence_content_mismatch" ||
        code === "unsupported_evidence_bytes" || code === "invalid_evidence_link_lifetime" ||
        code === "evidence_too_large" ? 422 : 503
    return res.status(status).json({ message: code })
  }
  return res.status(503).json({ message: "Delivery evidence is unavailable. Retry the same upload ID after checking its status." })
}

/** No body parser handles image/*; this bounds the raw stream even for chunked uploads. */
export async function readEvidenceBytes(req: MedusaRequest, expectedSize: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of req as unknown as AsyncIterable<Buffer>) {
    const chunk = Buffer.from(value)
    size += chunk.length
    if (size > 10 * 1024 * 1024 || size > expectedSize)
      throw new LocalEvidenceError("evidence_too_large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
