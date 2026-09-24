import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { resolveStaffPrincipal, StaffAccessDenied } from "./staff-principal"
import { LocalMilestoneError, requireLocalMilestonesEnabled } from "./local-milestones"

export async function localMilestoneRequest(
  req: MedusaRequest,
  res: MedusaResponse,
  operation: (db: any, actor: Awaited<ReturnType<typeof resolveStaffPrincipal>>) => Promise<unknown>
) {
  try {
    requireLocalMilestonesEnabled()
    // The shared #318 boundary may still run in observation mode. These routes
    // require an approved named principal even while that rollout is in log mode.
    const actor = await resolveStaffPrincipal(req)
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    return res.status(200).json(await operation(db, actor))
  } catch (error) {
    if (error instanceof LocalMilestoneError) return res.status(error.status).json({ code: error.code })
    if (error instanceof StaffAccessDenied) return res.status(403).json({ code: "local_milestone_access_denied" })
    return res.status(503).json({ code: "local_milestone_unavailable" })
  }
}
