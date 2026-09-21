import type { CommunicationEventInput } from "../../../lib/communications/core"

const BROWSER_EVENTS = new Set([
  "page_viewed",
  "identify",
  "product_viewed",
  "product_added_to_cart",
  "product_removed_from_cart",
  "product_selected_from_list",
  "cart_viewed",
  "cart_updated",
  "cart_upsell_clicked",
  "cart_upsell_added",
  "checkout_started",
  "shipping_info_submitted",
  "payment_info_submitted",
  "payment_setup_failed",
  "coupon_applied",
  "login_completed",
  "account_created",
  "email_signup",
  "wholesale_inquiry_submitted",
  "filter_applied",
  "quick_filter_applied",
  "search_performed",
  "search_results_viewed",
  "delivery_zip_checked",
  "contact_verification_viewed",
  "contact_verification_completed",
  "add_collection_to_cart",
  "experiment_blocked",
  "experiment_exposed",
  "pdp_scroll_depth",
  "wishlist_added",
  "wishlist_removed",
])

const BROWSER_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13}-[a-z0-9]{1,16})$/i
const PRIVATE_OR_OWNED_FIELDS = new Set([
  "source",
  "src",
  "event_id",
  "event_timestamp_ms",
  "user",
  "user_id",
  "customer_id",
  "medusa_customer_id",
  "profile_id",
  "order_id",
  "transaction_id",
  "flow_id",
  "template_key",
  "message_id",
  "email",
  "email_lower",
  "phone",
  "phone_number",
  "first_name",
  "last_name",
  "full_name",
  "name",
  "address",
  "shipping_address",
  "billing_address",
  "sms_consent",
  "email_consent",
  "test_order",
  "test_event",
  "livemode",
  "analytics_environment",
  "rehearsal_id",
  "analytics_consent",
  "analytics_consent_at",
  "marketing_consent",
])

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function contextSources(input: unknown): Record<string, any>[] {
  const body = record(input)
  return [
    body,
    record(body.eventn_ctx),
    record(body.context),
    record(body.properties),
    record(body.traits),
  ]
}

function cleanProperties(value: unknown): Record<string, any> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      ([key]) =>
        !PRIVATE_OR_OWNED_FIELDS.has(key) &&
        !key.toLowerCase().startsWith("sms_")
    )
  )
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined
}

export function measurementKeyConfigured(): boolean {
  return [
    process.env.COMMUNICATIONS_PUBLIC_API_KEY,
    process.env.COMMUNICATIONS_API_KEY,
    process.env.NEWSLETTER_API_KEY,
  ].some((value) => Boolean(value?.trim()))
}

export type MeasurementDecision =
  | { status: "accepted"; event: CommunicationEventInput }
  | { status: "ignored"; reason: string }
  | { status: "rejected"; reason: string; httpStatus: number }

/** Public measurement is never authority for a native order, provider outcome,
 * recipient permission or authenticated customer identity. No writes occur here. */
