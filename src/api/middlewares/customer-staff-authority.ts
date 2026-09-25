import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { isDeepStrictEqual } from "node:util"
import { isStaffAuthorityMetadataKey } from "../../lib/staff-access-policy"
import { staffRequestPath } from "../../lib/staff-request-path"

/** Runs on Store customer creation and self-service updates, never Admin writes. */
export async function protectCustomerStaffAuthority(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  // Inspect both representations: native validation may run before or after
  // this middleware. Neither representation may hide a protected-field change.
  const patches: Array<{ body: Record<string, any>; metadata: Record<string, any> }> = []
  for (const body of new Set([req.body, (req as any).validatedBody])) {
    if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "metadata")) continue
    const metadata = (body as Record<string, unknown>).metadata
    if (metadata === undefined) continue
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return res.status(400).json({
        type: "invalid_data",
        message: "Send account metadata as an object. Removing all account metadata is not supported.",
      })
    }
    if (Object.keys(metadata).some(isStaffAuthorityMetadataKey)) patches.push({ body, metadata })
  }
  if (!patches.length) return next()
  const deny = () => res.status(403).json({
    type: "not_allowed",
    message: "Staff access and audit fields can only be changed through authorized staff administration.",
  })
  const auth = (req as any).auth_context
  // Creation never accepts authority. Self-service full snapshots may echo
  // existing fields only after native customer authentication has run.
  if (req.method !== "POST" || staffRequestPath(req) !== "/store/customers/me"
    || auth?.actor_type !== "customer" || !auth.actor_id) return deny()
  let customer: any
  try {
    customer = await req.scope.resolve(Modules.CUSTOMER).retrieveCustomer(auth.actor_id, { select: ["id", "metadata"] })
  } catch {
    return res.status(503).json({ type: "account_verification_unavailable", message: "Account settings could not be verified. Please try again." })
  }
  if (customer?.id !== auth.actor_id) return deny()
  const current = customer.metadata || {}
  for (const { metadata } of patches) {
    if (Object.entries(metadata).some(([key, value]) => isStaffAuthorityMetadataKey(key)
      && (!Object.prototype.hasOwnProperty.call(current, key) || !isDeepStrictEqual(value, current[key])))) return deny()
  }
  // Installed Medusa merges metadata keys at persistence. Omit the echoed
  // authority instead of replaying it over a later role, note or credit update.
  // Validate both representations before changing either one.
  for (const { body, metadata } of patches) {
    body.metadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => !isStaffAuthorityMetadataKey(key)))
  }
  return next()
}
