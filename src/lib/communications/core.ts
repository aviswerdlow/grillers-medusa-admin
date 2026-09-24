import crypto from "crypto"
import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { emitOpsAlert } from "../ops-alert"
import { isInSendBlackout } from "./hebrew-calendar"
import { instrumentEmailHtml } from "./links"
import { primaryContactEnabled, hasPrimaryContactState } from "../customer-contact-rollout"
import {
  approvedEssentialEmailDuringBlackout,
  ESSENTIAL_EMAIL_BLACKOUT_POLICY_VERSION,
  observanceSendPolicyEnabled,
} from "./observance-send-policy"

type KnexLike = any

export type CommunicationStream = "transactional" | "lifecycle" | "broadcast"
export type CommunicationPurpose =
  | "transactional"
  | "service"
  | "marketing_1to1"
  | "broadcast"

export type CommunicationEventInput = {
  event_name: string
  event_id?: string
  source?: string
  profile_id?: string | null
  medusa_customer_id?: string | null
  anonymous_id?: string | null
  session_id?: string | null
  cart_id?: string | null
  order_id?: string | null
  email?: string | null
  customer_type?: string | null
  route_market?: string | null
  campaign_id?: string | null
  flow_id?: string | null
  template_key?: string | null
  message_id?: string | null
  occurred_at?: Date | string
  properties?: Record<string, any> | null
  context?: Record<string, any> | null
}

export type CustomerProfileInput = {
  medusa_customer_id?: string | null
  email?: string | null
  phone?: string | null
  first_name?: string | null
  last_name?: string | null
  customer_type?: string | null
  route_market?: string | null
  email_consent?: boolean
  sms_consent?: boolean
  sms_consent_at?: Date | string | null
  preferences?: Record<string, any> | null
  metadata?: Record<string, any> | null
}

export type SendTrackedEmailInput = {
  to: string
  subject: string
  html: string
  text?: string
  stream: CommunicationStream
  purpose?: CommunicationPurpose
  template_key: string
  topic?: string | null
  idempotency_key?: string | null
  profile_id?: string | null
  medusa_customer_id?: string | null
  order_id?: string | null
  cart_id?: string | null
  campaign_id?: string | null
  flow_id?: string | null
  flow_key?: string | null
  flow_enrollment_id?: string | null
  postmark_template_alias?: string | null
  template_model?: Record<string, any> | null
  metadata?: Record<string, any> | null
  /**
   * Staff-initiated test send to an explicitly typed address. Skips the
   * marketing-consent gate and the weekly frequency cap (a designer
   * iterating on a template sends themselves many tests), but still
   * honors the suppression list and the Shabbat/Yom Tov blackout.
   */
  staff_test?: boolean
}

type CommunicationEmailFailureAlertInput = {
  logger?: Pick<Logger, "warn" | "error">
  input: SendTrackedEmailInput
  purpose: CommunicationPurpose
  messageLogId: string
  error: string
}

type CommunicationEventSideEffect =
  | "destination_delivery"
  | "automation_side_effect"

type CommunicationEventSideEffectAlertInput = {
  row: Record<string, any>
  sideEffect: CommunicationEventSideEffect
  error: unknown
}

export const DEFAULT_NEWSLETTER_PREFERENCES = {
  promotions: true,
  new_products: true,
  recipes: true,
  holiday_reminders: true,
  back_in_stock: true,
  product_education: true,
}

export const MARKETING_SUPPRESSION_SCOPES = [
  "marketing",
  "lifecycle",
  "broadcast",
  "marketing_1to1",
]

/**
 * Toll-free SMS is registered as one marketing-only program.  These values
 * intentionally mirror the customer-facing storefront disclosure so the
 * durable profile record can prove exactly what the customer agreed to.
 *
 * Do not loosen this to a version prefix: a future disclosure/version should
 * be reviewed and deployed deliberately before it starts qualifying people
 * for marketing sends.
 */
export const SMS_MARKETING_CONSENT_VERSION = "sms-v3-2026-07-10"
export const SMS_MARKETING_PROGRAM = "grillers_pride_marketing"
export const SMS_MARKETING_PROVIDER = "twilio"
export const SMS_MARKETING_CONSENT_PURPOSE = "marketing"
export const SMS_MARKETING_CONSENT_METHOD = "customer_checkbox"
export const SMS_MARKETING_DISCLOSURE =
  "By checking this box, I agree to receive recurring automated marketing and promotional text messages from Griller's Pride, including seasonal specials, product announcements, promotional offers, and holiday sales deadlines, at the mobile number provided. Consent is not a condition of purchase. Message frequency varies, up to 6 messages per month. Msg & data rates may apply. Reply STOP to opt out or HELP for help."

export const SMS_MARKETING_CUSTOMER_SOURCES = [
  "account_signup",
  "account_profile",
  "checkout_account_creation",
  "first_login_verification",
] as const

const SMS_MARKETING_CUSTOMER_SOURCE_SET = new Set<string>(
  SMS_MARKETING_CUSTOMER_SOURCES
)

