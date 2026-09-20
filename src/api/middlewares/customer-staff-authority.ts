import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { isStaffAuthorityMetadataKey } from "../../lib/staff-access-policy"

/** Runs on Store customer creation and self-service updates, never Admin writes. */
export function protectCustomerStaffAuthority(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  // Inspect both representations: native validation may run before or after
  // this middleware. Neither a transformation nor a prevalidated body can hide
  // a protected field. No writes or authenticated-owner lookups are necessary.
  for (const body of [req.body, (req as any).validatedBody]) {
    if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "metadata")) continue
    const metadata = (body as Record<string, unknown>).metadata
    if (metadata === undefined) continue
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return res.status(400).json({
        type: "invalid_data",
        message: "Send account metadata as an object. Removing all account metadata is not supported.",
      })
    }
    if (Object.keys(metadata).some(isStaffAuthorityMetadataKey)) {
      return res.status(403).json({
        type: "not_allowed",
        message: "Staff access and audit fields can only be changed through authorized staff administration.",
      })
    }
  }
  return next()
}
