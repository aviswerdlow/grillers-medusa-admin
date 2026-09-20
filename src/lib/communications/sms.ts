import { permitsCustomerSmsDestination } from "./primary-destination"
import crypto from "crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../ops-alert"
import {
  SMS_MARKETING_PROGRAM,
  hasQualifyingSmsMarketingConsent,
  recordCommunicationEvent,
  type CommunicationPurpose,
  type CommunicationStream,
} from "./core"
import { isInSendBlackout } from "./hebrew-calendar"

type KnexLike = any

/**
 * SMS channel for GP Comms (Twilio REST, no SDK dependency).
 *
 * Consent model (TCPA):
 *  - Marketing/lifecycle texts require profile.sms_consent — the versioned
 *    record written by signup/checkout/first-login/account-profile
 *    verification. Checked AT SEND TIME, so a STOP that landed a second ago
 *    wins.
 *  - STOP/UNSUBSCRIBE (webhook below) atomically flips consent off and stores
 *    opt-out audit metadata; Twilio's carrier-level block is a second net.
 *  - Quiet hours: without a trusted recipient timezone, marketing SMS sends
 *    only 15:00–21:00 America/New_York, a window that stays inside 9am–9pm
 *    across every US timezone. Staff tests obey it too.
 *  - Shabbat/Yom Tov blackout applies platform-wide, same as email.
 *  - Hard cap: six marketing texts per phone in any rolling 30 days,
 *    including staff tests. The existing weekly cap remains a tighter guard.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01"
const DEFAULT_PUBLIC_BACKEND_URL =
  "https://grillers-medusa-admin-production.up.railway.app"
const MARKETING_MESSAGE_ID_PATTERN = /^gpmsg_[a-zA-Z0-9_-]{8,80}$/

function publicMarketingBackendBaseUrl(): string {
  return String(
    process.env.TWILIO_MARKETING_WEBHOOK_BASE_URL ||
      process.env.PUBLIC_BACKEND_URL ||
      DEFAULT_PUBLIC_BACKEND_URL
  )
    .trim()
    .replace(/\/+$/, "")
}

export function marketingSmsInboundWebhookUrl(): string {
  return (
    process.env.TWILIO_SMS_WEBHOOK_URL ||
    `${publicMarketingBackendBaseUrl()}/webhooks/twilio/sms`
  )
}

export function marketingSmsStatusWebhookUrl(): string {
  return (
    process.env.TWILIO_MARKETING_STATUS_WEBHOOK_URL ||
    `${publicMarketingBackendBaseUrl()}/webhooks/twilio/sms/status`
  )
}

export function marketingSmsStatusWebhookUrlForMessage(
  messageId: unknown
): string | null {
  const normalized = String(messageId || "").trim()
  if (!MARKETING_MESSAGE_ID_PATTERN.test(normalized)) return null
  try {
    const url = new URL(marketingSmsStatusWebhookUrl())
    if (url.protocol !== "https:") return null
    url.hash = ""
    url.searchParams.set("gp_message_id", normalized)
    return url.toString()
  } catch {
    return null
  }
}

function marketingSmsStatusCallbackUrlForMessage(
  messageId: string
): string | null {
  const signedUrl = marketingSmsStatusWebhookUrlForMessage(messageId)
  if (!signedUrl) return null
  return `${signedUrl}#rc=3&rp=5xx,ct,rt&rt=3000&tt=15000`
}

function twilioConfig() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim()
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim()
  const apiKeySid = String(process.env.TWILIO_API_KEY_SID || "").trim()
  const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET || "").trim()
  const from = toE164(process.env.TWILIO_MESSAGING_FROM) || ""
  const messagingServiceSid = String(
    process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID || ""
  ).trim()
  const transactionalFrom = toE164(process.env.TWILIO_TRANSACTIONAL_FROM) || ""
  const transactionalServiceSid = String(
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID || ""
  ).trim()
  const useApiKey = Boolean(apiKeySid && apiKeySecret)
  const user = useApiKey ? apiKeySid : accountSid
  const pass = useApiKey ? apiKeySecret : authToken
  return {
    accountSid,
    authToken,
    from,
    messagingServiceSid,
    user,
    pass,
    configured: Boolean(
      /^AC[a-zA-Z0-9]{30,}$/.test(accountSid) &&
        authToken &&
        user &&
        pass &&
        /^MG[a-zA-Z0-9]{30,}$/.test(messagingServiceSid) &&
        /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(from) &&
        (!transactionalFrom || transactionalFrom !== from) &&
        (!transactionalServiceSid ||
          transactionalServiceSid !== messagingServiceSid) &&
        /^https:\/\//i.test(marketingSmsInboundWebhookUrl()) &&
        /^https:\/\//i.test(marketingSmsStatusWebhookUrl())
    ),
  }
}

export function smsConfigured(): boolean {
  return twilioConfig().configured
}

/** Valid NANP 10-digit US number → E.164. Returns null when not normalizable. */
export function toE164(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "")
  const ten =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null
  return `+1${ten}`
}

export function validateMarketingTwilioWebhookTarget(
  params: Record<string, string>,
  kind: "inbound" | "status"
): boolean {
  const config = twilioConfig()
  if (!config.configured) return false
  if (String(params.AccountSid || "").trim() !== config.accountSid) return false
  const callbackServiceSid = String(params.MessagingServiceSid || "").trim()
  if (
    (kind === "inbound" && callbackServiceSid !== config.messagingServiceSid) ||
    (kind === "status" &&
      callbackServiceSid &&
      callbackServiceSid !== config.messagingServiceSid)
  ) {
    return false
  }
  const senderTarget = toE164(kind === "inbound" ? params.To : params.From)
  return Boolean(senderTarget && senderTarget === config.from)
}

// ─── Quiet hours (recipient zone or conservative national window) ───

function zonedMinutesOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at)
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0)
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0)
  return (hour % 24) * 60 + minute
}

function parseHm(value: string, fallbackMinutes: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return fallbackMinutes
  return Number(m[1]) * 60 + Number(m[2])
}

