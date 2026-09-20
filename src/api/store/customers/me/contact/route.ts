import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { changePrimaryContact, ContactChangeError, parseContactChange } from "../../../../../lib/customer-primary-contact"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const actor = (req as any).auth_context
  if (!actor?.actor_id || actor.actor_type !== "customer") {
    res.status(401).json({ message: "Please sign in again." }); return
  }
  try {
    const input = parseContactChange(req.body)
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    res.status(200).json(await changePrimaryContact(db, actor.actor_id, input))
  } catch (error) {
    if (error instanceof ContactChangeError) {
      res.status(error.status).json({ code: error.code, message: error.message }); return
    }
    // Database errors can contain contact details; never echo them.
    res.status(503).json({ code: "contact_unavailable", message: "We could not save your contact details. Please try again." })
  }
}
