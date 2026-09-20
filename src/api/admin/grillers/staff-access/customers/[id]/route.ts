import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { changeStaffRole, InvalidStaffRoleChange, StaffRoleChangeConflict } from "../../../../../../lib/staff-role-change"
import { requestStaffPrincipal, StaffAccessDenied } from "../../../../../../lib/staff-principal"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const principal = requestStaffPrincipal(req)
    if (!principal) throw new StaffAccessDenied("Verified staff access is required.")
    const result = await changeStaffRole(req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION), principal, req.params.id, (req.body || {}) as Record<string, any>)
    return res.status(200).json(result)
  } catch (error) {
    const known = error instanceof StaffAccessDenied || error instanceof InvalidStaffRoleChange || error instanceof StaffRoleChangeConflict
    return res.status(error instanceof StaffAccessDenied ? 403 : error instanceof InvalidStaffRoleChange ? 422 : error instanceof StaffRoleChangeConflict ? 409 : 503)
      .json({ message: known ? (error as Error).message : "Staff access was not confirmed. Refresh the account before retrying." })
  }
}