export function isInSmsQuietHours(
  at: Date = new Date(),
  recipientTimeZone?: string | null
): boolean {
  let timeZone = "America/New_York"
  let conservativeNationalWindow = true
  if (recipientTimeZone) {
    try {
      // Validate before selecting the wider recipient-local window.
      zonedMinutesOfDay(at, recipientTimeZone)
      timeZone = recipientTimeZone
      conservativeNationalWindow = false
    } catch {
      // Invalid/untrusted zones stay on the conservative national window.
    }
  }
  const defaultStart = conservativeNationalWindow ? "15:00" : "09:00"
  const defaultEnd = conservativeNationalWindow ? "21:00" : "20:30"
  const start = parseHm(
    process.env.COMMS_SMS_QUIET_START || defaultStart,
    conservativeNationalWindow ? 15 * 60 : 9 * 60
  )
  const end = parseHm(
    process.env.COMMS_SMS_QUIET_END || defaultEnd,
    conservativeNationalWindow ? 21 * 60 : 20 * 60 + 30
  )
  const nowMin = zonedMinutesOfDay(at, timeZone)
  // Allowed window is [start, end); anything else is quiet.
  return !(nowMin >= start && nowMin < end)
}

export type SendTrackedSmsInput = {
  to?: string | null
  body: string
  stream: CommunicationStream
  purpose?: CommunicationPurpose
  template_key: string
  topic?: string | null
  profile_id?: string | null
  medusa_customer_id?: string | null
  flow_id?: string | null
  flow_key?: string | null
  flow_enrollment_id?: string | null
  campaign_id?: string | null
  order_id?: string | null
  cart_id?: string | null
  idempotency_key?: string | null
  /**
   * Staff-initiated test to an explicitly typed number. Consent still
   * applies, as do quiet hours, blackout, and the rolling 30-day hard cap.
   * Only the tighter weekly cap is skipped for template iteration.
   */
  staff_test?: boolean
}

export type SendTrackedSmsResult = {
  ok: boolean
  skipped?: boolean
  deferred?: boolean
  deferUntil?: Date
  messageSid?: string
  error?: string
}

export function resolveSmsPurpose(
  stream: CommunicationStream,
  purpose?: CommunicationPurpose
): CommunicationPurpose {
  if (purpose) return purpose
  if (stream === "broadcast") return "broadcast"
  if (stream === "lifecycle") return "marketing_1to1"
  return "transactional"
}

export function isSmsMarketingPurpose(purpose: CommunicationPurpose): boolean {
  return purpose === "marketing_1to1" || purpose === "broadcast"
}

