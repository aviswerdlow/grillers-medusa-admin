import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { isProtectedContactKey } from "../../lib/customer-contact-state"

/** Native profile writes cannot bypass the atomic destination/consent path. */
export function guardCustomerContactWrite(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const body = (req.body || {}) as Record<string, any>
  if (body.phone !== undefined || (body.metadata !== undefined &&
      (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata) ||
       Object.keys(body.metadata).some(isProtectedContactKey)))) {
    res.status(409).json({ code: "use_contact_confirmation", message: "Use the account contact form to update your phone or text preferences." }); return
  }
  return next()
}

/** Public signup cannot manufacture import history or confirmation stamps. */
export function guardCustomerProvenanceCreate(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const body = (req.body || {}) as Record<string, any>
  const keys = Object.keys(body.metadata || {})
  if (keys.some((k) => isProtectedContactKey(k) && !k.startsWith("sms_"))) {
    res.status(400).json({ message: "Invalid account metadata." }); return
  }
  return next()
}
