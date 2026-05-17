import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { listLegacyOrders } from "../../../lib/legacy-order-history"

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value[0] === undefined ? undefined : String(value[0])
  }
  return value === undefined ? undefined : String(value)
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const result = await listLegacyOrders(db, {
    q: firstQueryValue(req.query.q),
    email: firstQueryValue(req.query.email),
    customerId:
      firstQueryValue(req.query.customer_id) ||
      firstQueryValue(req.query.medusa_customer_id),
    qbdCustomerListId: firstQueryValue(req.query.qbd_customer_list_id),
    legacyCustomerId: firstQueryValue(req.query.legacy_customer_id),
    limit: Number(firstQueryValue(req.query.limit)),
    offset: Number(firstQueryValue(req.query.offset)),
  })

  res.json(result)
}