const NON_MARKETING_SMS_LANGUAGE =
  /\b(order|delivery|shipping|shipment|tracking|pickup|receipt|confirmation|refund(?:ed|s|ing)?|cancel(?:l?ed|l?ing|lations?|s)?|payments?|invoices?|passwords?|account\s+verification|verification|otps?|passcodes?|(?:one[- ]time|security|authentication|login|access)\s+(?:pass)?codes?|your\s+(?:verification\s+)?code|code(?:\s+is)?\s*[:#-]?\s*\d{4,8}|return(?:ed|s|ing)?)\b/i

const MARKETING_SMS_LANGUAGE =
  /\b(seasonal|specials?|sales?|promotions?|promotional|offers?|deals?|discounts?|coupons?|new\s+products?|product\s+(?:announcements?|availability)|holiday\s+(?:sales?|promotions?|specials?)|back\s+in\s+stock)\b/i

const PUBLIC_URL_SHORTENER_HOSTS = new Set([
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "lnkd.in",
  "ow.ly",
  "rb.gy",
  "rebrand.ly",
  "shorturl.at",
  "t.co",
  "tinyurl.com",
  "v.gd",
])

function containsPublicUrlShortener(text: string): boolean {
  const domains = text.matchAll(
    /(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|\b)/gi
  )
  for (const match of domains) {
    if (PUBLIC_URL_SHORTENER_HOSTS.has(String(match[1] || "").toLowerCase())) {
      return true
    }
  }
  return false
}

export function validateSmsMarketingContent(body: unknown): string | null {
  const text = String(body || "").trim()
  if (!text) return "sms_body_missing"
  if (NON_MARKETING_SMS_LANGUAGE.test(text)) {
    return "sms_use_case_mismatch"
  }
  if (!/griller'?s pride/i.test(text)) return "sms_brand_missing"
  if (containsPublicUrlShortener(text)) return "sms_public_shortener_not_allowed"
  if (!MARKETING_SMS_LANGUAGE.test(text)) return "sms_marketing_intent_missing"
  if (
    !/\b(?:reply|text)\s+stop\b/i.test(text) ||
    !/\b(?:opt\s*out|unsubscribe)\b/i.test(text)
  ) {
    return "sms_opt_out_instruction_missing"
  }
  return null
}

function metadataObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function isoTimestamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function latestIsoTimestamp(...values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null
}

function carrierOptOutAtForPhone(
  metadata: Record<string, any>,
  phone: string | null
): string | null {
  if (!phone) return null
  const carrierEntry = metadataObject(
    metadataObject(metadata.sms_carrier_opt_outs)[phone]
  )
  const mappedOptOutAt = isoTimestamp(carrierEntry.opted_out_at)
  const legacyOptOutAt = isoTimestamp(metadata.sms_opt_out_at)
  const legacyOptOutPhone = toE164(metadata.sms_opt_out_phone)
  return latestIsoTimestamp(
    mappedOptOutAt,
    legacyOptOutPhone === phone ? legacyOptOutAt : null
  )
}

function carrierRestartAtForPhone(
  metadata: Record<string, any>,
  phone: string | null
): string | null {
  if (!phone) return null
  const carrierEntry = metadataObject(
    metadataObject(metadata.sms_carrier_opt_outs)[phone]
  )
  const mappedRestartAt = isoTimestamp(carrierEntry.restarted_at)
  const globalRestartAt = isoTimestamp(metadata.sms_consent_restart_at)
  const globalRestartPhone = toE164(metadata.sms_consent_restart_phone)
  const legacyOptOutPhone = toE164(metadata.sms_opt_out_phone)
  const matchingGlobalRestart =
    globalRestartPhone === phone ||
    (!globalRestartPhone && legacyOptOutPhone === phone)
      ? globalRestartAt
      : null
  return latestIsoTimestamp(mappedRestartAt, matchingGlobalRestart)
}

export function smsMarketingCarrierState(
  profile: Record<string, any> | null | undefined
) {
  const metadata = metadataObject(profile?.metadata)
  const currentPhone = toE164(profile?.phone)
  const legacyOptedOutAt = isoTimestamp(metadata.sms_opt_out_at)
  const legacyOptedOutPhone =
    toE164(metadata.sms_opt_out_phone) ||
    (legacyOptedOutAt ? currentPhone : null)
  const currentPhoneOptedOutAt = carrierOptOutAtForPhone(
    metadata,
    currentPhone
  )
  const optedOutAt = currentPhoneOptedOutAt || legacyOptedOutAt
  const optedOutPhone = currentPhoneOptedOutAt
    ? currentPhone
    : legacyOptedOutPhone
  const restartedAt = carrierRestartAtForPhone(metadata, optedOutPhone)
  const restartedPhone = restartedAt ? optedOutPhone : null
  const optedOutMs = optedOutAt ? new Date(optedOutAt).getTime() : null
  const restartedMs = restartedAt ? new Date(restartedAt).getTime() : null
  const stoppedCurrentPhone = Boolean(
    optedOutAt && optedOutPhone && optedOutPhone === currentPhone
  )
  const carrierRestarted = Boolean(
    optedOutMs !== null &&
      restartedMs !== null &&
      restartedMs > optedOutMs
  )

  return {
    currentPhone,
    optedOutAt,
    optedOutPhone,
    restartedAt,
    restartedPhone,
    stoppedCurrentPhone,
    carrierRestarted,
    allowed: Boolean(currentPhone && (!stoppedCurrentPhone || carrierRestarted)),
  }
}

/** Exact current-phone START marker strictly newer than a provider attempt. */
export function hasSmsCarrierRestartAfter(
  profile: Record<string, any> | null | undefined,
  destination: unknown,
  after: Date
): boolean {
  const destinationPhone = toE164(String(destination || ""))
  if (!destinationPhone || Number.isNaN(after.getTime())) {
    return false
  }
  const metadata = metadataObject(profile?.metadata)
  const restartedAt = carrierRestartAtForPhone(metadata, destinationPhone)
  if (!restartedAt || new Date(restartedAt).getTime() <= after.getTime()) {
    return false
  }
  return true
}

export function hasSmsCarrierOptOutAfter(
  profile: Record<string, any> | null | undefined,
  destination: unknown,
  after: Date
): boolean {
  const destinationPhone = toE164(String(destination || ""))
  if (!destinationPhone || Number.isNaN(after.getTime())) return false
  const optedOutAt = carrierOptOutAtForPhone(
    metadataObject(profile?.metadata),
    destinationPhone
  )
  return Boolean(
    optedOutAt && new Date(optedOutAt).getTime() > after.getTime()
  )
}

/** Send-time carrier gate, exact to the profile's current destination. */
export function hasSmsMarketingCarrierPermission(
  profile: Record<string, any> | null | undefined,
  destination: unknown
): boolean {
  const state = smsMarketingCarrierState(profile)
  const destinationPhone = toE164(String(destination || ""))
  return Boolean(
    destinationPhone &&
      destinationPhone === state.currentPhone &&
      state.allowed
  )
}

export function canRestoreSmsMarketingConsentByKeyword(
  profile: Record<string, any>,
  phone: unknown
): boolean {
  const metadata = metadataObject(profile.metadata)
  return hasQualifyingSmsMarketingConsent(
    {
      ...profile,
      sms_consent: true,
      sms_consent_at: metadata.sms_consent_at,
      metadata,
    },
    phone
  )
}

type MarketingProviderOptOutSource =
  | "twilio_send_error"
  | "twilio_status_callback"

async function persistMarketingProviderOptOut(
  db: KnexLike,
  input: {
    phone: unknown
    source: MarketingProviderOptOutSource
    messageLogId: string
    profileId?: string | null
    messageSid?: string | null
    effectiveAt: Date
    processedAt?: Date
  }
): Promise<{ updated: number }> {
  const phone = toE164(String(input.phone || ""))
  if (!phone) return { updated: 0 }
  const ten = phone.slice(-10)
  const effectiveAt = input.effectiveAt
  const processedAt = input.processedAt || new Date()
  const messageSid = String(input.messageSid || "").trim() || null
  const profileId = String(input.profileId || "").trim() || null

  await db.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
    `gp-sms-marketing-optout:${phone}`,
  ])
  const profiles = profileId
    ? await db("gp_customer_profile")
        .whereNull("deleted_at")
        .where("id", profileId)
        .forUpdate()
        .select("id", "email", "phone", "sms_consent_at", "metadata")
    : await db("gp_customer_profile")
        .whereNull("deleted_at")
        .whereRaw(
          "regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?)",
          [ten, `1${ten}`]
        )
        .forUpdate()
        .select("id", "email", "phone", "sms_consent_at", "metadata")

  let updated = 0
  for (const profile of profiles) {
    const matchesCurrentPhone = toE164(profile.phone) === phone
    const optOutEntry = {
      opted_out_at: effectiveAt.toISOString(),
      source: input.source,
      reason: "twilio_21610",
      ...(messageSid ? { message_sid: messageSid } : {}),
    }
    const topLevelMetadata = matchesCurrentPhone
      ? {
          sms_consent_status: "unsubscribed",
          sms_opt_out_at: effectiveAt.toISOString(),
          sms_opt_out_source: input.source,
          sms_opt_out_reason: "twilio_21610",
          sms_opt_out_phone: phone,
          ...(messageSid ? { sms_opt_out_message_sid: messageSid } : {}),
        }
      : {}
    const changed = await db("gp_customer_profile")
      .where("id", profile.id)
      // Written/web consent cannot lift a carrier STOP. Only an exact START
      // from this same current phone, strictly after the provider attempt,
      // beats a delayed 21610. PostgreSQL re-evaluates this predicate after
      // acquiring the row lock, so a concurrent START is ordered atomically.
      .whereRaw(
        `not (
          (
            (
              coalesce(metadata->'sms_carrier_opt_outs'->?->>'restarted_at', '') ~ ?
              and coalesce(metadata->'sms_carrier_opt_outs'->?->>'restarted_at', '') > ?
            )
            or (
              coalesce(metadata->>'sms_consent_restart_at', '') ~ ?
              and coalesce(metadata->>'sms_consent_restart_at', '') > ?
              and regexp_replace(coalesce(metadata->>'sms_consent_restart_phone', ''), '\\D', '', 'g') in (?, ?)
            )
          )
          or (
            (
              coalesce(metadata->'sms_carrier_opt_outs'->?->>'opted_out_at', '') ~ ?
              and coalesce(metadata->'sms_carrier_opt_outs'->?->>'opted_out_at', '') > ?
            )
            or (
              coalesce(metadata->>'sms_opt_out_at', '') ~ ?
              and coalesce(metadata->>'sms_opt_out_at', '') > ?
              and regexp_replace(coalesce(metadata->>'sms_opt_out_phone', ''), '\\D', '', 'g') in (?, ?)
            )
          )
        )`,
        [
          phone,
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
          phone,
          effectiveAt.toISOString(),
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
          effectiveAt.toISOString(),
          ten,
          `1${ten}`,
          phone,
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
          phone,
          effectiveAt.toISOString(),
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
          effectiveAt.toISOString(),
          ten,
          `1${ten}`,
        ]
      )
      .update({
        ...(matchesCurrentPhone
          ? { sms_consent: false, sms_consent_at: null }
          : {}),
        metadata: db.raw(
          `coalesce(metadata, '{}'::jsonb) || ?::jsonb || jsonb_build_object(
            'sms_carrier_opt_outs',
            coalesce(metadata->'sms_carrier_opt_outs', '{}'::jsonb) || ?::jsonb
          )`,
          [
            JSON.stringify(topLevelMetadata),
            JSON.stringify({ [phone]: optOutEntry }),
          ]
        ),
        // effectiveAt guards a newer customer opt-in and timestamps the STOP;
        // updated_at reflects when this database row was actually processed.
        updated_at: processedAt,
      })
    if (Number(changed || 0) < 1) continue

    await recordCommunicationEvent(db, {
      event_id: `marketing-sms-21610:${input.messageLogId}:${profile.id}`,
      event_name: "sms_opt_out",
      email: profile.email || null,
      profile_id: profile.id,
      message_id: input.messageLogId,
      properties: {
        channel: "sms",
        program: SMS_MARKETING_PROGRAM,
        phone_last4: ten.slice(-4),
        source: input.source,
        reason: "twilio_21610",
        message_sid: messageSid,
        historical_destination: !matchesCurrentPhone,
      },
    })
    updated += 1
  }
  return { updated }
}

async function applyMarketingProviderOptOut(
  db: KnexLike,
  input: Parameters<typeof persistMarketingProviderOptOut>[1]
): Promise<{ updated: number }> {
  return db.transaction((trx: KnexLike) =>
    persistMarketingProviderOptOut(trx, input)
  )
}

export async function sendTrackedSms(
  container: MedusaContainer,
  input: SendTrackedSmsInput
): Promise<SendTrackedSmsResult> {
  const db = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as KnexLike
  const now = new Date()
  const config = twilioConfig()
  const purpose = resolveSmsPurpose(input.stream, input.purpose)

  let profile = input.profile_id
    ? await db("gp_customer_profile")
        .whereNull("deleted_at")
        .where("id", input.profile_id)
        .first()
    : null

  const phone = toE164(input.to || profile?.phone)
  if (!phone) {
    return { ok: false, error: "missing_or_invalid_phone" }
  }
  if (!profile) {
    const ten = phone.slice(-10)
    profile = await db("gp_customer_profile")
      .whereNull("deleted_at")
      .whereRaw(
        "regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?)",
        [ten, `1${ten}`]
      )
      .first()
  }

  const suppress = async (reason: string, extra: Record<string, unknown> = {}) => {
    await recordCommunicationEvent(db, {
      event_name: "sms_suppressed",
      email: profile?.email || null,
      profile_id: profile?.id || input.profile_id || null,
      template_key: input.template_key,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      order_id: input.order_id,
      cart_id: input.cart_id,
      properties: {
        channel: "sms",
        stream: input.stream,
        purpose,
        topic: input.topic || null,
        phone_last4: phone.slice(-4),
        reason,
        ...extra,
      },
    })
    return { ok: true, skipped: true } as SendTrackedSmsResult
  }

  // Toll-free verification covers marketing only. Do not silently use the
  // number for order, delivery, or other transactional/service programs.
  if (!isSmsMarketingPurpose(purpose)) {
    return suppress("sms_purpose_not_approved", { purpose })
  }

  const contentError = validateSmsMarketingContent(input.body)
  if (contentError) return suppress(contentError)

  // 1) Consent at send time is keyed to message PURPOSE, not Twilio stream.
  // A one-to-one marketing flow may ride the transactional stream for
  // delivery, but it still needs the exact customer-originated v3 evidence.
  if (!(await permitsCustomerSmsDestination(db, profile?.medusa_customer_id, phone, profile?.sms_consent_at))) {
    return suppress("retired_customer_sms_destination")
  }
  if (!hasQualifyingSmsMarketingConsent(profile, phone)) {
    return suppress("missing_qualified_sms_marketing_consent")
  }
  if (!hasSmsMarketingCarrierPermission(profile, phone)) {
    return suppress("carrier_sms_opt_out_active")
  }

  // 2) Shabbat/Yom Tov, quiet hours, and caps are marketing rules and must
  // follow the semantic purpose even when the physical stream is named
  // "transactional".
  if (isSmsMarketingPurpose(purpose)) {
    const blackout = isInSendBlackout(now)
    if (blackout.blocked) {
      await recordCommunicationEvent(db, {
        event_name: "sms_deferred_blackout",
        profile_id: profile?.id || input.profile_id || null,
        template_key: input.template_key,
        campaign_id: input.campaign_id,
        flow_id: input.flow_id,
        properties: {
          channel: "sms",
          reason: blackout.reason || "shabbat_blackout",
          defer_until: blackout.until ? blackout.until.toISOString() : null,
        },
      })
      return {
        ok: false,
        deferred: true,
        deferUntil: blackout.until,
        error: "shabbat_blackout",
      }
    }

    // 3) Quiet hours (TCPA): defer every marketing send, including staff
    // tests. A test flag is never permission to send during quiet hours.
    const recipientTimeZone = String(
      metadataObject(profile?.metadata).sms_recipient_timezone || ""
    ).trim()
    if (isInSmsQuietHours(now, recipientTimeZone || null)) {
      return {
        ok: false,
        deferred: true,
        error: "sms_quiet_hours",
      }
    }

  }

  // 4) Transactional claim. The per-phone advisory lock serializes campaign,
  // flow, and staff sends so they cannot all observe count=5 and claim a
  // seventh message. Idempotency lookup and the queued-row write live under
  // the same lock. Twilio network I/O happens only after this transaction
  // commits.
  const idempotencyKey =
    input.idempotency_key ||
    [
      "sms",
      input.stream,
      input.template_key,
      phone,
      input.order_id || input.cart_id || input.campaign_id || input.flow_enrollment_id || "",
    ].join(":")
  type SmsClaim =
    | { kind: "claimed"; messageId: string }
    | { kind: "duplicate"; messageSid?: string }
    | { kind: "suppressed"; reason: string; extra: Record<string, unknown> }

  const claim = (await db.transaction(async (trx: KnexLike): Promise<SmsClaim> => {
    await trx.raw(
      "select pg_advisory_xact_lock(hashtextextended(?, 0))",
      [`gp-sms-phone:${phone}`]
    )
    await trx.raw(
      "select pg_advisory_xact_lock(hashtextextended(?, 0))",
      [`gp-sms-idempotency:${idempotencyKey}`]
    )

    const existing = await trx("gp_message_log")
      .whereNull("deleted_at")
      .where("idempotency_key", idempotencyKey)
      .first()
    if (existing && ["queued", "sent", "delivered"].includes(existing.status)) {
      return {
        kind: "duplicate",
        messageSid: existing.postmark_message_id || undefined,
      }
    }
    const countRecent = async (since: Date) => {
      const rows = await trx("gp_message_log")
        .whereNull("deleted_at")
        .where("channel", "sms")
        .whereIn("message_purpose", ["broadcast", "marketing_1to1"])
        .whereRaw("metadata->>'phone' = ?", [phone])
        .whereIn("status", ["queued", "sent", "delivered"])
        // queued_at is refreshed when a failed row is retried; immutable
        // created_at must not let an old retry evade the rolling window.
        .whereRaw("coalesce(sent_at, queued_at) >= ?", [since])
        .count("id as count")
      return Number(rows?.[0]?.count || 0)
    }

    const monthlyCap = 6
    const since30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    if ((await countRecent(since30Days)) >= monthlyCap) {
      return {
        kind: "suppressed",
        reason: "monthly_frequency_cap",
        extra: { cap: monthlyCap, window_days: 30 },
      }
    }

    const weeklyCap = Number(process.env.COMMS_SMS_WEEKLY_CAP || 2)
    if (
      !input.staff_test &&
      Number.isFinite(weeklyCap) &&
      weeklyCap > 0
    ) {
      const since7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      if ((await countRecent(since7Days)) >= weeklyCap) {
        return {
          kind: "suppressed",
          reason: "frequency_cap",
          extra: { cap: weeklyCap },
        }
      }
    }

    if (!config.configured) {
      return {
        kind: "suppressed",
        reason: "sms_not_configured",
        extra: {},
      }
    }

    const messageId =
      existing?.id || `gpmsg_${crypto.randomBytes(8).toString("hex")}`
    const row = {
      id: messageId,
      idempotency_key: idempotencyKey,
      profile_id: profile?.id || input.profile_id || null,
      medusa_customer_id:
        input.medusa_customer_id || profile?.medusa_customer_id || null,
      email: profile?.email || "",
      email_lower: (profile?.email_lower as string) || "",
      channel: "sms",
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
      subject: input.body.slice(0, 120),
      status: "queued",
      metadata: {
        phone,
        body_length: input.body.length,
        program: SMS_MARKETING_PROGRAM,
        purpose,
        messaging_service_sid: config.messagingServiceSid,
        sender_last4: config.from.slice(-4),
      },
      queued_at: now,
      created_at: existing?.created_at || now,
      updated_at: now,
    }
    if (existing) {
      await trx("gp_message_log").where("id", existing.id).update({
        ...row,
        id: undefined,
        created_at: undefined,
        failed_at: null,
        error_message: null,
        sent_at: null,
        delivered_at: null,
        postmark_message_id: null,
        provider_response: null,
      })
    } else {
      await trx("gp_message_log").insert(row)
    }
    return { kind: "claimed", messageId }
  })) as SmsClaim

  if (claim.kind === "duplicate") {
    return { ok: true, skipped: true, messageSid: claim.messageSid }
  }
  if (claim.kind === "suppressed") {
    return suppress(claim.reason, claim.extra)
  }
  const messageId = claim.messageId

  // External provider request intentionally occurs after the claim commits.
  let providerAcceptedSid: string | null = null
  let providerOutcomeAmbiguous = false
  let providerErrorCode: string | null = null
  let providerAttemptedAt: Date | null = null
  try {
    // Re-read immediately before provider I/O. A STOP can commit after the
    // queued claim but before this point; local consent must win that race.
    profile = profile?.id
      ? await db("gp_customer_profile")
          .whereNull("deleted_at")
          .where("id", profile.id)
          .first()
      : await db("gp_customer_profile")
          .whereNull("deleted_at")
          .whereRaw(
            "regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?)",
            [phone.slice(-10), `1${phone.slice(-10)}`]
          )
          .first()
    if (!(await permitsCustomerSmsDestination(db, profile?.medusa_customer_id, phone, profile?.sms_consent_at))) {
      await db("gp_message_log").where("id", messageId).update({ status: "suppressed",
        error_message: "retired_customer_sms_destination_after_claim", updated_at: new Date() })
      return suppress("retired_customer_sms_destination", { after_claim: true })
    }
    if (!hasQualifyingSmsMarketingConsent(profile, phone)) {
      await db("gp_message_log").where("id", messageId).update({
        status: "suppressed",
        error_message: "missing_qualified_sms_marketing_consent_after_claim",
        updated_at: new Date(),
      })
      return suppress("missing_qualified_sms_marketing_consent", {
        after_claim: true,
      })
    }
    if (!hasSmsMarketingCarrierPermission(profile, phone)) {
      await db("gp_message_log").where("id", messageId).update({
        status: "suppressed",
        error_message: "carrier_sms_opt_out_active_after_claim",
        updated_at: new Date(),
      })
      return suppress("carrier_sms_opt_out_active", {
        after_claim: true,
      })
    }

    const statusCallback = marketingSmsStatusCallbackUrlForMessage(messageId)
    if (!statusCallback) throw new Error("sms_status_callback_invalid")
    const params = new URLSearchParams({
      To: phone,
      MessagingServiceSid: config.messagingServiceSid,
      From: config.from,
      Body: input.body,
      StatusCallback: statusCallback,
    })
    let response: Response
    providerAttemptedAt = new Date()
    const attemptedRow = await db("gp_message_log")
      .whereNull("deleted_at")
      .where("channel", "sms")
      .where("id", messageId)
      .first()
    if (!attemptedRow) throw new Error("sms_claim_not_found")
    await db("gp_message_log").where("id", messageId).update({
      metadata: {
        ...metadataObject(attemptedRow.metadata),
        provider_attempted_at: providerAttemptedAt.toISOString(),
      },
      updated_at: providerAttemptedAt,
    })
    try {
      response = await fetch(
        `${TWILIO_API}/Accounts/${config.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.user}:${config.pass}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        }
      )
    } catch (transportError) {
      // The POST may have reached Twilio before the response was lost. Keep the
      // durable claim queued so a later flow/campaign pass cannot send twice.
      providerOutcomeAmbiguous = true
      throw transportError
    }
    const body: any = await response.json().catch(() => ({}))
    providerErrorCode =
      String(body?.error_code ?? body?.code ?? "").trim() || null
    if (!response.ok || providerErrorCode) {
      if (response.status >= 500) providerOutcomeAmbiguous = true
      throw new Error(String(body?.message || `twilio_http_${response.status}`))
    }
    const messageSid = String(body?.sid || "").trim()
    if (!/^SM[a-zA-Z0-9]{20,}$/.test(messageSid)) {
      providerOutcomeAmbiguous = true
      throw new Error("twilio_message_sid_missing")
    }
    providerAcceptedSid = messageSid
    const initialStatus =
      normalizedMarketingDeliveryStatus(body?.status) || "queued"
    const acceptedAt = new Date()
    await db.transaction(async (trx: KnexLike) => {
      await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
        `gp-sms-status:${messageId}`,
      ])
      const row = await trx("gp_message_log")
        .whereNull("deleted_at")
        .where("channel", "sms")
        .where("id", messageId)
        .first()
      const metadata = metadataObject(row?.metadata)
      if (
        !row ||
        !isSmsMarketingPurpose(row.message_purpose) ||
        metadata.program !== SMS_MARKETING_PROGRAM ||
        metadata.messaging_service_sid !== config.messagingServiceSid
      ) {
        throw new Error("sms_claim_not_found")
      }
      const existingSid = String(row.postmark_message_id || "").trim()
      if (existingSid && existingSid !== messageSid) {
        throw new Error("sms_provider_sid_conflict")
      }
      const currentStatus =
        normalizedMarketingDeliveryStatus(row.status) || "queued"
      const shouldAdvance =
        MARKETING_STATUS_PRECEDENCE[initialStatus] >
        MARKETING_STATUS_PRECEDENCE[currentStatus]
      const finalStatus = shouldAdvance ? initialStatus : currentStatus
      const patch: Record<string, any> = {
        postmark_message_id: messageSid,
        provider_response: {
          ...metadataObject(row.provider_response),
          sid: messageSid,
          status: finalStatus,
          accepted_status: initialStatus,
          messaging_service_sid: config.messagingServiceSid,
          sender_last4: config.from.slice(-4),
        },
        updated_at: acceptedAt,
      }
      if (shouldAdvance) patch.status = initialStatus
      if (
        (finalStatus === "sent" || finalStatus === "delivered") &&
        !row.sent_at
      ) {
        patch.sent_at = acceptedAt
      }
      if (finalStatus === "delivered" && !row.delivered_at) {
        patch.delivered_at = acceptedAt
      }
      await trx("gp_message_log").where("id", row.id).update(patch)
    })
    await recordCommunicationEvent(db, {
      event_id: `marketing-sms-accepted:${messageId}`,
      event_name: "sms_accepted",
      message_id: messageId,
      email: profile?.email || null,
      profile_id: profile?.id || input.profile_id || null,
      template_key: input.template_key,
      campaign_id: input.campaign_id,
      flow_id: input.flow_id,
      order_id: input.order_id,
      cart_id: input.cart_id,
      properties: {
        channel: "sms",
        stream: input.stream,
        purpose,
        phone_last4: phone.slice(-4),
        message_sid: messageSid,
      },
    })
    return { ok: true, messageSid }
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 300)
    if (providerErrorCode === "21610") {
      await applyMarketingProviderOptOut(db, {
        phone,
        source: "twilio_send_error",
        messageLogId: messageId,
        profileId: profile?.id || input.profile_id || null,
        messageSid: providerAcceptedSid,
        effectiveAt: providerAttemptedAt || new Date(),
      }).catch(async (optOutError) => {
        await emitOpsAlert({
          alertKind: "communications_sms_opt_out_persist_failed",
          severity: "page",
          title: "Marketing SMS carrier opt-out could not be persisted",
          path: "src/lib/communications/sms.ts",
          fingerprint: "marketing_sms_21610_opt_out_persist",
          meta: {
            message_id: messageId,
            message: String(optOutError).slice(0, 200),
          },
        }).catch(() => {})
      })
    }
    // Once provider acceptance is possible, never turn the row into a
    // retryable failure. The status callback carries this internal message ID
    // and can bind the provider SID later.
    if (!providerAcceptedSid && providerOutcomeAmbiguous) {
      const ambiguousAt = new Date()
      const row = await db("gp_message_log").where("id", messageId).first()
      if (row) {
        await db("gp_message_log")
          .where("id", messageId)
          .update({
            metadata: {
              ...metadataObject(row.metadata),
              provider_outcome: "unknown",
              provider_outcome_at: ambiguousAt.toISOString(),
            },
            updated_at: ambiguousAt,
          })
      }
    } else if (!providerAcceptedSid) {
      await db("gp_message_log").where("id", messageId).update({
        status: "failed",
        failed_at: new Date(),
        error_message: [providerErrorCode, message]
          .filter(Boolean)
          .join(": ")
          .slice(0, 300),
        updated_at: new Date(),
      })
    }
    await emitOpsAlert({
      alertKind: "communications_sms_send_failed",
      severity: "warn",
      title: "SMS send failed",
      path: "src/lib/communications/sms.ts",
      fingerprint: `sms_send:${input.template_key}`,
      meta: {
        template_key: input.template_key,
        stream: input.stream,
        purpose,
        message: message.slice(0, 200),
      },
    }).catch(() => {})
    return providerAcceptedSid
      ? { ok: true, messageSid: providerAcceptedSid }
      : { ok: false, error: message }
  }
}

type MarketingDeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed"

function normalizedMarketingDeliveryStatus(
  value: unknown
): MarketingDeliveryStatus | null {
  const status = String(value || "").trim().toLowerCase()
  if (["accepted", "scheduled", "queued"].includes(status)) return "queued"
  if (["sending", "sent"].includes(status)) return "sent"
  if (status === "delivered") return "delivered"
  if (status === "undelivered") return "undelivered"
  if (status === "failed") return "failed"
  return null
}

const MARKETING_STATUS_PRECEDENCE: Record<MarketingDeliveryStatus, number> = {
  queued: 10,
  sent: 20,
  failed: 30,
  undelivered: 30,
  delivered: 40,
}

export async function applyMarketingSmsStatus(
  db: KnexLike,
  input: {
    messageLogId: string
    messageSid: string
    messagingServiceSid: string
    messageStatus: string
    errorCode?: string | null
    errorMessage?: string | null
    now?: Date
  }
): Promise<{ found: boolean; updated: boolean; status?: string }> {
  const messageLogId = String(input.messageLogId || "").trim()
  const messageSid = String(input.messageSid || "").trim()
  const messagingServiceSid = String(input.messagingServiceSid || "").trim()
  const nextStatus = normalizedMarketingDeliveryStatus(input.messageStatus)
  const config = twilioConfig()
  if (
    !config.configured ||
    !MARKETING_MESSAGE_ID_PATTERN.test(messageLogId) ||
    !/^SM[a-zA-Z0-9]{20,}$/.test(messageSid) ||
    !nextStatus ||
    (messagingServiceSid && messagingServiceSid !== config.messagingServiceSid)
  ) {
    return { found: false, updated: false }
  }

  type StatusResult = {
    found: boolean
    updated: boolean
    status?: string
    event?: Parameters<typeof recordCommunicationEvent>[1]
  }
  const result = (await db.transaction(async (
    trx: KnexLike
  ): Promise<StatusResult> => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-sms-status:${messageLogId}`,
    ])
    const row = await trx("gp_message_log")
      .whereNull("deleted_at")
      .where("channel", "sms")
      .where("id", messageLogId)
      .first()
    const metadata = metadataObject(row?.metadata)
    if (
      !row ||
      !isSmsMarketingPurpose(row.message_purpose) ||
      metadata.program !== SMS_MARKETING_PROGRAM ||
      metadata.purpose !== row.message_purpose ||
      metadata.messaging_service_sid !== config.messagingServiceSid
    ) {
      return { found: false, updated: false }
    }

    const existingSid = String(row.postmark_message_id || "").trim()
    if (existingSid && existingSid !== messageSid) {
      return { found: false, updated: false }
    }
    const currentStatus =
      normalizedMarketingDeliveryStatus(row.status) || "queued"
    const currentPrecedence = MARKETING_STATUS_PRECEDENCE[currentStatus]
    const nextPrecedence = MARKETING_STATUS_PRECEDENCE[nextStatus]
    const statusAdvances = nextPrecedence > currentPrecedence
    const sameRankConflict =
      nextPrecedence === currentPrecedence && nextStatus !== currentStatus
    const errorCode = String(input.errorCode || "").trim() || null
    const errorMessage = String(input.errorMessage || "").trim() || null
    const priorCallback = metadataObject(
      metadataObject(row.provider_response).status_callback
    )
    const enrichesTerminalError =
      nextStatus === currentStatus &&
      (nextStatus === "failed" || nextStatus === "undelivered") &&
      Boolean(errorCode || errorMessage) &&
      (priorCallback.error_code !== errorCode ||
        priorCallback.error_message !== errorMessage)
    const bindsSid = !existingSid
    if (
      (!bindsSid && nextPrecedence < currentPrecedence) ||
      (!bindsSid && sameRankConflict) ||
      (!statusAdvances && !bindsSid && !enrichesTerminalError)
    ) {
      return { found: true, updated: false, status: currentStatus }
    }

    const now = input.now || new Date()
    const finalStatus = statusAdvances ? nextStatus : currentStatus
    const patch: Record<string, any> = {
      postmark_message_id: messageSid,
      provider_response: {
        ...metadataObject(row.provider_response),
        sid: messageSid,
        status: finalStatus,
        messaging_service_sid: config.messagingServiceSid,
        status_callback: {
          received_at: now.toISOString(),
          message_status: String(input.messageStatus || ""),
          error_code: errorCode,
          error_message: errorMessage,
        },
      },
      updated_at: now,
    }
    if (statusAdvances) patch.status = nextStatus
    if (finalStatus === "sent") patch.sent_at = row.sent_at || now
    if (finalStatus === "delivered") {
      patch.sent_at = row.sent_at || now
      patch.delivered_at = row.delivered_at || now
      patch.failed_at = null
      patch.error_message = null
    }
    if (finalStatus === "failed" || finalStatus === "undelivered") {
      patch.failed_at = row.failed_at || now
      patch.error_message = [errorCode, errorMessage]
        .filter(Boolean)
        .join(": ")
        .slice(0, 300)
    }
    await trx("gp_message_log").where("id", row.id).update(patch)
    if (errorCode === "21610") {
      const attemptedAtValue = isoTimestamp(metadata.provider_attempted_at)
      const attemptedAt = attemptedAtValue
        ? new Date(attemptedAtValue)
        : now
      await persistMarketingProviderOptOut(trx, {
        phone: metadata.phone,
        source: "twilio_status_callback",
        messageLogId,
        profileId: row.profile_id || null,
        messageSid,
        effectiveAt: attemptedAt,
        processedAt: now,
      })
    }

    return {
      found: true,
      updated: true,
      status: finalStatus,
      event: statusAdvances
        ? {
            event_id: `marketing-sms-status:${messageLogId}:${nextStatus}`,
            event_name: `sms_${nextStatus}`,
            message_id: messageLogId,
            email: row.email || null,
            profile_id: row.profile_id || null,
            campaign_id: row.campaign_id || null,
            flow_id: row.flow_id || null,
            template_key: row.template_key || null,
            properties: {
              channel: "sms",
              program: SMS_MARKETING_PROGRAM,
              purpose: row.message_purpose,
              message_sid: messageSid,
              status: nextStatus,
              error_code: errorCode,
            },
          }
        : undefined,
    }
  })) as StatusResult

  if (result.event) await recordCommunicationEvent(db, result.event)
  return {
    found: result.found,
    updated: result.updated,
    status: result.status,
  }
}

