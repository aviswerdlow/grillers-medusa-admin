import { permitsCustomerSmsDestination } from "./primary-destination"
import crypto from "crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../ops-alert"
import { recordCommunicationEvent } from "./core"
import { toE164 } from "./sms"

type KnexLike = any

const TWILIO_API = "https://api.twilio.com/2010-04-01"
const DEFAULT_PUBLIC_BACKEND_URL =
  "https://grillers-medusa-admin-production.up.railway.app"

export const ORDER_SMS_CONSENT_VERSION = "transactional-sms-v2-2026-07-11"
export const ORDER_SMS_CONSENT_DISCLOSURE =
  "Text me recurring automated Griller's Pride UPS shipping and tracking updates for this order. Message frequency varies, up to 6 messages per order, including an enrollment confirmation. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase."
export const ORDER_SMS_CONSENT_SOURCE = "checkout_order_updates"
export const ORDER_SMS_CONSENT_PROVIDER = "twilio"
export const ORDER_SMS_PROGRAM = "grillers_pride_order_updates"
export const ORDER_SMS_CONSENT_PURPOSE = "delivery_notifications"
export const ORDER_SMS_CONSENT_METHOD = "customer_checkbox"
export const ORDER_SMS_TEMPLATE_ENROLLMENT_CONFIRMATION =
  "order-sms-enrollment-confirmation"
export const ORDER_SMS_TEMPLATE_SHIPPED = "order-shipped"
export const ORDER_SMS_MAX_PER_ORDER = 6

export type OrderSmsConsent = {
  granted: true
  phone: string
  timestamp: string
  version: typeof ORDER_SMS_CONSENT_VERSION
  disclosure: typeof ORDER_SMS_CONSENT_DISCLOSURE
  source: typeof ORDER_SMS_CONSENT_SOURCE
  provider: typeof ORDER_SMS_CONSENT_PROVIDER
  program: typeof ORDER_SMS_PROGRAM
  purpose: typeof ORDER_SMS_CONSENT_PURPOSE
  method: typeof ORDER_SMS_CONSENT_METHOD
}

type OrderSmsConsentValidation =
  | { ok: true; consent: OrderSmsConsent }
  | { ok: false; reason: string }

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function envEnabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  )
}

function isAddressableNanpPhone(phone: string): boolean {
  return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone)
}

export function validateOrderSmsConsent(
  value: unknown,
  options: {
    expectedPhone?: string | null
    now?: Date
    maxAgeMs?: number
  } = {}
): OrderSmsConsentValidation {
  const record = objectValue(value)
  if (record.granted !== true) return { ok: false, reason: "not_granted" }

  const phone = toE164(record.phone)
  if (!phone || !isAddressableNanpPhone(phone)) {
    return { ok: false, reason: "invalid_phone" }
  }
  if (options.expectedPhone) {
    const expectedPhone = toE164(options.expectedPhone)
    if (!expectedPhone || expectedPhone !== phone) {
      return { ok: false, reason: "phone_mismatch" }
    }
  }

  const exactFields: Array<[string, string]> = [
    ["version", ORDER_SMS_CONSENT_VERSION],
    ["disclosure", ORDER_SMS_CONSENT_DISCLOSURE],
    ["source", ORDER_SMS_CONSENT_SOURCE],
    ["provider", ORDER_SMS_CONSENT_PROVIDER],
    ["program", ORDER_SMS_PROGRAM],
    ["purpose", ORDER_SMS_CONSENT_PURPOSE],
    ["method", ORDER_SMS_CONSENT_METHOD],
  ]
  for (const [field, expected] of exactFields) {
    if (record[field] !== expected) {
      return { ok: false, reason: `${field}_mismatch` }
    }
  }

  const timestamp = String(record.timestamp || "")
  const timestampMs = Date.parse(timestamp)
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: "invalid_timestamp" }
  }
  const nowMs = (options.now || new Date()).getTime()
  if (timestampMs > nowMs + 5 * 60 * 1000) {
    return { ok: false, reason: "timestamp_in_future" }
  }
  if (
    typeof options.maxAgeMs === "number" &&
    options.maxAgeMs >= 0 &&
    nowMs - timestampMs > options.maxAgeMs
  ) {
    return { ok: false, reason: "timestamp_too_old" }
  }

  return {
    ok: true,
    consent: {
      granted: true,
      phone,
      timestamp: new Date(timestampMs).toISOString(),
      version: ORDER_SMS_CONSENT_VERSION,
      disclosure: ORDER_SMS_CONSENT_DISCLOSURE,
      source: ORDER_SMS_CONSENT_SOURCE,
      provider: ORDER_SMS_CONSENT_PROVIDER,
      program: ORDER_SMS_PROGRAM,
      purpose: ORDER_SMS_CONSENT_PURPOSE,
      method: ORDER_SMS_CONSENT_METHOD,
    },
  }
}

function isStaffCreatedMetadata(metadata: Record<string, any>): boolean {
  const source = String(metadata.source || "")
    .trim()
    .toLowerCase()
  return (
    metadata.staff_phone_order === true ||
    metadata.staff_impersonation === true ||
    source === "staff_phone_order" ||
    source === "staff_impersonation" ||
    source === "admin_staff_reorder" ||
    source === "staff" ||
    Boolean(metadata.staff_target_customer_id) ||
    Boolean(metadata.staff_selected_customer_id)
  )
}

