import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { requestStaffPrincipal } from "../../../../../lib/staff-principal"
import {
  C03ProtectionInputError,
  protectC03UnsubscribedFromContainer,
} from "../../../../../lib/communications/cc-protective-suppression"
import { emitAdminCommunicationsRouteFailureAlert } from "../_shared/alerts"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const actor = requestStaffPrincipal(req)
  if (!actor || actor.kind === "service" || actor.role !== "super_admin") {
    res.status(403).json({ ok: false, error: "super_admin_required" })
    return
  }
  try {
    const result = await protectC03UnsubscribedFromContainer(
      req.scope,
      (req.body as Record<string, unknown> | undefined)?.destinations,
      actor.id
    )
    res.status(200).json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof C03ProtectionInputError) {
      res.status(400).json({ ok: false, error: error.message })
      return
    }
    await emitAdminCommunicationsRouteFailureAlert({
      req,
      action: "protect_c03_unsubscribed",
      error,
      meta: { target_count: 117 },
    })
    res.status(500).json({ ok: false, error: "c03_protection_failed" })
  }
}