// ─── Inbound STOP/HELP handling ──────────────────────────────────────

export type InboundSmsDecision = {
  action: "stop" | "start" | "help" | "none"
  reply?: string
}

const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "revoke",
  "optout",
])
// Toll-free carrier blocking can only be reversed by START or UNSTOP. Treating
// YES as a local opt-in would leave Medusa subscribed while Twilio stays blocked.
const START_WORDS = new Set(["start", "unstop"])

export function classifyInboundSms(body: string): InboundSmsDecision {
  const word = String(body || "").trim().toLowerCase()
  if (STOP_WORDS.has(word)) {
    return {
      action: "stop",
      reply:
        "You've been unsubscribed from Griller's Pride marketing texts and will receive no further marketing messages. Reply START to resubscribe.",
    }
  }
  if (START_WORDS.has(word)) {
    // Twilio/carrier Advanced Opt-Out owns the START response. Local consent is
    // restored only when a prior qualifying written opt-in exists; this helper
    // must never claim restoration before that database decision is known.
    return { action: "start" }
  }
  if (word === "help" || word === "info") {
    return {
      action: "help",
      reply:
        "Griller's Pride marketing texts include seasonal specials, product announcements, promotional offers, and holiday sales deadlines, up to 6 messages/month. Msg & data rates may apply. Reply STOP to unsubscribe. Questions? (770) 454-8108.",
    }
  }
  return { action: "none" }
}

