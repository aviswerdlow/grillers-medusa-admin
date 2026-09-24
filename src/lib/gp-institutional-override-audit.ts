import { randomUUID } from "node:crypto"

const code = (value: unknown, fallback: string) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(value)
    ? value : fallback

/** Persist a denied staff release attempt after the finalization transaction
 * rolls back. #360 has no named override capability, so no override is granted.
 */
export async function recordDeniedInstitutionalRelease(input: {
  db: any
  orderId: string
  actorId: string | null
  requestedReason: unknown
  authorityReason: unknown
}): Promise<void> {
  if (typeof input.orderId !== "string" || !/^order_[A-Za-z0-9_-]+$/.test(input.orderId)) {
    throw new Error("Cannot audit institutional release without a stable order ID")
  }
  await input.db("gp_institutional_override_attempt").insert({
    id: randomUUID(),
    order_id: input.orderId,
    actor_id: input.actorId,
    reason_code: code(input.requestedReason, "staff_clicked_release"),
    authority_reason: code(input.authorityReason, "source_hold"),
    named_capability: null,
    decision: "denied",
  })
}