/**
 * Preserve unrelated cart/order metadata while retaining only a fresh,
 * exact, customer-controlled order-SMS consent snapshot. Invalid or
 * staff-originated records are removed instead of blocking checkout.
 */
export function sanitizeOrderSmsConsentMetadata(
  metadata: unknown,
  options: { now?: Date; maxAgeMs?: number; forceRemove?: boolean } = {}
): Record<string, any> {
  const source = objectValue(metadata)
  const sanitized = { ...source }
  delete sanitized.order_sms_consent

  if (options.forceRemove || isStaffCreatedMetadata(source)) return sanitized

  const validation = validateOrderSmsConsent(source.order_sms_consent, {
    now: options.now,
    maxAgeMs:
      options.maxAgeMs === undefined
        ? 7 * 24 * 60 * 60 * 1000
        : options.maxAgeMs,
  })
  if (validation.ok) sanitized.order_sms_consent = validation.consent
  return sanitized
}

function publicBackendBaseUrl(): string {
  // Signature validation must use the exact public URL Twilio called. Do not
  // derive this from Railway's internal request URL or an untrusted Host
  // header; configure the public base explicitly, with the stable production
  // domain as the final fallback.
  return String(
    process.env.TWILIO_TRANSACTIONAL_WEBHOOK_BASE_URL ||
      process.env.PUBLIC_BACKEND_URL ||
      DEFAULT_PUBLIC_BACKEND_URL
  )
    .trim()
    .replace(/\/+$/, "")
}

export function transactionalSmsInboundWebhookUrl(): string {
  return (
    process.env.TWILIO_TRANSACTIONAL_INBOUND_WEBHOOK_URL ||
    `${publicBackendBaseUrl()}/webhooks/twilio/sms/transactional`
  )
}

export function transactionalSmsStatusWebhookUrl(): string {
  return (
    process.env.TWILIO_TRANSACTIONAL_STATUS_WEBHOOK_URL ||
    `${publicBackendBaseUrl()}/webhooks/twilio/sms/transactional/status`
  )
}

const TRANSACTIONAL_MESSAGE_ID_PATTERN = /^gpmsg_[a-zA-Z0-9_-]{8,80}$/

export function transactionalSmsStatusWebhookUrlForMessage(
  messageId: unknown
): string | null {
  const normalized = String(messageId || "").trim()
  if (!TRANSACTIONAL_MESSAGE_ID_PATTERN.test(normalized)) return null
  try {
    const url = new URL(transactionalSmsStatusWebhookUrl())
    if (url.protocol !== "https:") return null
    url.hash = ""
    url.searchParams.set("gp_message_id", normalized)
    return url.toString()
  } catch {
    return null
  }
}

function transactionalSmsStatusCallbackUrlForMessage(
  messageId: string
): string | null {
  const signedUrl = transactionalSmsStatusWebhookUrlForMessage(messageId)
  if (!signedUrl) return null
  // Twilio consumes the fragment as connection policy and excludes it from
  // both the HTTP request URL and signature computation.
  return `${signedUrl}#rc=3&rp=5xx,ct,rt&rt=3000&tt=15000`
}

function transactionalTwilioConfig() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim()
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim()
  const apiKeySid = String(process.env.TWILIO_API_KEY_SID || "").trim()
  const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET || "").trim()
  const messagingServiceSid =
    String(process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID || "").trim()
  const auditFrom = toE164(process.env.TWILIO_TRANSACTIONAL_FROM) || ""
  const marketingFrom = toE164(process.env.TWILIO_MESSAGING_FROM) || ""
  const useApiKey = Boolean(apiKeySid && apiKeySecret)
  const user = useApiKey ? apiKeySid : accountSid
  const pass = useApiKey ? apiKeySecret : authToken
  const enabled = envEnabled(process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED)
  return {
    accountSid,
    auditFrom,
    authToken,
    enabled,
    marketingFrom,
    messagingServiceSid,
    pass,
    user,
    configured: Boolean(
      /^AC[a-zA-Z0-9]{30,}$/.test(accountSid) &&
        // API keys may authenticate outbound REST calls, but Twilio signs all
        // inbound/status webhooks with the account Auth Token.
        authToken &&
        user &&
        pass &&
        /^MG[a-zA-Z0-9]{30,}$/.test(messagingServiceSid) &&
        isAddressableNanpPhone(auditFrom) &&
        (!marketingFrom || marketingFrom !== auditFrom) &&
        /^https:\/\//i.test(transactionalSmsInboundWebhookUrl()) &&
        /^https:\/\//i.test(transactionalSmsStatusWebhookUrl())
    ),
  }
}

export function validateTransactionalTwilioWebhookTarget(
  params: Record<string, string>,
  kind: "inbound" | "status"
): boolean {
  const config = transactionalTwilioConfig()
  if (!config.configured) return false
  if (String(params.AccountSid || "").trim() !== config.accountSid) return false
  if (
    String(params.MessagingServiceSid || "").trim() !==
    config.messagingServiceSid
  ) {
    return false
  }
  if (kind === "inbound") {
    const to = toE164(params.To)
    if (!to || to !== config.auditFrom) return false
  } else {
    const from = toE164(params.From)
    if (!from || from !== config.auditFrom) return false
  }
  return true
}

