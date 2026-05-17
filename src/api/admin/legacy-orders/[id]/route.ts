import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { retrieveLegacyOrder } from "../../../../lib/legacy-order-history"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const id = String(req.params.id)
  const order = await retrieveLegacyOrder(db, id)

  if (!order) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Legacy order ${id} was not found`
    )
  }

  res.json({ order })
}
