import crypto from "crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  CC_EMAIL_CONSENT_SOURCE,
  CC_EMAIL_DECISION_REF,
  DEFAULT_NEWSLETTER_PREFERENCES,
  newPreferenceToken,
  normalizeEmail,
} from "./core"

type KnexLike = any

const SHA256 = /^[a-f0-9]{64}$/i
const BATCH_ID = /^[a-zA-Z0-9._:-]{8,128}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SUPPRESSION_SCOPES = new Set([
  "global", "marketing", "lifecycle", "broadcast", "marketing_1to1", "hard_bounce", "complaint",
])
const SUPPRESSION_SOURCES = new Set(["constant_contact", "postmark", "gp"])

export class ConstantContactImportInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConstantContactImportInputError"
  }
}

export type ProtectedEligibility = {
  row_sha256: string
  email: string | null
  email_eligible: boolean
  exclusion_reason?: string
  suppression?: {
    scope: string
    reason: string
    source: string
  }
}

export type ConstantContactImportBatch = {
  batch_id: string
  manifest_sha256: string
  source_sha256: string
  eligibility_sha256: string
  decision_ref: string
  rows: Record<string, any>[]
  eligibility: ProtectedEligibility[]
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  return JSON.stringify(value) || "null"
}

export function constantContactSha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function field(row: Record<string, any>, names: string[]): string {
  for (const name of names) {
    const value = row[name] ?? row[name.toLowerCase()] ?? row[name.toUpperCase()]
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }
  return ""
}

function sourceVetoes(row: Record<string, any>) {
  const status = ["status", "Email Status", "email_status", "Permission Status", "permission_status", "email_permission_status"]
    .map((name) => field(row, [name])).join(" ").toLowerCase()
  return {
    unsubscribed: status.includes("unsub") || /^(true|yes|1)$/i.test(field(row, ["unsubscribed", "is_unsubscribed"])),
    bounced: status.includes("bounce") || /^(true|yes|1)$/i.test(field(row, ["bounced", "is_bounced"])),
    pending: status.includes("pending") || status.includes("awaiting"),
    deleted: status.includes("deleted") || /^(true|yes|1)$/i.test(field(row, ["deleted", "is_deleted"])),
  }
}

function importEmail(row: Record<string, any>): string {
  return normalizeEmail(field(row, ["email", "Email Address", "Email", "email_address"]))
}

function assertHash(value: string, name: string) {
  if (!SHA256.test(value || "")) throw new ConstantContactImportInputError(`${name} must be a SHA-256 digest`)
}