export function transactionalSmsEnabled(): boolean {
  return transactionalTwilioConfig().enabled
}

export function transactionalSmsConfigured(): boolean {
  return transactionalTwilioConfig().configured
}

function cleanDisplayId(value: unknown): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 30)
}

function cleanTrackingNumber(value: unknown): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
}

export function buildOrderShippedSms(input: {
  displayId?: string | number | null
  trackingNumber?: string | null
}): string {
  const displayId = cleanDisplayId(input.displayId)
  const trackingNumber = cleanTrackingNumber(input.trackingNumber)
  const orderLabel = displayId ? `order #${displayId}` : "your order"
  const detail = trackingNumber
    ? ` Tracking: ${trackingNumber}.`
    : " Check your email for tracking details."
  return `Griller's Pride: ${orderLabel} has shipped.${detail} Reply STOP to stop order updates; HELP for help.`
}

export function buildOrderSmsEnrollmentConfirmation(): string {
  return "Griller's Pride Order Updates: Enrolled for recurring automated UPS shipping/tracking texts (up to 6/order). Msg & data rates may apply. Reply STOP to opt out or HELP for help."
}

export function validateOrderDeliverySmsContent(body: unknown): string | null {
  const text = String(body || "").trim()
  if (!text) return "sms_body_missing"
  if (!/griller'?s pride/i.test(text)) return "sms_brand_missing"
  if (!/\b(order|shipped|tracking|delivery)\b/i.test(text)) {
    return "sms_delivery_intent_missing"
  }
  if (
    /\b(sale|special|promotion|offer|deal|discount|coupon|new product|back in stock)\b/i.test(
      text
    )
  ) {
    return "sms_marketing_content_not_allowed"
  }
  if (!/\breply stop\b/i.test(text)) return "sms_stop_instruction_missing"
  return null
}

async function isProgramSuppressed(
  db: KnexLike,
  phone: string
): Promise<boolean> {
  const row = await db("gp_sms_program_suppression")
    .whereNull("deleted_at")
    .whereNull("restored_at")
    .where("phone_e164", phone)
    .where("program", ORDER_SMS_PROGRAM)
    .first()
  return Boolean(row)
}

async function ensureProgramSuppressed(
  db: KnexLike,
  input: {
    phone: string
    reason: string
    source: string
    messageSid?: string | null
    now?: Date
  }
): Promise<boolean> {
  const phone = toE164(input.phone)
  if (!phone || !isAddressableNanpPhone(phone)) return false
  const now = input.now || new Date()

  return db.transaction(async (trx: KnexLike) => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-sms-suppression:${ORDER_SMS_PROGRAM}:${phone}`,
    ])
    const existing = await trx("gp_sms_program_suppression")
      .whereNull("deleted_at")
      .whereNull("restored_at")
      .where("phone_e164", phone)
      .where("program", ORDER_SMS_PROGRAM)
      .first()
    if (existing) return false

    await trx("gp_sms_program_suppression").insert({
      id: `gpsmssupp_${crypto.randomBytes(8).toString("hex")}`,
      phone_e164: phone,
      program: ORDER_SMS_PROGRAM,
      reason: input.reason,
      source: input.source,
      suppressed_at: now,
      restored_at: null,
      metadata: {
        message_sid: input.messageSid || null,
        phone_last4: phone.slice(-4),
      },
      created_at: now,
      updated_at: now,
    })
    return true
  })
}

async function twilioMessageRequest(
  url: string,
  init: RequestInit
): Promise<Response> {
  const attempts = 2
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      // Twilio message creation has no caller-supplied idempotency key. A 5xx
      // can occur after acceptance, so blindly retrying it can double-send.
      // A 429 is an explicit pre-acceptance throttle and is the only safe
      // inline retry; network errors/timeouts and 5xx remain single-attempt.
      const retryable = response.status === 429
      if (retryable && attempt < attempts) {
        const retryAfterSeconds = Number(response.headers?.get?.("retry-after"))
        const delayMs = Number.isFinite(retryAfterSeconds)
          ? Math.min(1000, Math.max(0, retryAfterSeconds * 1000))
          : 200
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      return response
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new Error("twilio_retry_exhausted")
}

export type SendOrderShippedSmsInput = {
  order: {
    customer_id?: string | null
    id?: string | null
    display_id?: string | number | null
    email?: string | null
    metadata?: Record<string, any> | null
    shipping_address?: { phone?: string | null } | null
  }
  fulfillmentId: string
  trackingNumber?: string | null
}

export type SendOrderSmsEnrollmentConfirmationInput = {
  order: SendOrderShippedSmsInput["order"]
}

const ORDER_SHIPPED_SMS_FULFILLMENT_ALLOWLIST = new Set(["ups_shipping"])

export function orderShippedSmsFulfillmentEligibility(
  order: { metadata?: Record<string, any> | null } | null | undefined
): { eligible: true; fulfillmentType: string } | { eligible: false; reason: string } {
  const metadata = objectValue(order?.metadata)
  const fulfillmentType = String(
    metadata.fulfillmentType ||
      metadata.fulfillment_type ||
      metadata.deliveryMethod ||
      ""
  )
    .trim()
    .toLowerCase()

  if (fulfillmentType === "plant_pickup") {
    return { eligible: false, reason: "plant_pickup_not_shipped" }
  }
  if (!ORDER_SHIPPED_SMS_FULFILLMENT_ALLOWLIST.has(fulfillmentType)) {
    return {
      eligible: false,
      reason: fulfillmentType
        ? "fulfillment_mode_not_shippable"
        : "fulfillment_mode_missing",
    }
  }
  return { eligible: true, fulfillmentType }
}

export type SendTransactionalSmsResult = {
  ok: boolean
  skipped?: boolean
  messageSid?: string
  error?: string
}

async function sendOrderTransactionalSms(
  container: MedusaContainer,
  input: SendOrderShippedSmsInput,
  templateKey:
    | typeof ORDER_SMS_TEMPLATE_ENROLLMENT_CONFIRMATION
    | typeof ORDER_SMS_TEMPLATE_SHIPPED
): Promise<SendTransactionalSmsResult> {
  const db = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as KnexLike
  const config = transactionalTwilioConfig()
  const orderId = String(input.order?.id || "").trim()
  const fulfillmentId = String(input.fulfillmentId || "").trim()
  const enrollmentConfirmation =
    templateKey === ORDER_SMS_TEMPLATE_ENROLLMENT_CONFIRMATION

  const suppress = async (
    reason: string,
    phone?: string | null,
    extra: Record<string, unknown> = {}
  ) => {
    await recordCommunicationEvent(db, {
      event_name: "transactional_sms_suppressed",
      email: input.order?.email || null,
      order_id: orderId || null,
      template_key: templateKey,
      properties: {
        channel: "sms",
        stream: "transactional",
        purpose: ORDER_SMS_CONSENT_PURPOSE,
        program: ORDER_SMS_PROGRAM,
        phone_last4: phone ? phone.slice(-4) : null,
        reason,
        ...extra,
      },
    })
    return { ok: true, skipped: true } as SendTransactionalSmsResult
  }

  if (!orderId || (!enrollmentConfirmation && !fulfillmentId)) {
    return suppress("missing_order_or_fulfillment_id")
  }

  const metadata = objectValue(input.order?.metadata)
  if (isStaffCreatedMetadata(metadata)) {
    return suppress("staff_order_consent_not_supported")
  }
  const orderPhone = toE164(input.order?.shipping_address?.phone)
  if (!orderPhone || !isAddressableNanpPhone(orderPhone)) {
    return suppress("missing_or_invalid_order_phone")
  }
  const validation = validateOrderSmsConsent(metadata.order_sms_consent, {
    expectedPhone: orderPhone,
  })
  if (!validation.ok) {
    return suppress("missing_qualified_order_sms_consent", null, {
      consent_reason: validation.reason,
    })
  }
  const phone = validation.consent.phone
  if (!(await permitsCustomerSmsDestination(db, input.order?.customer_id, phone, validation.consent.timestamp))) {
    return suppress("retired_customer_sms_destination", phone)
  }

  const fulfillmentEligibility = orderShippedSmsFulfillmentEligibility(
    input.order
  )
  if (!fulfillmentEligibility.eligible) {
    return suppress(fulfillmentEligibility.reason, phone)
  }

  if (!config.enabled) return suppress("transactional_sms_disabled", phone)
  if (!config.configured) {
    return suppress("transactional_sms_not_configured", phone)
  }
  const body = enrollmentConfirmation
    ? buildOrderSmsEnrollmentConfirmation()
    : buildOrderShippedSms({
        displayId: input.order.display_id,
        trackingNumber: input.trackingNumber,
      })
  const contentError = validateOrderDeliverySmsContent(body)
  if (contentError) return suppress(contentError, phone)

  const trackingKey = enrollmentConfirmation
    ? validation.consent.version
    : cleanTrackingNumber(input.trackingNumber) || fulfillmentId
  const idempotencyKey = [
    "transactional-sms",
    templateKey,
    orderId,
    trackingKey,
  ].join(":")
  const now = new Date()

  type Claim =
    | { kind: "claimed"; messageId: string }
    | { kind: "duplicate"; messageSid?: string }
    | { kind: "suppressed"; reason: string }

  const claim = (await db.transaction(async (trx: KnexLike): Promise<Claim> => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-sms-suppression:${ORDER_SMS_PROGRAM}:${phone}`,
    ])
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-transactional-sms:${idempotencyKey}`,
    ])

    if (await isProgramSuppressed(trx, phone)) {
      return {
        kind: "suppressed",
        reason: "transactional_sms_program_suppressed",
      }
    }

    const existing = await trx("gp_message_log")
      .whereNull("deleted_at")
      .where("idempotency_key", idempotencyKey)
      .first()
    if (
      existing &&
      (existing.postmark_message_id ||
        ["queued", "sent", "delivered", "undelivered"].includes(
          existing.status
        ))
    ) {
      return {
        kind: "duplicate",
        messageSid: existing.postmark_message_id || undefined,
      }
    }

    const countRows = await trx("gp_message_log")
      .whereNull("deleted_at")
      .where("channel", "sms")
      .where("order_id", orderId)
      .whereRaw("metadata->>'program' = ?", [ORDER_SMS_PROGRAM])
      .whereRaw("metadata->>'purpose' = ?", [ORDER_SMS_CONSENT_PURPOSE])
      .count("id as count")
    if (Number(countRows?.[0]?.count || 0) >= ORDER_SMS_MAX_PER_ORDER) {
      return { kind: "suppressed", reason: "per_order_frequency_cap" }
    }

    const messageId =
      existing?.id || `gpmsg_${crypto.randomBytes(8).toString("hex")}`
    const row = {
      id: messageId,
      idempotency_key: idempotencyKey,
      profile_id: null,
      medusa_customer_id: input.order?.customer_id || null,
      email: input.order.email || "",
      email_lower: String(input.order.email || "").trim().toLowerCase(),
      channel: "sms",
      message_stream: "transactional",
      message_purpose: "transactional",
      topic: "order_updates",
      template_key: templateKey,
      order_id: orderId,
      subject: body.slice(0, 120),
      status: "queued",
      metadata: {
        phone,
        body_length: body.length,
        program: ORDER_SMS_PROGRAM,
        purpose: ORDER_SMS_CONSENT_PURPOSE,
        messaging_service_sid: config.messagingServiceSid,
        consent_version: validation.consent.version,
        consent_timestamp: validation.consent.timestamp,
        trigger_event: enrollmentConfirmation
          ? "order.placed"
          : "shipment.created",
        fulfillment_id: enrollmentConfirmation ? null : fulfillmentId,
        tracking_number: enrollmentConfirmation
          ? null
          : cleanTrackingNumber(input.trackingNumber) || null,
      },
      queued_at: now,
      created_at: existing?.created_at || now,
      updated_at: now,
    }
    if (existing) {
      await trx("gp_message_log")
        .where("id", existing.id)
        .update({
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
  })) as Claim

  if (claim.kind === "duplicate") {
    return { ok: true, skipped: true, messageSid: claim.messageSid }
  }
  if (claim.kind === "suppressed") return suppress(claim.reason, phone)

  let providerAcceptedSid: string | null = null
  let providerErrorCode: string | null = null
  let providerOutcomeAmbiguous = false
  try {
    // Re-check immediately before provider I/O so a STOP received after the
    // claim committed still cancels the send. Twilio's carrier block remains
    // the final protection for the unavoidable network-call race.
    if (!(await permitsCustomerSmsDestination(db, input.order?.customer_id, phone, validation.consent.timestamp))) {
      await db("gp_message_log").where("id", claim.messageId).update({ status: "suppressed",
        error_message: "retired_customer_sms_destination_after_claim", updated_at: new Date() })
      return suppress("retired_customer_sms_destination", phone, { after_claim: true })
    }
    if (await isProgramSuppressed(db, phone)) {
      await db("gp_message_log").where("id", claim.messageId).update({
        status: "suppressed",
        error_message: "transactional_sms_program_suppressed_after_claim",
        updated_at: new Date(),
      })
      return suppress("transactional_sms_program_suppressed", phone, {
        after_claim: true,
      })
    }

    const statusCallback = transactionalSmsStatusCallbackUrlForMessage(
      claim.messageId
    )
    if (!statusCallback) throw new Error("transactional_sms_callback_invalid")
    const params = new URLSearchParams({
      To: phone,
      MessagingServiceSid: config.messagingServiceSid,
      Body: body,
      StatusCallback: statusCallback,
    })
    let response: Response
    try {
      response = await twilioMessageRequest(
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
      // Timeout/network failures have an unknown provider outcome: Twilio may
      // have accepted the POST before the response was lost.
      providerOutcomeAmbiguous = true
      throw transportError
    }
    const responseBody: any = await response.json().catch(() => ({}))
    // Message resources expose `error_code`; Twilio REST error envelopes use
    // top-level `code`. Normalize both so carrier opt-outs (21610) cannot be
    // missed on a synchronous 4xx response.
    providerErrorCode =
      String(responseBody?.error_code ?? responseBody?.code ?? "").trim() ||
      null
    if (!response.ok || providerErrorCode) {
      if (response.status >= 500) providerOutcomeAmbiguous = true
      throw new Error(
        String(responseBody?.message || `twilio_http_${response.status}`)
      )
    }
    const messageSid = String(responseBody?.sid || "")
    if (!/^SM[a-zA-Z0-9]{20,}$/.test(messageSid)) {
      providerOutcomeAmbiguous = true
      throw new Error("twilio_message_sid_missing")
    }
    providerAcceptedSid = messageSid
    const initialStatus =
      normalizedDeliveryStatus(responseBody?.status) || "queued"
    const providerAcceptedAt = new Date()

    await db.transaction(async (trx: KnexLike) => {
      await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
        `gp-sms-status:${claim.messageId}`,
      ])
      const row = await trx("gp_message_log")
        .whereNull("deleted_at")
        .where("id", claim.messageId)
        .where("channel", "sms")
        .first()
      if (!row || objectValue(row.metadata).program !== ORDER_SMS_PROGRAM) {
        throw new Error("transactional_sms_claim_not_found")
      }
      const existingSid = String(row.postmark_message_id || "").trim()
      if (existingSid && existingSid !== messageSid) {
        throw new Error("transactional_sms_provider_sid_conflict")
      }

      const currentStatus = normalizedDeliveryStatus(row.status) || "queued"
      const shouldAdvance =
        STATUS_PRECEDENCE[initialStatus] > STATUS_PRECEDENCE[currentStatus]
      const finalStatus = shouldAdvance ? initialStatus : currentStatus
      const patch: Record<string, any> = {
        postmark_message_id: messageSid,
        provider_response: {
          ...objectValue(row.provider_response),
          sid: messageSid,
          status: finalStatus,
          accepted_status: initialStatus,
          messaging_service_sid: config.messagingServiceSid,
          sender_last4: config.auditFrom.slice(-4),
        },
        updated_at: providerAcceptedAt,
      }
      if (shouldAdvance) patch.status = initialStatus
      if (
        (finalStatus === "sent" || finalStatus === "delivered") &&
        !row.sent_at
      ) {
        patch.sent_at = providerAcceptedAt
      }
      if (finalStatus === "delivered" && !row.delivered_at) {
        patch.delivered_at = providerAcceptedAt
      }
      await trx("gp_message_log").where("id", row.id).update(patch)
    })
    await recordCommunicationEvent(db, {
      event_name: "transactional_sms_queued",
      email: input.order.email || null,
      order_id: orderId,
      template_key: templateKey,
      properties: {
        channel: "sms",
        stream: "transactional",
        purpose: ORDER_SMS_CONSENT_PURPOSE,
        program: ORDER_SMS_PROGRAM,
        phone_last4: phone.slice(-4),
        message_sid: messageSid,
        fulfillment_id: enrollmentConfirmation ? null : fulfillmentId,
      },
    })
    return { ok: true, messageSid }
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 300)
    if (providerErrorCode === "21610") {
      await ensureProgramSuppressed(db, {
        phone,
        reason: "twilio_21610",
        source: "twilio_send_error",
        messageSid: providerAcceptedSid,
      }).catch(() => {})
    }
    // Once Twilio has accepted the POST, never turn a local persistence race
    // into a retryable failed row: the callback carries this row's internal ID
    // and can bind the SID durably. A later event will also see queued and skip.
    if (!providerAcceptedSid && providerOutcomeAmbiguous) {
      const ambiguousAt = new Date()
      const row = await db("gp_message_log")
        .where("id", claim.messageId)
        .first()
      if (row) {
        await db("gp_message_log")
          .where("id", claim.messageId)
          .update({
            metadata: {
              ...objectValue(row.metadata),
              provider_outcome: "unknown",
              provider_outcome_at: ambiguousAt.toISOString(),
            },
            updated_at: ambiguousAt,
          })
      }
    } else if (!providerAcceptedSid) {
      await db("gp_message_log").where("id", claim.messageId).update({
        status: "failed",
        failed_at: new Date(),
        error_message: [providerErrorCode, message]
          .filter(Boolean)
          .join(": ")
          .slice(0, 300),
        updated_at: new Date(),
      })
    }
    const alertMessage = message.replace(/\+\d{10,15}/g, "[redacted-phone]")
    await emitOpsAlert({
      alertKind: "communications_transactional_sms_send_failed",
      severity: "warn",
      title: "Transactional order SMS send failed",
      path: "src/lib/communications/transactional-sms.ts",
      fingerprint: `transactional_sms_send:${templateKey}`,
      meta: {
        template_key: templateKey,
        purpose: ORDER_SMS_CONSENT_PURPOSE,
        order_id: orderId,
        message: alertMessage,
      },
    }).catch(() => {})
    return providerAcceptedSid
      ? { ok: true, messageSid: providerAcceptedSid }
      : { ok: false, error: message }
  }
}

/**
 * Emit the required, non-promotional enrollment confirmation after a valid
 * UPS-shipped order is placed. It shares the exact consent, suppression,
 * sender, idempotency, and six-per-order gates with later shipment updates.
 */
export async function sendOrderSmsEnrollmentConfirmation(
  container: MedusaContainer,
  input: SendOrderSmsEnrollmentConfirmationInput
): Promise<SendTransactionalSmsResult> {
  return sendOrderTransactionalSms(
    container,
    {
      order: input.order,
      fulfillmentId: "order.placed",
    },
    ORDER_SMS_TEMPLATE_ENROLLMENT_CONFIRMATION
  )
}

/**
 * The v2 shipment SMS send surface. Callers cannot supply arbitrary template
 * keys, purposes, or message bodies.
 */
export async function sendOrderShippedSms(
  container: MedusaContainer,
  input: SendOrderShippedSmsInput
): Promise<SendTransactionalSmsResult> {
  return sendOrderTransactionalSms(
    container,
    input,
    ORDER_SMS_TEMPLATE_SHIPPED
  )
}

export type TransactionalInboundSmsDecision = {
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
  "halt",
  "revoke",
  "optout",
])
// Toll-free carrier blocking can only be reversed by START or UNSTOP. Twilio
// explicitly documents that YES does not fully opt a blocked toll-free user
// back in, so accepting it here would make Medusa disagree with the carrier.
const START_WORDS = new Set(["start", "unstop"])

export function classifyTransactionalInboundSms(
  body: unknown
): TransactionalInboundSmsDecision {
  const word = String(body || "").trim().toLowerCase()
  if (STOP_WORDS.has(word)) {
    return {
      action: "stop",
      reply:
        "Griller's Pride order updates are stopped for this number. Reply START to restore updates for a qualifying active order.",
    }
  }
  if (START_WORDS.has(word)) {
    return {
      action: "start",
      reply:
        "Griller's Pride order updates are restored for qualifying active orders. Reply STOP to stop or HELP for help.",
    }
  }
  if (word === "help" || word === "info" || word === "support") {
    return {
      action: "help",
      reply:
        "Griller's Pride Order Updates: UPS shipping/tracking help at (770) 454-8108 or peter@grillerspride.com. Up to 6 msgs/order. Msg & data rates may apply. Reply STOP to unsubscribe.",
    }
  }
  return { action: "none" }
}

export function transactionalSmsStartNotEligibleReply(): string {
  return "Griller's Pride could not restore order updates because no qualifying active order consent was found. Choose the optional order-updates checkbox during checkout or call (770) 454-8108."
}

async function findQualifyingOrderSmsConsent(
  db: KnexLike,
  phone: string,
  now: Date
): Promise<{ orderId: string; consent: OrderSmsConsent } | null> {
  const since = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000)
  const rows = await db("order")
    .whereNull("deleted_at")
    .whereIn("status", ["pending", "requires_action"])
    .where("created_at", ">=", since)
    .whereRaw("metadata->'order_sms_consent'->>'phone' = ?", [phone])
    .whereRaw("metadata->'order_sms_consent'->>'version' = ?", [
      ORDER_SMS_CONSENT_VERSION,
    ])
    .whereRaw("metadata->'order_sms_consent'->>'program' = ?", [
      ORDER_SMS_PROGRAM,
    ])
    .orderBy("created_at", "desc")
    .limit(25)
    .select("id", "metadata", "status", "created_at")

  for (const row of rows || []) {
    const metadata = objectValue(row.metadata)
    if (isStaffCreatedMetadata(metadata)) continue
    if (!["pending", "requires_action"].includes(String(row.status || ""))) {
      continue
    }
    if (!orderShippedSmsFulfillmentEligibility({ metadata }).eligible) continue
    const validation = validateOrderSmsConsent(metadata.order_sms_consent, {
      expectedPhone: phone,
      now,
    })
    if (validation.ok) {
      return { orderId: String(row.id), consent: validation.consent }
    }
  }
  return null
}

export async function applyTransactionalSmsKeyword(
  db: KnexLike,
  input: {
    phone: string
    action: "stop" | "start"
    messageSid?: string | null
    now?: Date
  }
): Promise<{ updated: number; eligible: boolean }> {
  const phone = toE164(input.phone)
  if (!phone || !isAddressableNanpPhone(phone)) {
    return { updated: 0, eligible: false }
  }
  const now = input.now || new Date()

  type KeywordResult = {
    updated: number
    eligible: boolean
    eventName?: string
    orderId?: string | null
    source?: string
  }
  const result = (await db.transaction(async (
    trx: KnexLike
  ): Promise<KeywordResult> => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-sms-suppression:${ORDER_SMS_PROGRAM}:${phone}`,
    ])
    const active = await trx("gp_sms_program_suppression")
      .whereNull("deleted_at")
      .whereNull("restored_at")
      .where("phone_e164", phone)
      .where("program", ORDER_SMS_PROGRAM)
      .first()

    if (input.action === "stop") {
      if (active) return { updated: 0, eligible: true }
      await trx("gp_sms_program_suppression").insert({
        id: `gpsmssupp_${crypto.randomBytes(8).toString("hex")}`,
        phone_e164: phone,
        program: ORDER_SMS_PROGRAM,
        reason: "keyword_stop",
        source: "twilio_inbound",
        suppressed_at: now,
        restored_at: null,
        metadata: {
          message_sid: input.messageSid || null,
          phone_last4: phone.slice(-4),
        },
        created_at: now,
        updated_at: now,
      })
      return {
        updated: 1,
        eligible: true,
        eventName: "transactional_sms_opt_out",
        source: "twilio_inbound",
      }
    }

    const qualifying = await findQualifyingOrderSmsConsent(trx, phone, now)
    if (!qualifying) return { updated: 0, eligible: false }
    if (!active) return { updated: 0, eligible: true }

    await trx("gp_sms_program_suppression")
      .where("id", active.id)
      .update({
        restored_at: now,
        metadata: {
          ...objectValue(active.metadata),
          restored_by_message_sid: input.messageSid || null,
          restored_for_order_id: qualifying.orderId,
        },
        updated_at: now,
      })
    return {
      updated: 1,
      eligible: true,
      eventName: "transactional_sms_opt_in_restored",
      orderId: qualifying.orderId,
      source: "twilio_inbound_start",
    }
  })) as KeywordResult

  // This routine writes destinations/queues in addition to the event row.
  // Never await that external work while holding the per-phone DB lock.
  if (result.eventName) {
    await recordCommunicationEvent(db, {
      event_name: result.eventName,
      order_id: result.orderId || null,
      properties: {
        channel: "sms",
        program: ORDER_SMS_PROGRAM,
        phone_last4: phone.slice(-4),
        source: result.source,
      },
    })
  }
  return { updated: result.updated, eligible: result.eligible }
}