/** Apply a STOP/START to the matching profile(s) by phone. */
export async function applyInboundSmsConsentChange(
  db: KnexLike,
  phoneE164: string,
  action: "stop" | "start",
  context: { messageSid?: string | null } = {}
): Promise<{
  updated: number
  nonRestorationReason?: "no_matching_profile" | "no_qualifying_prior_opt_in"
}> {
  const normalizedPhone = toE164(phoneE164)
  if (!normalizedPhone) return { updated: 0 }
  const ten = normalizedPhone.slice(-10)
  // NANP area/exchange codes cannot begin with 0 or 1. This prevents a
  // syntactically ten-digit but non-addressable value from entering SQL.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return { updated: 0 }
  const phoneMatchSql =
    action === "start"
      ? "(regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?) or regexp_replace(coalesce(metadata->>'sms_opt_out_phone', ''), '\\D', '', 'g') in (?, ?) or coalesce(metadata->'sms_carrier_opt_outs', '{}'::jsonb) -> ? is not null)"
      : "regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?)"
  const phoneMatchBindings =
    action === "start"
      ? [ten, `1${ten}`, ten, `1${ten}`, normalizedPhone]
      : [ten, `1${ten}`]
  const profiles = await db("gp_customer_profile")
    .whereNull("deleted_at")
    .whereRaw(phoneMatchSql, phoneMatchBindings)
    .select(
      "id",
      "email",
      "email_lower",
      "phone",
      "sms_consent",
      "sms_consent_at",
      "metadata"
    )

  let updated = 0
  for (const profile of profiles) {
    const matchesCurrentPhone = toE164(profile.phone) === normalizedPhone
    const restoresWrittenConsent =
      action === "start" &&
      matchesCurrentPhone &&
      canRestoreSmsMarketingConsentByKeyword(profile, phoneE164)
    const changedAt = new Date()
    const consentChangeMetadata =
      action === "start"
        ? {
            // START always proves that Twilio's carrier-level STOP has been
            // lifted. It restores local marketing consent only when a prior
            // qualifying v3 written opt-in exists; otherwise the customer must
            // submit the authenticated web form to create fresh evidence.
            ...(matchesCurrentPhone
              ? {
                  sms_consent_status: restoresWrittenConsent
                    ? "subscribed"
                    : "not_subscribed",
                  sms_consent_restart_at: changedAt.toISOString(),
                  sms_consent_restart_source: "twilio_inbound_start",
                  sms_consent_restart_phone: normalizedPhone,
                }
              : {}),
          }
        : {
            sms_consent_status: "unsubscribed",
            sms_opt_out_at: changedAt.toISOString(),
            sms_opt_out_source: "twilio_inbound_stop",
            sms_opt_out_phone: normalizedPhone,
          }
    const carrierEntryPatch =
      action === "start"
        ? {
            restarted_at: changedAt.toISOString(),
            restart_source: "twilio_inbound_start",
          }
        : {
            opted_out_at: changedAt.toISOString(),
            source: "twilio_inbound_stop",
            reason: "keyword_stop",
          }
    const profilePatch: Record<string, any> = {
      metadata: db.raw(
        `coalesce(metadata, '{}'::jsonb) || ?::jsonb || jsonb_build_object(
          'sms_carrier_opt_outs',
          coalesce(metadata->'sms_carrier_opt_outs', '{}'::jsonb) ||
            jsonb_build_object(
              cast(? as text),
              coalesce(
                metadata->'sms_carrier_opt_outs'->cast(? as text),
                '{}'::jsonb
              ) || ?::jsonb
            )
        )`,
        [
          JSON.stringify(consentChangeMetadata),
          normalizedPhone,
          normalizedPhone,
          JSON.stringify(carrierEntryPatch),
        ]
      ),
      updated_at: changedAt,
    }
    // A START for a historical opted-out phone only clears that phone's
    // carrier marker. It must not alter valid consent for a different current
    // profile phone.
    if (action === "stop" || matchesCurrentPhone) {
      profilePatch.sms_consent =
        action === "start" ? restoresWrittenConsent : false
      profilePatch.sms_consent_at =
        action === "start" && restoresWrittenConsent ? changedAt : null
    }
    await db("gp_customer_profile").where("id", profile.id).update(profilePatch)
    if (action === "start" && !restoresWrittenConsent) {
      // The carrier restart marker was persisted, but this is intentionally
      // not counted as restored written consent.
      continue
    }
    await recordCommunicationEvent(db, {
      event_name: action === "stop" ? "sms_opt_out" : "sms_opt_in_restored",
      email: profile.email || null,
      profile_id: profile.id,
      properties: { channel: "sms", phone_last4: ten.slice(-4), source: "twilio_inbound" },
    })
    updated += 1
  }
  if (action === "start" && updated === 0) {
    const nonRestorationReason = profiles.length
      ? "no_qualifying_prior_opt_in"
      : "no_matching_profile"
    const messageSid = String(context.messageSid || "").trim()
    await recordCommunicationEvent(db, {
      event_id: /^SM[a-zA-Z0-9]{20,}$/.test(messageSid)
        ? `marketing-sms-start-not-restored:${messageSid}`
        : undefined,
      event_name: "sms_opt_in_restore_not_applied",
      properties: {
        channel: "sms",
        program: SMS_MARKETING_PROGRAM,
        phone_last4: ten.slice(-4),
        source: "twilio_inbound_start",
        reason: nonRestorationReason,
        matching_profiles: profiles.length,
        message_sid: messageSid || null,
      },
    })
    return { updated, nonRestorationReason }
  }
  return { updated }
}

/**
 * Twilio webhook signature: base64(HMAC-SHA1(url + sorted-concat params,
 * auth token)). Always fail closed when the auth token is missing.
 */
export function verifyTwilioSignature(input: {
  signature: string
  url: string
  params: Record<string, string>
}): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN || ""
  if (!authToken || !input.signature || !input.url) return false
  const data =
    input.url +
    Object.keys(input.params)
      .sort()
      .map((k) => `${k}${input.params[k]}`)
      .join("")
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64")
  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature || "")
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
