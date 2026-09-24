import { verifiedStaffActorId } from "../../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { updateCommunicationFlow } from "../../../../../../lib/communications/flows"
import { emitAdminCommunicationsRouteFailureAlert } from "../../_shared/alerts"

/** Console flow editor: PATCH name/description/status/steps by flow key. */
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Record<string, any>
  const key = String(req.params.key || "")
  try {
    const flow = await updateCommunicationFlow(req.scope, key, {
      name: body.name,
      description: body.description,
      status: body.status,
      steps: body.steps,
      trigger_conditions: body.trigger_conditions,
      edited_by: verifiedStaffActorId(req) || null,
    })
    res.status(200).json({ flow })
  } catch (error) {
    const message = error instanceof Error ? error.message : "flow_update_failed"
    // Validation problems are the operator's to fix — return them readable.
    if (/step |name |Status |not found/i.test(message)) {
      res.status(400).json({ error: message })
      return
    }
    await emitAdminCommunicationsRouteFailureAlert({
      req,
      action: "update_flow",
      error,
      meta: { flow_key: key },
    })
    res.status(500).json({ ok: false, error: "flow_update_failed" })
  }
}
