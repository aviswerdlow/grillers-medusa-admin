import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { listLegacyPurchaseHistoryForCustomer } from "../../../../lib/legacy-order-history"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const customerId = (req as any).auth_context?.actor_id
  if (!customerId) {
    res.status(401).json({ message: "Unauthorized" })
    return
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const purchaseHistory = await listLegacyPurchaseHistoryForCustomer(
    db,
    customerId
  )

  res.json({ purchase_history: purchaseHistory })
}