export function classifyMeasurement(
  input: unknown,
  expectedEvent?: "identify",
  batchEnvelope?: unknown
): MeasurementDecision {
  const secret = process.env.STRIPE_API_KEY || ""
  if (secret.startsWith("sk_test_"))
    return { status: "ignored", reason: "test_environment" }
  if (!secret.startsWith("sk_live_"))
    return {
      status: "rejected",
      reason: "measurement_environment_unknown",
      httpStatus: 503,
    }

  const body = record(input)
  const ctx = record(body.eventn_ctx || body.context)
  const properties = record(body.properties)
  const sources = contextSources(body)
  const values = (key: string, selected = sources) =>
    selected
      .filter((source) => Object.prototype.hasOwnProperty.call(source, key))
      .map((source) => source[key])
  // Batch-level exclusions may veto a member, but never supply its required
  // consent, classification, event identity or occurrence time.
  const exclusionSources = [...sources, ...contextSources(batchEnvelope)]
  const exclusions = (key: string) => values(key, exclusionSources)
  const same = (key: string, expected: unknown) => {
    const found = values(key)
    return found.length > 0 && found.every((value) => value === expected)
  }
  if (
    exclusions("test_event").includes(true) ||
    exclusions("test_order").includes(true) ||
    exclusions("livemode").includes(false) ||
    exclusions("analytics_environment").includes("rehearsal") ||
    exclusions("rehearsal_id").some(
      (value) => value !== undefined && value !== null && value !== ""
    )
  ) {
    return { status: "ignored", reason: "test_event" }
  }
  if (exclusions("analytics_consent").includes(false))
    return { status: "ignored", reason: "analytics_consent_denied" }
  const eventNames = [body.event, body.event_name, body.event_type].filter(
    (value) => value !== undefined
  )
  const eventName = expectedEvent || eventNames[0]
  if (typeof eventName !== "string" || !eventName)
    return { status: "rejected", reason: "missing_event_name", httpStatus: 400 }
  if (
    eventNames.some((name) => name !== eventName) ||
    !BROWSER_EVENTS.has(eventName)
  ) {
    return {
      status: "rejected",
      reason: "event_not_browser_owned",
      httpStatus: 400,
    }
  }
  if (!same("analytics_consent", true))
    return {
      status: "rejected",
      reason: "analytics_consent_unknown",
      httpStatus: 422,
    }
  if (
    !same("analytics_environment", "production") ||
    !same("test_event", false) ||
    values("test_order").some((value) => value !== false) ||
    values("livemode").some((value) => value !== true)
  ) {
    return {
      status: "rejected",
      reason: "measurement_context_invalid",
      httpStatus: 422,
    }
  }
  const consentAt = values("analytics_consent_at")[0]
  if (
    typeof consentAt !== "number" ||
    !Number.isFinite(consentAt) ||
    consentAt <= 0 ||
    !same("analytics_consent_at", consentAt)
  ) {
    return {
      status: "rejected",
      reason: "consent_timestamp_invalid",
      httpStatus: 422,
    }
  }
  const eventId = values("event_id")[0]
  const occurredAt = values("event_timestamp_ms")[0]
  if (
    typeof eventId !== "string" ||
    !BROWSER_ID.test(eventId) ||
    !same("event_id", eventId) ||
    typeof occurredAt !== "number" ||
    !Number.isSafeInteger(occurredAt) ||
    occurredAt < consentAt ||
    !same("event_timestamp_ms", occurredAt) ||
    !Number.isFinite(new Date(occurredAt).getTime())
  ) {
    return {
      status: "rejected",
      reason: "event_identity_or_time_invalid",
      httpStatus: 422,
    }
  }
  const trusted = {
    source: "storefront",
    analytics_environment: "production",
    test_event: false,
    analytics_consent: true,
    analytics_consent_at: consentAt,
    marketing_consent: same("marketing_consent", true),
    event_id: eventId,
    event_timestamp_ms: occurredAt,
  }
  return {
    status: "accepted",
    event: {
      event_name: eventName,
      event_id: eventId,
      source: "storefront",
      anonymous_id: text(body.anonymous_id || ctx.anonymous_id),
      session_id: text(body.session_id || ctx.session_id),
      cart_id: text(body.cart_id || ctx.cart_id),
      email: text(
        body.email ||
          ctx.email ||
          record(ctx.user).email ||
          record(body.traits).email
      ),
      customer_type: text(body.customer_type || ctx.customer_type),
      route_market: text(body.route_market || ctx.route_market),
      campaign_id: text(body.campaign_id || ctx.campaign_id),
      occurred_at: new Date(occurredAt),
      properties: {
        ...cleanProperties(properties),
        ...cleanProperties(ctx),
        ...trusted,
      },
      context: { ...cleanProperties(body.context), ...trusted },
    },
  }
}