export function planConstantContactImport(batch: ConstantContactImportBatch) {
  if (!batch || !BATCH_ID.test(batch.batch_id || "")) throw new ConstantContactImportInputError("batch_id is required")
  if (batch.decision_ref !== CC_EMAIL_DECISION_REF) throw new ConstantContactImportInputError("decision_ref does not match the approved email decision")
  assertHash(batch.manifest_sha256, "manifest_sha256")
  assertHash(batch.source_sha256, "source_sha256")
  assertHash(batch.eligibility_sha256, "eligibility_sha256")
  if (!Array.isArray(batch.rows) || !batch.rows.length || !Array.isArray(batch.eligibility) || batch.rows.length !== batch.eligibility.length) {
    throw new ConstantContactImportInputError("each source row needs one protected eligibility decision")
  }
  if (constantContactSha256(batch.eligibility) !== batch.eligibility_sha256.toLowerCase()) {
    throw new ConstantContactImportInputError("protected eligibility digest mismatch")
  }

  const eligibleEmails = new Set<string>()
  const vetoEmails = new Set<string>()
  const suppressions = new Map<string, { email: string; scope: string; reason: string; source: string }>()
  const entries: Array<{ email: string; eligible: boolean }> = []
  const stats = { total: batch.rows.length, eligible: 0, excluded: 0, missing_email: 0, suppressed: 0, preserved: 0, imported: 0 }

  for (let index = 0; index < batch.rows.length; index += 1) {
    const row = batch.rows[index]
    const decision = batch.eligibility[index]
    if (!row || typeof row !== "object" || Array.isArray(row) || !decision || typeof decision !== "object") {
      throw new ConstantContactImportInputError("invalid source row or eligibility decision")
    }
    if (constantContactSha256(row) !== decision.row_sha256?.toLowerCase()) {
      throw new ConstantContactImportInputError("source row digest mismatch")
    }
    if (typeof decision.email_eligible !== "boolean" || "sms_eligible" in decision || "sms" in decision) {
      throw new ConstantContactImportInputError("email eligibility must be explicit; SMS requires separate exact-number evidence")
    }
    const email = importEmail(row)
    const validEmail = EMAIL.test(email)
    if (validEmail ? email !== normalizeEmail(decision.email) : Boolean(decision.email) && email !== normalizeEmail(decision.email)) {
      throw new ConstantContactImportInputError("eligibility destination mismatch")
    }
    const vetoes = sourceVetoes(row)
    if (decision.email_eligible) {
      if (!validEmail || Object.values(vetoes).some(Boolean) || decision.exclusion_reason || decision.suppression) {
        throw new ConstantContactImportInputError("eligible row conflicts with a source veto or exclusion")
      }
      if (eligibleEmails.has(email)) throw new ConstantContactImportInputError("duplicate eligible destination")
      eligibleEmails.add(email)
      stats.eligible += 1
    } else {
      if (!decision.exclusion_reason || typeof decision.exclusion_reason !== "string") {
        throw new ConstantContactImportInputError("excluded row needs an explicit reason")
      }
      const reason = decision.exclusion_reason.toLowerCase()
      if ((!decision.suppression && /unsub/.test(reason) && !vetoes.unsubscribed) ||
          (!decision.suppression && /bounce/.test(reason) && !vetoes.bounced) ||
          (!decision.suppression && /suppress|complaint/.test(reason))) {
        throw new ConstantContactImportInputError("suppression exclusion needs protected suppression evidence")
      }
      stats.excluded += 1
      if (!validEmail) stats.missing_email += 1
    }
    if (validEmail && vetoes.unsubscribed) {
      vetoEmails.add(email)
      suppressions.set(`${email}:marketing`, { email, scope: "marketing", reason: "constant_contact_unsubscribe", source: "constant_contact" })
    }
    if (validEmail && vetoes.bounced) {
      vetoEmails.add(email)
      suppressions.set(`${email}:hard_bounce`, { email, scope: "hard_bounce", reason: "constant_contact_bounce", source: "constant_contact" })
    }
    if (decision.suppression) {
      const { scope, reason, source } = decision.suppression
      if (decision.email_eligible || !validEmail || !SUPPRESSION_SCOPES.has(scope) || !SUPPRESSION_SOURCES.has(source) || !reason || reason.length > 128) {
        throw new ConstantContactImportInputError("invalid protected suppression")
      }
      vetoEmails.add(email)
      if (source !== "gp" && !suppressions.has(`${email}:${scope}`)) {
        suppressions.set(`${email}:${scope}`, { email, scope, reason, source })
      }
    }
    entries.push({ email: validEmail ? email : "", eligible: decision.email_eligible })
  }
  for (const email of eligibleEmails) {
    if (vetoEmails.has(email)) throw new ConstantContactImportInputError("eligible destination has an unsubscribe or suppression in the same batch")
  }
  const payload_sha256 = constantContactSha256({
    batch_id: batch.batch_id,
    manifest_sha256: batch.manifest_sha256.toLowerCase(),
    source_sha256: batch.source_sha256.toLowerCase(),
    eligibility_sha256: batch.eligibility_sha256.toLowerCase(),
    decision_ref: batch.decision_ref,
    rows: batch.rows,
    eligibility: batch.eligibility,
  })
  return { entries, suppressions: [...suppressions.values()], stats, payload_sha256 }
}

/**
 * Controlled C04 projection. The caller supplies the protected, reviewed
 * row-level eligibility and manifest; Constant Contact status is only a veto.
 * The transaction commits all suppressions before any positive email grant.
 * Historical imports deliberately do not emit communication events or enroll flows.
 */
