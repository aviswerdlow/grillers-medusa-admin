import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { staffBoundaryMode } from "../../../../lib/staff-boundary-rollout"
// The global admin transport authentication and capability map still apply.
export const GET = (_req: MedusaRequest, res: MedusaResponse) => res.json({ staff_boundary_mode: staffBoundaryMode() })
