import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  hasPrimaryContactState,
  primaryContactEnabled,
} from "../../lib/customer-contact-rollout";
import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http";
import { isProtectedContactKey } from "../../lib/customer-contact-state";

/** Native profile writes cannot bypass the atomic destination/consent path. */
export async function guardCustomerContactWrite(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const body = ((req as any).validatedBody || req.body || {}) as Record<
    string,
    any
  >;
  // Never allow a legacy write to manufacture the new server-owned records.
  const attemptedState =
    body.metadata &&
    Object.keys(body.metadata).some((k) =>
      /^(primary_contact|contact_confirmation_v2|migration_provenance)/.test(k)
    );
  if (!primaryContactEnabled() && !attemptedState) {
    if (body.phone === undefined && body.metadata === undefined) return next();
    try {
      const actor = (req as any).auth_context;
      if (actor?.actor_type !== "customer" || !actor.actor_id) {
        res.status(401).json({ message: "Please sign in again." });
        return;
      }
      const customer = await req.scope
        .resolve(ContainerRegistrationKeys.PG_CONNECTION)("customer")
        .select("metadata")
        .where({ id: actor.actor_id })
        .whereNull("deleted_at")
        .first();
      if (!customer) {
        res.status(401).json({ message: "Please sign in again." });
        return;
      }
      if (!hasPrimaryContactState(customer.metadata)) return next();
    } catch {
      res
        .status(503)
        .json({
          message: "Contact details could not be checked. Please try again.",
        });
      return;
    }
  }
  if (
    body.phone !== undefined ||
    (body.metadata !== undefined &&
      (!body.metadata ||
        typeof body.metadata !== "object" ||
        Array.isArray(body.metadata) ||
        Object.keys(body.metadata).some(isProtectedContactKey)))
  ) {
    res
      .status(409)
      .json({
        code: "use_contact_confirmation",
        message:
          "Use the account contact form to update your phone or text preferences.",
      });
    return;
  }
  return next();
}

/** Public signup cannot manufacture import history or confirmation stamps. */
export function guardCustomerProvenanceCreate(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const body = (req.body || {}) as Record<string, any>;
  const keys = Object.keys(body.metadata || {});
  if (keys.some((k) => isProtectedContactKey(k) && !k.startsWith("sms_"))) {
    res.status(400).json({ message: "Invalid account metadata." });
    return;
  }
  return next();
}
