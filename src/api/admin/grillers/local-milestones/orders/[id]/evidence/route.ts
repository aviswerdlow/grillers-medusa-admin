import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { authorizedEvidence, evidenceFailure } from "../../../../../../../lib/local-evidence-http"

/** Metadata only; object keys and unguarded URLs are never returned. */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { storage } = await authorizedEvidence(req, req.params.id)
    return res.json({ evidence: await storage.listOrder(req.params.id) })
  } catch (error) {
    return evidenceFailure(res, error)
  }
}