export async function importConstantContactRows(
  db: KnexLike,
  batch: ConstantContactImportBatch,
  metadata: { uploaded_by?: string | null; filename?: string | null } = {}
) {
  const plan = planConstantContactImport(batch)
  return db.transaction(async (trx: KnexLike) => {
    const startedAt = new Date()
    const run = {
      id: `gpimp_${crypto.randomUUID()}`,
      source: "constant_contact",
      batch_id: batch.batch_id,
      status: "running",
      started_at: startedAt,
      imported_count: 0,
      skipped_count: 0,
      failed_count: 0,
      stats: {},
      metadata: {
        payload_sha256: plan.payload_sha256,
        manifest_sha256: batch.manifest_sha256.toLowerCase(),
        source_sha256: batch.source_sha256.toLowerCase(),
        eligibility_sha256: batch.eligibility_sha256.toLowerCase(),
        decision_ref: CC_EMAIL_DECISION_REF,
        consent_source: CC_EMAIL_CONSENT_SOURCE,
        uploaded_by: metadata.uploaded_by || null,
        filename: metadata.filename || null,
      },
      created_at: startedAt,
      updated_at: startedAt,
    }
    const inserted = await trx("gp_import_run").insert(run).onConflict().ignore().returning("id")
    if (!inserted.length) {
      const existing = await trx("gp_import_run")
        .where({ source: "constant_contact", batch_id: batch.batch_id })
        .first()
      if (!existing || existing.metadata?.payload_sha256 !== plan.payload_sha256) {
        throw new ConstantContactImportInputError("batch identity already exists with different protected input")
      }
      if (existing.deleted_at) throw new ConstantContactImportInputError("batch identity is retired; reconcile before retry")
      if (existing.status !== "completed") throw new ConstantContactImportInputError("batch is not completed; reconcile before retry")
      return { import_run_id: existing.id, status: existing.status, stats: existing.stats, replayed: true }
    }

    // Active suppressions win via the unique index. Never update a prior
    // reason, timestamp, topic, unsubscribe, or resubscription marker.
    for (const suppression of plan.suppressions) {
      const at = new Date()
      await trx("gp_suppression_preference")
        .insert({
          id: `gpsupp_${crypto.randomUUID()}`,
          email: suppression.email,
          email_lower: suppression.email,
          scope: suppression.scope,
          topic: null,
          reason: suppression.reason,
          source: suppression.source,
          unsubscribed_at: at,
          metadata: { import_run_id: run.id, manifest_sha256: batch.manifest_sha256.toLowerCase() },
          created_at: at,
          updated_at: at,
        })
        .onConflict()
        .ignore()
    }

    for (const entry of plan.entries) {
      if (!entry.email || !entry.eligible) continue
      const at = new Date()
      await trx("gp_customer_profile")
        .insert({
          id: `gpcprof_${crypto.randomUUID()}`,
          email: entry.email,
          email_lower: entry.email,
          email_consent: false,
          email_consent_at: null,
          sms_consent: false,
          preferences: DEFAULT_NEWSLETTER_PREFERENCES,
          preference_token: newPreferenceToken(),
          metadata: {},
          created_at: at,
          updated_at: at,
        })
        .onConflict()
        .ignore()
      const profile = await trx("gp_customer_profile")
        .whereNull("deleted_at")
        .where("email_lower", entry.email)
        .forUpdate()
        .first()
      if (!profile) throw new Error("Import profile identity could not be resolved")
      const activeSuppression = await trx("gp_suppression_preference")
        .whereNull("deleted_at")
        .whereNull("resubscribed_at")
        .where("email_lower", entry.email)
        .whereIn("scope", [...SUPPRESSION_SCOPES])
        .first()
      if (activeSuppression) {
        plan.stats.suppressed += 1
        continue
      }
      // A false value with an earlier opt-in timestamp records a later GP
      // opt-out. Topic opt-outs are also stronger than this import decision.
      if (profile.email_consent || profile.email_consent_at || Object.values(profile.preferences || {}).some((value) => value === false)) {
        plan.stats.preserved += 1
        continue
      }
      const provenance = {
        consent_source: CC_EMAIL_CONSENT_SOURCE,
        consent_decision_ref: CC_EMAIL_DECISION_REF,
        consent_batch_id: batch.batch_id,
        consent_manifest_sha256: batch.manifest_sha256.toLowerCase(),
      }
      await trx("gp_customer_profile").where("id", profile.id).update({
        email_consent: true,
        // The policy decision is not a historical opt-in timestamp.
        email_consent_at: null,
        metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(provenance)]),
        updated_at: at,
      })
      plan.stats.imported += 1
    }

    const completedAt = new Date()
    await trx("gp_import_run").where("id", run.id).update({
      status: "completed",
      completed_at: completedAt,
      imported_count: plan.stats.imported,
      skipped_count: plan.stats.excluded + plan.stats.suppressed + plan.stats.preserved,
      failed_count: 0,
      stats: plan.stats,
      updated_at: completedAt,
    })
    return { import_run_id: run.id, status: "completed", stats: plan.stats, replayed: false }
  })
}

export async function importConstantContactPayload(
  container: MedusaContainer,
  batch: ConstantContactImportBatch,
  metadata: { uploaded_by?: string | null; filename?: string | null } = {}
) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  return importConstantContactRows(db, batch, metadata)
}