function verifySignatureWithToken(input: {
  authToken: string
  signature: string
  url: string
  params: Record<string, string>
}): boolean {
  if (!input.authToken || !input.signature || !input.url) return false
  const data =
    input.url +
    Object.keys(input.params)
      .sort()
      .map((key) => `${key}${input.params[key]}`)
      .join("")
  const expected = crypto
    .createHmac("sha1", input.authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64")
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(input.signature)
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  )
}

/** Unlike the legacy marketing webhook helper, this always fails closed. */
export function verifyTransactionalTwilioSignature(input: {
  signature: string
  url: string
  params: Record<string, string>
}): boolean {
  return verifySignatureWithToken({
    ...input,
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
  })
}

export function twilioFormParams(req: any): Record<string, string> {
  const body = req?.body
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    return Object.fromEntries(
      Object.entries(body)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value as string])
    )
  }
  const raw = req?.rawBody
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw.toString === "function"
        ? raw.toString("utf8")
        : ""
  return Object.fromEntries(new URLSearchParams(text).entries())
}

type NormalizedDeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed"

function normalizedDeliveryStatus(value: unknown): NormalizedDeliveryStatus | null {
  const status = String(value || "").trim().toLowerCase()
  if (["accepted", "scheduled", "queued"].includes(status)) return "queued"
  if (["sending", "sent"].includes(status)) return "sent"
  if (status === "delivered") return "delivered"
  if (status === "undelivered") return "undelivered"
  if (status === "failed") return "failed"
  return null
}

