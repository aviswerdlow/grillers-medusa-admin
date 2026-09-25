import crypto from "crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { normalizeEmail } from "./core"

type KnexLike = any

// C03 sealed classification and the 117 unsubscribed, timestamped GP profiles.
// The target digest is SHA-256 of sorted, normalized addresses joined with LF,
// including a final LF. The addresses themselves remain in protected custody.
export const C03_CLASSIFICATION_SHA256 = "241d8980793a29a2423f71d7213c99ab5e0a9c155f13d5f683b3bec5968d947f"
export const C03_UNSUBSCRIBED_TARGET_SHA256 = "871d194df36e418d5df503efd85ef0bdfe9a039a8e273e91a724376d754e284f"
export const C03_PROTECTION_BATCH_ID = "c03-2026-09-24-117-cc-unsubscribed"
const SOURCE = "constant_contact_protective_suppression"
const REASON = "constant_contact_unsubscribe"
type ProtectionSpec = { count: number; targetSha256: string; classificationSha256: string; batchId: string }
const C03_SPEC: ProtectionSpec = {
  count: 117,
  targetSha256: C03_UNSUBSCRIBED_TARGET_SHA256,
  classificationSha256: C03_CLASSIFICATION_SHA256,
  batchId: C03_PROTECTION_BATCH_ID,
}

export class C03ProtectionInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "C03ProtectionInputError"
  }
}

export function planC03ProtectiveSuppression(addresses: unknown, spec: ProtectionSpec = C03_SPEC) {
  if (!Array.isArray(addresses) || addresses.length !== spec.count ||
      addresses.some((value) => typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))) {
    throw new C03ProtectionInputError(`Exactly ${spec.count} valid email destinations are required`)
  }
  const emails = addresses.map((value: string) => normalizeEmail(value)).sort()
  if (new Set(emails).size !== spec.count) {
    throw new C03ProtectionInputError("Duplicate destination in protected batch")
  }
  const targetSha256 = crypto.createHash("sha256").update(`${emails.join("\n")}\n`).digest("hex")
  if (targetSha256 !== spec.targetSha256) {
    throw new C03ProtectionInputError("Protected C03 destination digest mismatch")
  }
  return { emails, targetSha256 }
}

async function activeMarketingCount(trx: KnexLike, emails: string[]) {
  const rows = await trx("gp_suppression_preference")
    .whereNull("deleted_at")
    .whereNull("resubscribed_at")
    .whereNull("topic")
    .where("scope", "marketing")
    .whereIn("email_lower", emails)
    .select("email_lower")
  return new Set(rows.map((row: { email_lower: string }) => row.email_lower)).size
}

/** Narrow, audited one-time protection. No profile, consent, SMS, event or flow writes. */
export async function protectC03UnsubscribedDestinations(
  db: KnexLike,
  addresses: unknown,
  actorId: string,
  spec: ProtectionSpec = C03_SPEC
) {
  const plan = planC03ProtectiveSuppression(addresses, spec)
  if (!actorId) throw new C03ProtectionInputError("Verified staff actor is required")

  return db.transaction(async (trx: KnexLike) => {
    const now = new Date()
    const audit = {
      id: `gpimprt_${crypto.randomUUID()}`,
      source: SOURCE,
      batch_id: spec.batchId,
      status: "running",
      started_at: now,
      metadata: {
        actor_id: actorId,
        classification_sha256: spec.classificationSha256,
        target_sha256: plan.targetSha256,
        reason: REASON,
        scope: "marketing",
        target_count: spec.count,
      },
      created_at: now,
      updated_at: now,
    }
    const insertedAudit = await trx("gp_import_run")
      .insert(audit).onConflict().ignore().returning("id")
    if (!insertedAudit.length) {
      const prior = await trx("gp_import_run")
        .where({ source: SOURCE, batch_id: spec.batchId }).first()
      if (prior?.status !== "completed" || prior?.metadata?.target_sha256 !== plan.targetSha256 ||
          prior?.metadata?.classification_sha256 !== spec.classificationSha256) {
        throw new Error("C03 protection batch identity has conflicting or incomplete history")
      }
      return {
        audit_run_id: prior.id,
        target_count: spec.count,
        before_count: Number(prior.stats?.before_count),
        after_count: Number(prior.stats?.after_count),
        inserted_count: Number(prior.imported_count),
        replayed: true,
      }
    }

    const profiles = await trx("gp_customer_profile")
      .whereNull("deleted_at")
      .whereIn("email_lower", plan.emails)
      .select("id", "email", "email_lower")
    const byEmail = new Map<string, { id: string; email: string }>()
    for (const profile of profiles) {
      if (byEmail.has(profile.email_lower)) {
        throw new Error("C03 destination has multiple active GP profiles")
      }
      byEmail.set(profile.email_lower, profile)
    }
    if (byEmail.size !== spec.count) throw new Error("C03 destination no longer resolves to exactly one active GP profile")

    const beforeCount = await activeMarketingCount(trx, plan.emails)
    let insertedCount = 0
    for (const email of plan.emails) {
      const profile = byEmail.get(email)!
      const inserted = await trx("gp_suppression_preference")
        .insert({
          id: `gpsupp_${crypto.randomUUID()}`,
          email: profile.email,
          email_lower: email,
          profile_id: profile.id,
          scope: "marketing",
          topic: null,
          reason: REASON,
          source: "constant_contact",
          unsubscribed_at: now,
          metadata: {
            classification_sha256: spec.classificationSha256,
            target_sha256: plan.targetSha256,
            batch_id: spec.batchId,
          },
          created_at: now,
          updated_at: now,
        })
        .onConflict().ignore().returning("id")
      insertedCount += inserted.length
    }
    const afterCount = await activeMarketingCount(trx, plan.emails)
    if (afterCount !== spec.count) throw new Error("C03 marketing suppression coverage is incomplete")

    await trx("gp_import_run").where("id", audit.id).update({
      status: "completed",
      completed_at: new Date(),
      imported_count: insertedCount,
      skipped_count: spec.count - insertedCount,
      failed_count: 0,
      stats: { target_count: spec.count, before_count: beforeCount, after_count: afterCount, inserted_count: insertedCount },
      updated_at: new Date(),
    })
    return {
      audit_run_id: audit.id,
      target_count: spec.count,
      before_count: beforeCount,
      after_count: afterCount,
      inserted_count: insertedCount,
      replayed: false,
    }
  })
}

export async function protectC03UnsubscribedFromContainer(
  container: MedusaContainer,
  addresses: unknown,
  actorId: string
) {
  return protectC03UnsubscribedDestinations(
    container.resolve(ContainerRegistrationKeys.PG_CONNECTION), addresses, actorId
  )
}
