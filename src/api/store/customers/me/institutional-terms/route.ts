import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { readInstitutionalStatus } from "../../../../../lib/gp-institutional-status"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = (req as any).auth_context?.actor_id
  if (typeof customerId !== "string" || !customerId) {
    return res.status(401).json({ status: "denied", reason: "customer_auth_required" })
  }
  const result = await readInstitutionalStatus(customerId)
  return res.status(200).json(result.customer)
}