const STATUS_PRECEDENCE: Record<NormalizedDeliveryStatus, number> = {
  queued: 10,
  sent: 20,
  failed: 30,
  undelivered: 30,
  delivered: 40,
}

export async function applyTransactionalSmsStatus(
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
  const nextStatus = normalizedDeliveryStatus(input.messageStatus)
  const config = transactionalTwilioConfig()
  if (
    !TRANSACTIONAL_MESSAGE_ID_PATTERN.test(messageLogId) ||
    !/^SM[a-zA-Z0-9_]{3,}$/.test(messageSid) ||
    !nextStatus ||
    messagingServiceSid !== config.messagingServiceSid
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
    const metadata = objectValue(row?.metadata)
    if (
      !row ||
      metadata.program !== ORDER_SMS_PROGRAM ||
      metadata.messaging_service_sid !== messagingServiceSid
    ) {
      return { found: false, updated: false }
    }
    const existingSid = String(row.postmark_message_id || "").trim()
    if (existingSid && existingSid !== messageSid) {
      return { found: false, updated: false }
    }

    const currentStatus = normalizedDeliveryStatus(row.status) || "queued"
    const currentPrecedence = STATUS_PRECEDENCE[currentStatus]
    const nextPrecedence = STATUS_PRECEDENCE[nextStatus]
    const statusAdvances = nextPrecedence > currentPrecedence
    const statusConflictsAtSamePrecedence =
      nextPrecedence === currentPrecedence && nextStatus !== currentStatus
    const errorCode = String(input.errorCode || "").trim() || null
    const errorMessage = String(input.errorMessage || "").trim() || null
    const priorCallback = objectValue(
      objectValue(row.provider_response).status_callback
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
      (!bindsSid && statusConflictsAtSamePrecedence) ||
      (!statusAdvances && !bindsSid && !enrichesTerminalError)
    ) {
      return { found: true, updated: false, status: currentStatus }
    }

    const now = input.now || new Date()
    const finalStatus = statusAdvances ? nextStatus : currentStatus
    const providerResponse = {
      ...objectValue(row.provider_response),
      sid: messageSid,
      status: finalStatus,
      messaging_service_sid: messagingServiceSid,
      status_callback: {
        received_at: now.toISOString(),
        message_status: String(input.messageStatus || ""),
        error_code: errorCode,
        error_message: errorMessage,
      },
    }
    const patch: Record<string, any> = {
      postmark_message_id: messageSid,
      provider_response: providerResponse,
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
      const phone = toE164(metadata.phone)
      if (phone && isAddressableNanpPhone(phone)) {
        await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
          `gp-sms-suppression:${ORDER_SMS_PROGRAM}:${phone}`,
        ])
        const active = await trx("gp_sms_program_suppression")
          .whereNull("deleted_at")
          .whereNull("restored_at")
          .where("phone_e164", phone)
          .where("program", ORDER_SMS_PROGRAM)
          .first()
        if (!active) {
          await trx("gp_sms_program_suppression").insert({
            id: `gpsmssupp_${crypto.randomBytes(8).toString("hex")}`,
            phone_e164: phone,
            program: ORDER_SMS_PROGRAM,
            reason: "twilio_21610",
            source: "twilio_status_callback",
            suppressed_at: now,
            restored_at: null,
            metadata: {
              message_sid: messageSid,
              phone_last4: phone.slice(-4),
            },
            created_at: now,
            updated_at: now,
          })
        }
      }
    }
    return {
      found: true,
      updated: true,
      status: finalStatus,
      event: statusAdvances
        ? {
            event_name: `transactional_sms_${nextStatus}`,
            email: row.email || null,
            profile_id: row.profile_id || null,
            order_id: row.order_id || null,
            template_key: row.template_key || ORDER_SMS_TEMPLATE_SHIPPED,
            properties: {
              channel: "sms",
              program: ORDER_SMS_PROGRAM,
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