const tableId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`

export function normalizeEmail(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
}

export function newPreferenceToken(): string {
  return crypto.randomBytes(24).toString("base64url")
}

const STOREFRONT_BASE =
  process.env.STOREFRONT_BASE_URL || "https://grillers-medusa-frontend.vercel.app"

/**
 * Tokenized preference-center URL for a profile. The token is minted
 * lazily and stored on profile metadata; the storefront page + public
 * backend routes resolve it without a login.
 */
export async function preferenceUrlForProfile(
  db: KnexLike,
  profile: Record<string, any> | null
): Promise<string | null> {
  if (!profile?.id) return null
  const metadata = jsonObject(profile.metadata)
  let token = String(metadata.preference_token || "")
  if (!token) {
    token = newPreferenceToken()
    await db("gp_customer_profile")
      .where("id", profile.id)
      .update({
        metadata: { ...metadata, preference_token: token },
        updated_at: new Date(),
      })
    profile.metadata = { ...metadata, preference_token: token }
  }
  return `${STOREFRONT_BASE}/us/preferences/${token}`
}

function asDate(value?: Date | string): Date {
  if (!value) return new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function truthyConsentValue(value: unknown): boolean {
  if (value === true) return true
  if (typeof value !== "string") return false
  return ["true", "1", "yes", "on", "subscribed", "opted_in"].includes(
    value.trim().toLowerCase()
  )
}

/** Public analytics identify calls may carry traits, never consent evidence. */
export function withoutSmsConsentEvidence(
  record: Record<string, any>
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !key.toLowerCase().startsWith("sms_")
    )
  )
}

function normalizedUsPhone(value: unknown): string | null {
  const digits = String(value || "").replace(/\D/g, "")
  const ten =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  return ten.length === 10 ? ten : null
}

function validConsentDate(value: unknown): value is Date | string {
  if (!(value instanceof Date) && typeof value !== "string") return false
  const date = value instanceof Date ? value : new Date(value)
  return !Number.isNaN(date.getTime())
}

export function isStaleSmsConsentReplay(
  incomingConsentAt: unknown,
  priorOptOutAt: unknown,
  currentlyConsented: boolean
): boolean {
  if (currentlyConsented) return false
  if (!validConsentDate(incomingConsentAt) || !validConsentDate(priorOptOutAt)) {
    return false
  }
  const incomingMs =
    incomingConsentAt instanceof Date
      ? incomingConsentAt.getTime()
      : new Date(incomingConsentAt).getTime()
  const optOutMs =
    priorOptOutAt instanceof Date
      ? priorOptOutAt.getTime()
      : new Date(priorOptOutAt).getTime()
  return incomingMs <= optOutMs
}

/**
 * True only for the explicit, customer-originated v3 marketing checkbox on
 * signup, checkout account creation, first-login verification, or the
 * authenticated customer account profile.
 * Legacy v1/v2 mixed-use, prechecked, and staff-attested records remain in
 * storage for audit/history but fail this predicate and therefore cannot be
 * used for an audience or a send.
 */
export function hasQualifyingSmsMarketingConsent(
  profile: Record<string, any> | null | undefined,
  sendingPhone?: unknown
): boolean {
  if (!profile || !truthyConsentValue(profile.sms_consent)) return false
  if (!validConsentDate(profile.sms_consent_at)) return false

  const metadata = jsonObject(profile.metadata)
  if (
    metadata.sms_consent_version !== SMS_MARKETING_CONSENT_VERSION ||
    metadata.sms_program !== SMS_MARKETING_PROGRAM ||
    metadata.sms_consent_provider !== SMS_MARKETING_PROVIDER ||
    metadata.sms_consent_purpose !== SMS_MARKETING_CONSENT_PURPOSE ||
    metadata.sms_consent_method !== SMS_MARKETING_CONSENT_METHOD ||
    String(metadata.sms_consent_text || "").trim() !== SMS_MARKETING_DISCLOSURE ||
    !SMS_MARKETING_CUSTOMER_SOURCE_SET.has(
      String(metadata.sms_consent_source || "")
    )
  ) {
    return false
  }

  const consentPhone = normalizedUsPhone(metadata.sms_consent_phone)
  if (!consentPhone) return false
  const profilePhone = normalizedUsPhone(profile.phone)
  if (!profilePhone || profilePhone !== consentPhone) return false
  if (sendingPhone !== undefined) {
    const destinationPhone = normalizedUsPhone(sendingPhone)
    if (!destinationPhone || destinationPhone !== consentPhone) return false
  }
  return true
}

/** Apply the database portion of the v3 qualification gate. */
export function applySmsMarketingConsentWhere(query: KnexLike): KnexLike {
  return query
    .where("sms_consent", true)
    .whereNotNull("sms_consent_at")
    .whereRaw("metadata->>'sms_consent_version' = ?", [
      SMS_MARKETING_CONSENT_VERSION,
    ])
    .whereRaw("metadata->>'sms_program' = ?", [SMS_MARKETING_PROGRAM])
    .whereRaw("metadata->>'sms_consent_provider' = ?", [
      SMS_MARKETING_PROVIDER,
    ])
    .whereRaw("metadata->>'sms_consent_purpose' = ?", [
      SMS_MARKETING_CONSENT_PURPOSE,
    ])
    .whereRaw("metadata->>'sms_consent_method' = ?", [
      SMS_MARKETING_CONSENT_METHOD,
    ])
    .whereRaw("metadata->>'sms_consent_text' = ?", [SMS_MARKETING_DISCLOSURE])
    .whereRaw(
      `metadata->>'sms_consent_source' in (${SMS_MARKETING_CUSTOMER_SOURCES.map(
        () => "?"
      ).join(", ")})`,
      [...SMS_MARKETING_CUSTOMER_SOURCES]
    )
}

export function smsConsentFromCustomerMetadata(
  metadata: unknown
): Partial<CustomerProfileInput> {
  const record = jsonObject(metadata)
  const consented =
    truthyConsentValue(record.sms_marketing_opt_in) ||
    truthyConsentValue(record.sms_consent) ||
    truthyConsentValue(record.sms_consent_status)

  if (!consented) return {}

  const candidate = {
    sms_consent: true,
    sms_consent_at: record.sms_consent_at,
    phone: record.sms_consent_phone,
    metadata: record,
  }
  if (!hasQualifyingSmsMarketingConsent(candidate, record.sms_consent_phone)) {
    // Quarantine by omission. Do not rewrite or delete legacy evidence; the
    // original Medusa customer metadata remains available for audit.
    return {}
  }

  return {
    sms_consent: true,
    sms_consent_at: record.sms_consent_at,
    metadata: {
      sms_consent_at: record.sms_consent_at,
      sms_consent_source: record.sms_consent_source,
      sms_consent_version: record.sms_consent_version,
      sms_consent_text: record.sms_consent_text,
      sms_consent_phone: record.sms_consent_phone,
      sms_consent_provider: record.sms_consent_provider,
      sms_program: record.sms_program,
      sms_consent_purpose: record.sms_consent_purpose,
      sms_consent_method: record.sms_consent_method,
    },
  }
}

function resolveDb(container: MedusaContainer): KnexLike {
  return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
}

function postmarkStream(stream: CommunicationStream): string {
  if (stream === "broadcast") {
    return process.env.POSTMARK_BROADCAST_STREAM || "broadcast"
  }
  if (stream === "lifecycle") {
    return process.env.POSTMARK_LIFECYCLE_STREAM || "broadcast"
  }
  return process.env.POSTMARK_TRANSACTIONAL_STREAM || "outbound"
}

function compactMetadataValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

export function postmarkMetadata(
  input: Record<string, unknown>
): Record<string, string> {
  const metadata: Record<string, string> = {}

  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(metadata).length >= 10) break
    const normalized = compactMetadataValue(value).trim()
    const normalizedKey = key.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20)
    if (!normalizedKey || !normalized || metadata[normalizedKey]) continue
    metadata[normalizedKey] = normalized.slice(0, 500)
  }

  return metadata
}

function inferredPurpose(
  stream: CommunicationStream,
  templateKey?: string | null
): CommunicationPurpose {
  if (stream === "broadcast") return "broadcast"
  if (templateKey?.startsWith("cart-abandoned")) return "marketing_1to1"
  if (stream === "lifecycle") return "marketing_1to1"
  return "transactional"
}

function requiresMarketingConsent(purpose: CommunicationPurpose): boolean {
  return purpose === "marketing_1to1" || purpose === "broadcast"
}

function marketingPreferenceAllows(
  profile: Record<string, any> | null,
  topic?: string | null
): boolean {
  if (!topic) return true
  const preferences = jsonObject(profile?.preferences)
  if (preferences[topic] === false) return false
  if (topic === "cart_recovery" && preferences.promotions === false) return false
  return true
}

function experimentContextFrom(...values: unknown[]): Record<string, any> | null {
  for (const value of values) {
    const object = jsonObject(value)
    const direct = jsonObject(object.experiment_context)
    if (Object.keys(direct).length) return direct
    const nested = jsonObject(jsonObject(object.context).experiment_context)
    if (Object.keys(nested).length) return nested
  }
  return null
}

function redactedProviderError(error: string): string {
  return String(error || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 500)
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "")
  return redactedProviderError(message)
}

export async function emitCommunicationEmailFailureAlert({
  logger,
  input,
  purpose,
  messageLogId,
  error,
}: CommunicationEmailFailureAlertInput) {
  return emitOpsAlert({
    alertKind: "communications_email_send_failed",
    severity: "warn",
    title: `${input.template_key} email send failed`,
    path: "src/lib/communications/core.ts:sendTrackedEmail",
    source: "medusa-server",
    logger,
    meta: {
      message_log_id: messageLogId,
      stream: input.stream,
      purpose,
      template_key: input.template_key,
      topic: input.topic || null,
      order_id: input.order_id || null,
      cart_id: input.cart_id || null,
      campaign_id: input.campaign_id || null,
      flow_id: input.flow_id || null,
      flow_key: input.flow_key || null,
      flow_enrollment_id: input.flow_enrollment_id || null,
      postmark_template_alias: input.postmark_template_alias || null,
      has_profile_id: Boolean(input.profile_id),
      has_medusa_customer_id: Boolean(input.medusa_customer_id),
      provider_error: redactedProviderError(error),
    },
  })
}

export async function emitCommunicationEventSideEffectAlert({
  row,
  sideEffect,
  error,
}: CommunicationEventSideEffectAlertInput) {
  const readableSideEffect =
    sideEffect === "destination_delivery"
      ? "destination delivery"
      : "automation side effect"

  return emitOpsAlert({
    alertKind: `communications_event_${sideEffect}_failed`,
    severity: "warn",
    title: `Communications ${readableSideEffect} failed for ${row.event_name || "unknown event"}`,
    path: "src/lib/communications/core.ts:recordCommunicationEvent",
    source: "medusa-server",
    meta: {
      side_effect: sideEffect,
      communication_event_id: row.id || null,
      event_id: row.event_id || null,
      event_name: row.event_name || null,
      event_source: row.source || null,
      template_key: row.template_key || null,
      order_id: row.order_id || null,
      cart_id: row.cart_id || null,
      campaign_id: row.campaign_id || null,
      flow_id: row.flow_id || null,
      message_id: row.message_id || null,
      has_profile_id: Boolean(row.profile_id),
      has_medusa_customer_id: Boolean(row.medusa_customer_id),
      error: redactedErrorMessage(error),
    },
  })
}

export async function upsertCustomerProfile(
  db: KnexLike,
  input: CustomerProfileInput,
  options: { requireIdentityMatch?: boolean } = {}
): Promise<Record<string, any> | null> {
  const emailLower = normalizeEmail(input.email)
  const now = new Date()

  const findExisting = async (): Promise<Record<string, any> | null> => {
    let profile: Record<string, any> | null = null
    if (input.medusa_customer_id) {
      profile = await db("gp_customer_profile")
        .whereNull("deleted_at")
        .where("medusa_customer_id", input.medusa_customer_id)
        .first()
    }
    if (!profile && emailLower) {
      profile = await db("gp_customer_profile")
        .whereNull("deleted_at")
        .where("email_lower", emailLower)
        .first()
    }
    return profile
  }

  let existing = await findExisting()

  if (!existing) {
    if (!emailLower && !input.medusa_customer_id) return null

    const row = {
      id: tableId("gpcprof"),
      medusa_customer_id: input.medusa_customer_id || null,
      email: input.email || null,
      email_lower: emailLower || null,
      phone: input.phone || null,
      first_name: input.first_name || null,
      last_name: input.last_name || null,
      customer_type: input.customer_type || "dtc",
      route_market: input.route_market || "unknown",
      lifecycle_stage: "lead",
      email_consent: Boolean(input.email_consent),
      email_consent_at: input.email_consent ? now : null,
      sms_consent: Boolean(input.sms_consent),
      sms_consent_at: input.sms_consent
        ? asDate(input.sms_consent_at || now)
        : null,
      preferences: {
        ...DEFAULT_NEWSLETTER_PREFERENCES,
        ...jsonObject(input.preferences),
      },
      preference_token: newPreferenceToken(),
      last_active_at: now,
      metadata: Object.fromEntries(Object.entries(input.metadata || {}).filter(([key]) => key !== "primary_contact_v1")),
      created_at: now,
      updated_at: now,
    }

    // customer.created is consumed by both the commerce-event recorder and
    // the welcome-email subscriber. They can both observe "no profile" and
    // attempt the first insert at the same time. Let PostgreSQL arbitrate all
    // active-profile unique indexes without raising a transaction-poisoning
    // 23505, then read back the winner and merge this caller's fields below.
    await db("gp_customer_profile").insert(row).onConflict().ignore()

    existing = await findExisting()
    if (!existing) {
      // DO NOTHING can also be triggered by a unique key unrelated to the
      // customer's identity (for example, a preference-token collision).
      // Failing closed here keeps that real data-integrity problem visible.
      throw new Error(
        "Customer profile insert conflicted but no active identity match was found"
      )
    }
    if (existing.id === row.id) return existing
  }

  const preferences = {
    ...DEFAULT_NEWSLETTER_PREFERENCES,
    ...jsonObject(existing?.preferences),
    ...jsonObject(input.preferences),
  }

  if (existing) {
    const strictIdentity = options.requireIdentityMatch || primaryContactEnabled() || hasPrimaryContactState(existing.metadata)
    if (strictIdentity &&
        input.medusa_customer_id && existing.medusa_customer_id &&
        input.medusa_customer_id !== existing.medusa_customer_id) {
      throw new Error("Communications identity conflict; account association requires review")
    }
    const existingMetadata = jsonObject(existing.metadata)
    const incomingMetadata = jsonObject(input.metadata)
    const resultPatch: Record<string, any> = {
      medusa_customer_id:
        input.medusa_customer_id || existing.medusa_customer_id || null,
      email: input.email || existing.email || null,
      email_lower: emailLower || existing.email_lower || null,
      phone: input.phone || existing.phone || null,
      first_name: input.first_name || existing.first_name || null,
      last_name: input.last_name || existing.last_name || null,
      customer_type: input.customer_type || existing.customer_type || "dtc",
      route_market: input.route_market || existing.route_market || "unknown",
      email_consent:
        input.email_consent === undefined
          ? existing.email_consent
          : input.email_consent,
      email_consent_at:
        input.email_consent && !existing.email_consent_at
          ? now
          : existing.email_consent_at,
      preferences,
      preference_token: existing.preference_token || newPreferenceToken(),
      last_active_at: now,
      metadata: {
        ...existingMetadata,
        ...incomingMetadata,
      },
      updated_at: now,
    }
    const dbPatch: Record<string, any> = { ...resultPatch }
    if (Object.keys(incomingMetadata).length) {
      // Merge against the row's CURRENT jsonb value. Replacing it with the
      // object read above can erase a concurrent STOP's sms_opt_out_at.
      dbPatch.metadata = db.raw(
        "coalesce(metadata, '{}'::jsonb) || ?::jsonb",
        [JSON.stringify(incomingMetadata)]
      )
    } else {
      delete dbPatch.metadata
    }

    if (input.sms_consent === false) {
      dbPatch.sms_consent = false
      dbPatch.sms_consent_at = null
      resultPatch.sms_consent = false
      resultPatch.sms_consent_at = null
    } else if (input.sms_consent === true) {
      const incomingAt = asDate(input.sms_consent_at || now).toISOString()
      // Atomic STOP-wins rule. PostgreSQL evaluates these expressions against
      // the row version locked by UPDATE, not the stale object read above:
      // - a STOP committed before this update leaves sms_consent=false and a
      //   newer/equal opt-out timestamp, so stale consent cannot revive it;
      // - a STOP committed after this update overwrites it normally;
      // - a legitimate START already made sms_consent=true, so stale customer
      //   metadata cannot undo that restoration.
      dbPatch.sms_consent = db.raw(
        `case
          when sms_consent = true then true
          when coalesce(metadata->>'sms_opt_out_at', '') >= ? then false
          else true
        end`,
        [incomingAt]
      )
      dbPatch.sms_consent_at = db.raw(
        `case
          when sms_consent = true then coalesce(sms_consent_at, ?::timestamptz)
          when coalesce(metadata->>'sms_opt_out_at', '') >= ? then sms_consent_at
          else ?::timestamptz
        end`,
        [incomingAt, incomingAt, incomingAt]
      )
      resultPatch.sms_consent = true
      resultPatch.sms_consent_at = asDate(incomingAt)
    }

    // A delayed customer event/import may contain the previous number and
    // consent. Only the locked customer contact transaction replaces these
    // after confirmation. Evaluate against the CURRENT row, not this read.
    const protectedState = "metadata->'primary_contact_v1'->>'version' = '1'"
    dbPatch.phone = db.raw(`case when ${protectedState} then phone else ? end`, [dbPatch.phone])
    for (const key of ["sms_consent", "sms_consent_at"]) {
      if (dbPatch[key] !== undefined) {
        dbPatch[key] = db.raw(`case when ${protectedState} then ?? else ? end`, [key, dbPatch[key]])
      }
    }
    const publicMetadata = Object.fromEntries(Object.entries(incomingMetadata).filter(
      ([key]) => key !== "primary_contact_v1" && !key.startsWith("sms_")
    ))
    const legacyMetadata = { ...incomingMetadata }
    delete legacyMetadata.primary_contact_v1
    if (Object.keys(incomingMetadata).length) {
      dbPatch.metadata = db.raw(
        `coalesce(metadata, '{}'::jsonb) || case when ${protectedState} then ?::jsonb else ?::jsonb end`,
        [JSON.stringify(publicMetadata), JSON.stringify(legacyMetadata)]
      )
    }
    const update = db("gp_customer_profile").where("id", existing.id)
    if (input.medusa_customer_id) {
      if (strictIdentity) update.whereRaw("(medusa_customer_id is null or medusa_customer_id = ?)", [input.medusa_customer_id])
      else update.whereRaw("((metadata->'primary_contact_v1' is null and metadata->'contact_confirmation_v2' is null) or medusa_customer_id is null or medusa_customer_id = ?)", [input.medusa_customer_id])
    }
    const affected = await update.update(dbPatch)
    if (affected === 0) throw new Error("Communications identity changed during update")
    if (input.sms_consent !== undefined || input.phone !== undefined || existingMetadata.primary_contact_v1) {
      const refreshed = await db("gp_customer_profile")
        .whereNull("deleted_at")
        .where("id", existing.id)
        .first()
      if (refreshed) return refreshed
    }
    return { ...existing, ...resultPatch }
  }

  throw new Error("Customer profile upsert could not resolve an active profile")
}

export async function recordIdentity(
  db: KnexLike,
  profileId: string,
  input: {
    anonymous_id?: string | null
    session_id?: string | null
    cart_id?: string | null
    medusa_customer_id?: string | null
    email?: string | null
    metadata?: Record<string, any> | null
  }
): Promise<void> {
  const now = new Date()
  const emailLower = normalizeEmail(input.email)
  const selectors: Array<Record<string, string>> = []
  if (input.anonymous_id) selectors.push({ anonymous_id: input.anonymous_id })
  if (input.cart_id) selectors.push({ cart_id: input.cart_id })
  if (input.medusa_customer_id) {
    selectors.push({ medusa_customer_id: input.medusa_customer_id })
  }

  if (!selectors.length) return

  for (const selector of selectors) {
    const existing = await db("gp_identity_map")
      .whereNull("deleted_at")
      .where(selector)
      .first()
    const patch = {
      profile_id: profileId,
      anonymous_id: input.anonymous_id || existing?.anonymous_id || null,
      session_id: input.session_id || existing?.session_id || null,
      cart_id: input.cart_id || existing?.cart_id || null,
      medusa_customer_id:
        input.medusa_customer_id || existing?.medusa_customer_id || null,
      email_lower: emailLower || existing?.email_lower || null,
      last_seen_at: now,
      metadata: {
        ...jsonObject(existing?.metadata),
        ...jsonObject(input.metadata),
      },
      updated_at: now,
    }
    try {
      if (existing) {
        await db("gp_identity_map").where("id", existing.id).update(patch)
      } else {
        await db("gp_identity_map").insert({
          id: tableId("gpidmap"),
          first_seen_at: now,
          created_at: now,
          ...patch,
        })
      }
    } catch (err: any) {
      // Another active row already owns one of these identifiers (e.g.
      // two carts merging onto one anonymous_id). The identity is already
      // mapped — a unique violation here is benign, not a failure that
      // should abort lifecycle maintenance and page ops.
      if (String(err?.code) !== "23505") throw err
    }
  }
}

export async function recordCommunicationEvent(
  db: KnexLike,
  input: CommunicationEventInput
): Promise<Record<string, any>> {
  const now = new Date()
  const eventId = input.event_id || crypto.randomUUID()
  const experimentContext = experimentContextFrom(input.context, input.properties)
  const context = {
    ...(input.context || {}),
    ...(experimentContext ? { experiment_context: experimentContext } : {}),
  }
  const existingEvent = await db("gp_communication_event")
    .whereNull("deleted_at")
    .where("event_id", eventId)
    .first()
  if (existingEvent) return existingEvent

  const emailLower = normalizeEmail(input.email)
  let profile = null as Record<string, any> | null

  if (input.profile_id) {
    profile = await db("gp_customer_profile")
      .whereNull("deleted_at")
      .where("id", input.profile_id)
      .first()
  }
  if (!profile && (emailLower || input.medusa_customer_id)) {
    profile = await upsertCustomerProfile(db, {
      email: input.email || undefined,
      medusa_customer_id: input.medusa_customer_id || undefined,
      customer_type: input.customer_type || undefined,
      route_market: input.route_market || undefined,
    })
  }

  if (profile) {
    await recordIdentity(db, profile.id, {
      anonymous_id: input.anonymous_id,
      session_id: input.session_id,
      cart_id: input.cart_id,
      medusa_customer_id: input.medusa_customer_id,
      // A delivered receipt address is a message destination, not a new login/marketing identity.
      email: input.event_name.startsWith("email_") && profile.medusa_customer_id
        ? profile.email : input.email,
    })
  }

  const row = {
    id: tableId("gpcevt"),
    event_id: eventId,
    event_name: input.event_name,
    source: input.source || "medusa-server",
    profile_id: input.profile_id || profile?.id || null,
    medusa_customer_id:
      input.medusa_customer_id || profile?.medusa_customer_id || null,
    anonymous_id: input.anonymous_id || null,
    session_id: input.session_id || null,
    cart_id: input.cart_id || null,
    order_id: input.order_id || null,
    email: input.email || profile?.email || null,
    email_lower: emailLower || profile?.email_lower || null,
    customer_type: input.customer_type || profile?.customer_type || "unknown",
    route_market: input.route_market || profile?.route_market || "unknown",
    campaign_id: input.campaign_id || null,
    flow_id: input.flow_id || null,
    template_key: input.template_key || null,
    message_id: input.message_id || null,
    occurred_at: asDate(input.occurred_at),
    received_at: now,
    properties: input.properties || {},
    context,
    created_at: now,
    updated_at: now,
  }

  const insert = db("gp_communication_event")
    .insert(row)
    .onConflict(db.raw('("event_id") where "deleted_at" is null'))
    .ignore()
  if (eventId.startsWith("postmark-webhook:")) {
    const inserted =
      typeof insert.returning === "function"
        ? await insert.returning("id")
        : await insert
    if (Array.isArray(inserted) && inserted.length === 0) {
      // Another callback won the event-id race. Only that callback fans out.
      const winner = await db("gp_communication_event")
        .whereNull("deleted_at")
        .where("event_id", eventId)
        .first()
      if (!winner) {
        throw new Error("Postmark event conflict has no visible winner")
      }
      return winner
    }
  } else {
    await insert
  }

  try {
    const { writeEventDestinations } = await import("./destinations.js")
    await writeEventDestinations(db, row)
  } catch (error) {
    void emitCommunicationEventSideEffectAlert({
      row,
      sideEffect: "destination_delivery",
      error,
    }).catch(() => {
      // Alerting must never block event ingestion.
    })
    // External delivery must never block event ingestion.
  }

  try {
    const { enqueueCommunicationEvent } = await import("./queue.js")
    const queued = await enqueueCommunicationEvent(db, row)
    if (!queued) {
      const { syncCartLifecycleFromEvent } = await import("./cart-lifecycle.js")
      const { attributeOrderFromEvent } = await import("./attribution.js")
      await syncCartLifecycleFromEvent(db, row)
      await attributeOrderFromEvent(db, row)
      const { evaluateFlowsForEvent, isFlowTriggerableEvent } = await import(
        "./flows.js"
      )
      if (isFlowTriggerableEvent(row.event_name)) {
        await evaluateFlowsForEvent(db, row)
      }
    }
  } catch (error) {
    void emitCommunicationEventSideEffectAlert({
      row,
      sideEffect: "automation_side_effect",
      error,
    }).catch(() => {
      // Alerting must never block event ingestion.
    })
    // Automation side effects must never block event ingestion.
  }

  return row
}

async function hasSuppression(
  db: KnexLike,
  emailLower: string,
  purpose: CommunicationPurpose,
  topic?: string | null
): Promise<boolean> {
  if (!emailLower) return true
  const scopes =
    purpose === "transactional" || purpose === "service"
      ? ["global", "hard_bounce", "complaint"]
      : [
          "global",
          "marketing",
          "lifecycle",
          "broadcast",
          "marketing_1to1",
          "hard_bounce",
          "complaint",
        ]
  const rows = await db("gp_suppression_preference")
    .whereNull("deleted_at")
    .whereNull("resubscribed_at")
    .where("email_lower", emailLower)
    .whereIn("scope", scopes)
  return rows.some(
    (row: Record<string, any>) => !row.topic || !topic || row.topic === topic
  )
}

export async function recordSuppression(
  db: KnexLike,
  input: {
    email: string
    scope: string
    topic?: string | null
    reason: string
    source?: string | null
    metadata?: Record<string, any> | null
  }
): Promise<Record<string, any> | null> {
  const emailLower = normalizeEmail(input.email)
  if (!emailLower) return null
  const now = new Date()
  const existing = await db("gp_suppression_preference")
    .whereNull("deleted_at")
    .whereNull("resubscribed_at")
    .where("email_lower", emailLower)
    .where("scope", input.scope)
    .whereRaw("coalesce(topic, '') = ?", [input.topic || ""])
    .first()

  if (existing) {
    const patch = {
      reason: input.reason,
      source: input.source || existing.source,
      unsubscribed_at: existing.unsubscribed_at || now,
      metadata: {
        ...jsonObject(existing.metadata),
        ...jsonObject(input.metadata),
      },
      updated_at: now,
    }
    await db("gp_suppression_preference").where("id", existing.id).update(patch)
    return { ...existing, ...patch }
  }

  const row = {
    id: tableId("gpsupp"),
    email: input.email,
    email_lower: emailLower,
    scope: input.scope,
    topic: input.topic || null,
    reason: input.reason,
    source: input.source || null,
    unsubscribed_at: now,
    metadata: input.metadata || {},
    created_at: now,
    updated_at: now,
  }
  await db("gp_suppression_preference").insert(row)
  return row
}

export async function sendTrackedEmail(
  container: MedusaContainer,
  input: SendTrackedEmailInput
): Promise<{
  ok: boolean
  skipped?: boolean
  messageId?: string
  error?: string
  /** Shabbat/Yom Tov blackout: try again at deferUntil. NOT a failure. */
  deferred?: boolean
  deferUntil?: Date
}> {
  const db = resolveDb(container)
  const logger = container.resolve("logger")
  const notification = container.resolve(Modules.NOTIFICATION)
  const emailLower = normalizeEmail(input.to)
  const now = new Date()
  const purpose = input.purpose || inferredPurpose(input.stream, input.template_key)
  const experimentContext = experimentContextFrom(
    input.metadata,
    input.template_model
  )
  const identityCustomer = input.medusa_customer_id
    // Historical service notices retain the account identity even after soft deletion.
    ? await db("customer").where({ id: input.medusa_customer_id }).first()
    : null
  if (input.medusa_customer_id && !identityCustomer) {
    return { ok: false, error: "missing_customer_identity" }
  }
  const profile = await upsertCustomerProfile(db, {
    email: identityCustomer?.email || input.to,
    medusa_customer_id: input.medusa_customer_id || undefined,
  })

  if (!emailLower) {
    return { ok: false, error: "missing_recipient" }
  }

  if (
    !input.staff_test &&
    requiresMarketingConsent(purpose) &&
    (normalizeEmail(profile?.email) !== emailLower || !profile?.email_consent || !profile?.email_consent_at)
  ) {
    await recordCommunicationEvent(db, {
      event_name: "email_suppressed",
      email: input.to,
      profile_id: profile?.id,
      template_key: input.template_key,
      order_id: input.order_id,
      cart_id: input.cart_id,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      properties: {
        stream: input.stream,
        purpose,
        topic: input.topic,
        reason: "missing_marketing_consent",
      },
      context: experimentContext ? { experiment_context: experimentContext } : {},
    })
    return { ok: true, skipped: true }
  }

  if (
    !input.staff_test &&
    requiresMarketingConsent(purpose) &&
    !marketingPreferenceAllows(profile, input.topic)
  ) {
    await recordCommunicationEvent(db, {
      event_name: "email_suppressed",
      email: input.to,
      profile_id: profile?.id,
      template_key: input.template_key,
      order_id: input.order_id,
      cart_id: input.cart_id,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      properties: {
        stream: input.stream,
        purpose,
        topic: input.topic,
        reason: "topic_preference",
      },
      context: experimentContext ? { experiment_context: experimentContext } : {},
    })
    return { ok: true, skipped: true }
  }

  if (await hasSuppression(db, emailLower, purpose, input.topic)) {
    await recordCommunicationEvent(db, {
      event_name: "email_suppressed",
      email: input.to,
      profile_id: profile?.id,
      template_key: input.template_key,
      order_id: input.order_id,
      cart_id: input.cart_id,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      properties: {
        stream: input.stream,
        purpose,
        topic: input.topic,
        reason: "suppression",
      },
      context: experimentContext ? { experiment_context: experimentContext } : {},
    })
    return { ok: true, skipped: true }
  }

  const idempotencyKey =
    input.idempotency_key ||
    [
      input.stream,
      input.template_key,
      emailLower,
      input.order_id || input.cart_id || input.campaign_id || input.flow_enrollment_id || "",
    ].join(":")

  const existing = await db("gp_message_log")
    .whereNull("deleted_at")
    .where("idempotency_key", idempotencyKey)
    .first()

  if (existing && ["queued", "sent", "delivered"].includes(existing.status)) {
    return {
      ok: true,
      skipped: true,
      messageId: existing.postmark_message_id || undefined,
    }
  }

  // During the approved observance policy, only the reviewed, necessary
  // account/order templates may cross the blackout. The switch defaults off
  // until the durable deferral paths and production send owners are ready.
  // Deferred is NOT a failure: callers reschedule at deferUntil; nothing
  // is logged to gp_message_log so the retry sends cleanly.
  // Gated on PURPOSE as well as stream: cart-recovery flows ride the
  // transactional Postmark stream for inbox placement but are still
  // marketing (marketing_1to1) — stream is a deliverability choice, not
  // a semantic classification.
  const observancePolicy = observanceSendPolicyEnabled()
  const blackoutApplies =
    input.stream === "broadcast" ||
    input.stream === "lifecycle" ||
    requiresMarketingConsent(purpose) ||
    (observancePolicy && !approvedEssentialEmailDuringBlackout(input, purpose))
  if (blackoutApplies) {
    const blackout = isInSendBlackout(now)
    if (blackout.blocked) {
      await recordCommunicationEvent(db, {
        event_name: "email_deferred_blackout",
        email: input.to,
        profile_id: profile?.id,
        template_key: input.template_key,
        order_id: input.order_id,
        cart_id: input.cart_id,
        campaign_id: input.campaign_id,
        flow_id: input.flow_id,
        properties: {
          stream: input.stream,
          purpose,
          topic: input.topic,
          reason: blackout.reason || "shabbat_blackout",
          defer_until: blackout.until ? blackout.until.toISOString() : null,
          policy_version: observancePolicy
            ? ESSENTIAL_EMAIL_BLACKOUT_POLICY_VERSION
            : null,
        },
        context: experimentContext
          ? { experiment_context: experimentContext }
          : {},
      })
      return {
        ok: false,
        deferred: true,
        deferUntil: blackout.until,
        error: "shabbat_blackout",
      }
    }
  }

  // FREQUENCY CAP (platform guardrail): a customer never receives more
  // than COMMS_EMAIL_WEEKLY_CAP marketing/lifecycle emails in any rolling
  // 7 days, regardless of how many campaigns/flows target them.
  // Transactional receipts don't count against (or consume) the cap.
  // Staff test sends are exempt — a designer iterating on a template
  // sends themselves many tests in a day.
  // Keyed on PURPOSE, not just stream: cart-recovery marketing rides the
  // transactional stream for inbox placement and must still respect the
  // cap ("regardless of how many campaigns/flows target them").
  if (
    !input.staff_test &&
    (input.stream === "broadcast" ||
      input.stream === "lifecycle" ||
      requiresMarketingConsent(purpose))
  ) {
    const cap = Number(process.env.COMMS_EMAIL_WEEKLY_CAP || 3)
    if (Number.isFinite(cap) && cap > 0) {
      const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const recent = await db("gp_message_log")
        .whereNull("deleted_at")
        .where("email_lower", emailLower)
        // Column is message_stream (NOT "stream" — that column doesn't
        // exist and threw on the first real marketing send). Count by
        // purpose too so transactional-stream marketing consumes the cap.
        .where((builder: any) =>
          builder
            .whereIn("message_stream", ["broadcast", "lifecycle"])
            .orWhereIn("message_purpose", ["broadcast", "marketing_1to1"])
        )
        .whereIn("status", ["queued", "sent", "delivered"])
        .where("created_at", ">=", since)
        .count("id as count")
      const sentThisWeek = Number(recent?.[0]?.count || 0)
      if (sentThisWeek >= cap) {
        await recordCommunicationEvent(db, {
          event_name: "email_suppressed",
          email: input.to,
          profile_id: profile?.id,
          template_key: input.template_key,
          order_id: input.order_id,
          cart_id: input.cart_id,
          campaign_id: input.campaign_id,
          flow_id: input.flow_id,
          properties: {
            stream: input.stream,
            purpose,
            topic: input.topic,
            reason: "frequency_cap",
            cap,
            sent_this_week: sentThisWeek,
          },
          context: experimentContext
            ? { experiment_context: experimentContext }
            : {},
        })
        return { ok: true, skipped: true }
      }
    }
  }

  const messageRow = {
    id: existing?.id || tableId("gpmsg"),
    idempotency_key: idempotencyKey,
    profile_id: input.profile_id || profile?.id || null,
    medusa_customer_id:
      input.medusa_customer_id || profile?.medusa_customer_id || null,
    email: input.to,
    email_lower: emailLower,
    channel: "email",
    message_stream: input.stream,
    message_purpose: purpose,
    topic: input.topic || null,
    template_key: input.template_key,
    flow_id: input.flow_id || null,
    flow_key: input.flow_key || null,
    flow_enrollment_id: input.flow_enrollment_id || null,
    campaign_id: input.campaign_id || null,
    order_id: input.order_id || null,
    cart_id: input.cart_id || null,
    subject: input.subject,
    status: "queued",
    postmark_template_alias: input.postmark_template_alias || null,
    template_model: input.template_model || {},
    experiment_context: experimentContext,
    metadata: {
      ...(input.metadata || {}),
      purpose,
      ...(experimentContext ? { experiment_context: experimentContext } : {}),
    },
    queued_at: now,
    created_at: existing?.created_at || now,
    updated_at: now,
  }

  // Marketing links: UTM + signed click-tracking redirect (skips
  // transactional receipts). The instrumented html is what actually
  // sends; original destinations persist on the message row so the
  // /l/ redirect route can resolve index → URL.
  let outgoingHtml = input.html
  if (input.stream === "broadcast" || input.stream === "lifecycle") {
    const preferenceUrl = await preferenceUrlForProfile(db, profile)
    if (preferenceUrl) {
      outgoingHtml = outgoingHtml.replace(/\{\{\s*preference_url\s*\}\}/g, () => preferenceUrl)
      ;(messageRow.template_model as Record<string, any>).preference_url = preferenceUrl
    }
    const instrumented = instrumentEmailHtml(outgoingHtml, {
      messageId: messageRow.id,
      backendBaseUrl:
        process.env.PUBLIC_BACKEND_URL ||
        "https://grillers-medusa-admin-production.up.railway.app",
      utm: {
        campaign: input.campaign_id || input.flow_key || undefined,
        content: input.template_key,
        medium: "email",
      },
    })
    outgoingHtml = instrumented.html
    if (instrumented.links.length) {
      ;(messageRow as Record<string, any>).metadata = {
        ...(messageRow.metadata as Record<string, any>),
        links: instrumented.links,
      }
    }
  }

  if (existing) {
    await db("gp_message_log")
      .where("id", existing.id)
      .update({
        ...messageRow,
        status: "queued",
        postmark_message_id: null,
        provider_response: null,
        sent_at: null,
        delivered_at: null,
        opened_at: null,
        clicked_at: null,
        bounced_at: null,
        complained_at: null,
        unsubscribed_at: null,
        failed_at: null,
        error_message: null,
      })
  } else {
    await db("gp_message_log").insert(messageRow)
  }

  try {
    const result = await notification.createNotifications({
      to: input.to,
      channel: "email",
      template: input.template_key,
      content: {
        subject: input.subject,
        html: outgoingHtml,
        text: input.text,
      },
      data: {
        message_stream: postmarkStream(input.stream),
        tag: input.template_key,
        template_alias: input.postmark_template_alias || null,
        template_model: input.template_model || {},
        metadata: postmarkMetadata({
          message_log_id: messageRow.id,
          template_key: input.template_key,
          stream: input.stream,
          purpose,
          order_id: input.order_id,
          cart_id: input.cart_id,
          campaign_id: input.campaign_id,
          flow_id: input.flow_id,
          ...(input.metadata || {}),
        }),
      },
    })

    const resultRecord = Array.isArray(result) ? result[0] : result
    const messageId =
      resultRecord?.provider_id ||
      resultRecord?.id ||
      resultRecord?.external_id ||
      resultRecord?.data?.id ||
      null

    await db("gp_message_log")
      .where("id", messageRow.id)
      .update({
        status: "sent",
        postmark_message_id: messageId,
        provider_response: resultRecord || {},
        sent_at: new Date(),
        updated_at: new Date(),
      })

    await recordCommunicationEvent(db, {
      event_name: "email_sent",
      email: input.to,
      profile_id: messageRow.profile_id,
      medusa_customer_id: messageRow.medusa_customer_id,
      order_id: input.order_id,
      cart_id: input.cart_id,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      template_key: input.template_key,
      message_id: messageRow.id,
      properties: {
        postmark_message_id: messageId,
        stream: input.stream,
        purpose,
        topic: input.topic,
        subject: input.subject,
      },
      context: experimentContext ? { experiment_context: experimentContext } : {},
    })

    return { ok: true, messageId: messageId || undefined }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error(`[communications] email send failed: ${error}`)
    await db("gp_message_log")
      .where("id", messageRow.id)
      .update({
        status: "failed",
        failed_at: new Date(),
        error_message: error,
        updated_at: new Date(),
      })
    await recordCommunicationEvent(db, {
      event_name: "email_failed",
      email: input.to,
      profile_id: messageRow.profile_id,
      order_id: input.order_id,
      cart_id: input.cart_id,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      template_key: input.template_key,
      message_id: messageRow.id,
      properties: { stream: input.stream, error },
      context: experimentContext ? { experiment_context: experimentContext } : {},
    })
    await emitCommunicationEmailFailureAlert({
      logger,
      input,
      purpose,
      messageLogId: messageRow.id,
      error,
    })
    return { ok: false, error }
  }
}

export function preferenceUrl(token: string): string {
  const base = (
    process.env.STOREFRONT_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "https://grillerspride.com"
  ).replace(/\/+$/, "")
  return `${base}/us/email-preferences?t=${encodeURIComponent(token)}`
}

export function verifyServiceApiKey(headers: Record<string, any>): boolean {
  const expected = [
    process.env.COMMUNICATIONS_PUBLIC_API_KEY,
    process.env.COMMUNICATIONS_API_KEY,
    process.env.NEWSLETTER_API_KEY,
  ].filter(Boolean)
  if (!expected.length) return true
  const provided =
    headers["x-api-key"] ||
    headers["X-API-Key"] ||
    headers.authorization?.replace(/^Bearer\s+/i, "")
  return expected.includes(provided)
}

export async function subscribeProfile(
  container: MedusaContainer,
  input: {
    email: string
    source?: string | null
    source_url?: string | null
    consent_version?: string | null
    preferences?: Record<string, any> | null
    ip?: string | null
    user_agent?: string | null
  }
): Promise<Record<string, any> | null> {
  const db = resolveDb(container)
  const profile = await upsertCustomerProfile(db, {
    email: input.email,
    email_consent: true,
    preferences: input.preferences || DEFAULT_NEWSLETTER_PREFERENCES,
    metadata: {
      newsletter_source: input.source || null,
      source_url: input.source_url || null,
      consent_version: input.consent_version || "v1-2026-05",
      ip: input.ip || null,
      user_agent: input.user_agent || null,
    },
  })
  if (!profile) return null

  await db("gp_suppression_preference")
    .whereNull("deleted_at")
    .where("email_lower", normalizeEmail(input.email))
    .whereIn("scope", MARKETING_SUPPRESSION_SCOPES)
    .whereNull("resubscribed_at")
    .update({ resubscribed_at: new Date(), updated_at: new Date() })

  await recordCommunicationEvent(db, {
    event_name: "email_signup",
    email: input.email,
    profile_id: profile.id,
    source: "storefront",
    properties: {
      source: input.source || null,
      consent_version: input.consent_version || "v1-2026-05",
    },
    context: {
      ip: input.ip || null,
      user_agent: input.user_agent || null,
      source_url: input.source_url || null,
    },
  })

  return profile
}

export async function requestPreferencesLink(
  container: MedusaContainer,
  email: string
): Promise<void> {
  const db = resolveDb(container)
  const emailLower = normalizeEmail(email)
  if (!emailLower) return
  const profile = await upsertCustomerProfile(db, { email })
  if (!profile?.preference_token) return

  const { buildPreferencesLinkEmail } = await import(
    "../emails/templates/preferences-link.js"
  )
  const emailContent = buildPreferencesLinkEmail({
    email,
    preferencesUrl: preferenceUrl(profile.preference_token),
  })
  await sendTrackedEmail(container, {
    to: email,
    stream: "transactional",
    purpose: "service",
    template_key: "preferences-link",
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
    topic: "preferences",
    idempotency_key: `preferences-link:${emailLower}:${Math.floor(Date.now() / 60000)}`,
    profile_id: profile.id,
  })
}

function stableWebhookPayload(value: any): any {
  if (Array.isArray(value)) return value.map(stableWebhookPayload)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableWebhookPayload(value[key])])
    )
  }
  return value
}

export function postmarkWebhookEventId(
  payload: Record<string, any>,
  traceId?: string
): string {
  const trace = typeof traceId === "string" ? traceId.trim() : ""
  const identity = trace
    ? `trace:${trace}`
    : `payload:${JSON.stringify(stableWebhookPayload(payload))}`
  return `postmark-webhook:${crypto.createHash("sha256").update(identity).digest("hex")}`
}

export function isHardPostmarkBounce(payload: Record<string, any>): boolean {
  if (payload.TypeCode !== undefined && payload.TypeCode !== null) {
    const code = Number(payload.TypeCode)
    if (Number.isFinite(code)) return [1, 100000, 100002].includes(code)
  }
  return String(payload.Type || "").toLowerCase() === "hardbounce"
}

export async function updatePostmarkMessageState(
  db: KnexLike,
  payload: Record<string, any>,
  traceId?: string
): Promise<Record<string, any> | null> {
  const eventId = postmarkWebhookEventId(payload, traceId)
  const priorEvent = await db("gp_communication_event")
    .whereNull("deleted_at")
    .where("event_id", eventId)
    .first()
  if (priorEvent) return null

  const messageId = payload.MessageID || payload.MessageId || payload.MessageID__c
  const recordType = String(payload.RecordType || payload.Type || "").toLowerCase()
  const email = payload.Recipient || payload.Email || payload.email
  const now = payload.ReceivedAt ? asDate(payload.ReceivedAt) : new Date()
  const patch: Record<string, any> = { updated_at: new Date() }
  const hardBounce = recordType.includes("bounce") && isHardPostmarkBounce(payload)

  if (recordType.includes("delivery")) {
    patch.status = "delivered"
    patch.delivered_at = now
  } else if (recordType.includes("open")) {
    patch.opened_at = now
  } else if (recordType.includes("click")) {
    patch.clicked_at = now
  } else if (recordType.includes("bounce")) {
    // Soft/transient bounces are not permanent delivery failures. Keep the
    // prior send state so the same business event cannot resend automatically.
    if (hardBounce) patch.status = "bounced"
    patch.bounced_at = now
  } else if (recordType.includes("spam")) {
    patch.status = "complained"
    patch.complained_at = now
  } else if (recordType.includes("subscription")) {
    patch.unsubscribed_at = now
  }

  let message = null as Record<string, any> | null
  if (messageId) {
    message = await db("gp_message_log")
      .whereNull("deleted_at")
      .where("postmark_message_id", messageId)
      .first()
    if (message) {
      await db("gp_message_log").where("id", message.id).update(patch)
    }
  }

  if (recordType.includes("click")) {
    await db("gp_link_click").insert({
      id: tableId("gpclk"),
      message_log_id: message?.id || null,
      postmark_message_id: messageId || null,
      profile_id: message?.profile_id || null,
      email_lower: normalizeEmail(email || message?.email),
      campaign_id: message?.campaign_id || null,
      flow_id: message?.flow_id || null,
      template_key: message?.template_key || null,
      url: payload.OriginalLink || payload.Url || payload.URL || "",
      clicked_at: now,
      user_agent: payload.UserAgent || null,
      ip: payload.IP || null,
      metadata: payload,
      created_at: new Date(),
      updated_at: new Date(),
    })
  }

  if (hardBounce) {
    await recordSuppression(db, {
      email: email || message?.email,
      scope: "hard_bounce",
      reason: "postmark_bounce",
      source: "postmark_webhook",
      metadata: payload,
    })
  }
  if (recordType.includes("spam")) {
    await recordSuppression(db, {
      email: email || message?.email,
      scope: "complaint",
      reason: "postmark_spam_complaint",
      source: "postmark_webhook",
      metadata: payload,
    })
  }
  if (recordType.includes("subscription")) {
    await recordSuppression(db, {
      email: email || message?.email,
      scope: "marketing",
      reason: "postmark_unsubscribe",
      source: "postmark_webhook",
      metadata: payload,
    })
  }

  const canonicalEventName = recordType.includes("delivery")
    ? "email_delivered"
    : recordType.includes("open")
      ? "email_opened"
      : recordType.includes("click")
        ? "email_clicked"
        : recordType.includes("bounce")
          ? "email_bounced"
          : recordType.includes("spam")
            ? "email_spam_complaint"
            : recordType.includes("subscription")
              ? "email_unsubscribed"
              : `email_${recordType || "webhook"}`

  await recordCommunicationEvent(db, {
    event_id: eventId,
    event_name: canonicalEventName,
    email: email || message?.email,
    profile_id: message?.profile_id || null,
    campaign_id: message?.campaign_id || null,
    flow_id: message?.flow_id || null,
    template_key: message?.template_key || null,
    message_id: message?.id || null,
    properties: recordType.includes("bounce")
      ? { ...payload, bounce_classification: hardBounce ? "hard" : "non_hard" }
      : payload,
  })

  return message
}
