import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { readInstitutionalStatus } from "../../../../../../lib/gp-institutional-status"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = req.params.id
  if (typeof customerId !== "string" || !customerId) {
    return res.status(400).json({ status: "denied", reason: "customer_id_required" })
  }
  const result = await readInstitutionalStatus(customerId)
  return res.status(200).json(result.staff)
}
