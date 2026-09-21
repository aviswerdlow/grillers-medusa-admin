import { AbstractAnalyticsProviderService } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import type {
  ProviderTrackAnalyticsEventDTO,
  ProviderIdentifyAnalyticsEventDTO,
} from "@medusajs/types"
import { createHash, randomUUID } from "crypto"
import { emitOpsAlert } from "../../lib/ops-alert"
import { PUBLICATION_EVENTS, publicationEligibility, type DeliveryResult, type PublicationTarget } from "../../lib/order-publication"
import { rehearsalRoute, type RehearsalOptions, type RehearsalTarget } from "../../lib/order-publication-rehearsal"

type InjectedDependencies = {
  logger: Logger
}

type Options = {
  jitsuHost: string
  jitsuServerSecret: string
  gpAnalyticsEndpoint?: string
  gpAnalyticsServerKey?: string
  gpAnalyticsDualRun?: boolean
  rehearsal?: RehearsalOptions
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GP_ANALYTICS_UUID_NAMESPACE = "da4ce64b-035f-5f38-95cb-a0d24ecb5fd7"
// Anchor for deterministically-derived timestamps (2024-01-01T00:00:00Z). Used
// ONLY as a last resort when no real occurred-at is available; the same
// idempotency seed always maps to the same instant so replays stay
// byte-identical for ReplacingMergeTree. Real order events always carry
// order_created_at, so this path is for identity/seed-only ad-hoc events.
const GP_ANALYTICS_EPOCH_MS = Date.UTC(2024, 0, 1)
// Bound the derived offset to ~2 years so a fallback timestamp lands in a sane
// DateTime window (and a sane monthly partition) rather than the far future.
const MAX_DERIVED_OFFSET_MS = 2 * 365 * 24 * 60 * 60 * 1000
const STAFF_SOURCES = new Set([
  "staff",
  "staff_phone_order",
  "staff_impersonation",
  "admin_staff_reorder",
])
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

type AnalyticsDeliveryTarget = "jitsu" | "gp_analytics"
type AnalyticsDeliveryStage =
  | "http_rejected"
  | "request_failed"
  | "payload_build_failed"

// Raw PII must NOT land in the analytics warehouse. The GP-mirror keeps IDs and
// coarse geo (customer_id, order_id, value, zip, region) but strips anything
// that identifies a person directly. This is a DENY list applied to the
// top-level mirror properties AND to known nested PII objects (addresses).
// NOTE: this strip is applied ONLY to the GP mirror — the legacy Jitsu payload
// is left untouched so Chris's existing consumers don't break.
const GP_MIRROR_PII_DENY_KEYS = new Set([
  "email",
  "name",
  "first_name",
  "last_name",
  "full_name",
  "customer_name",
  "phone",
  "phone_number",
  "billing_address",
  "shipping_address",
  "address",
  "address_1",
  "address_2",
  "address_line_1",
  "address_line_2",
  "street",
  "street_address",
])

function stripMirrorPii(
  properties: Record<string, any>
): Record<string, any> {
  const clean: Record<string, any> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (GP_MIRROR_PII_DENY_KEYS.has(key)) continue
    clean[key] = value
  }
  return clean
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex")
}

function uuidV5(name: string): string {
  const hash = createHash("sha1")
    .update(uuidToBytes(GP_ANALYTICS_UUID_NAMESPACE))
    .update(name)
    .digest()

  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80

  const hex = hash.subarray(0, 16).toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

function redactedAnalyticsError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || "analytics failure")
  return message.replace(EMAIL_RE, "[redacted-email]").slice(0, 500)
}

class GpAnalyticsProviderService extends AbstractAnalyticsProviderService {
  static identifier = "gp-analytics"

  protected logger_: Logger
  protected options_: Options

  constructor({ logger }: InjectedDependencies, options: Options) {
    super()
    this.logger_ = logger
    this.options_ = options
  }

  private buildPayload(
    eventType: string,
    actorId?: string,
    properties?: Record<string, any>
  ): Record<string, any> {
    return {
      event_type: eventType,
      eventn_ctx: {
        event_id: randomUUID(),
        event_timestamp_ms: Date.now(),
        source: "medusa-server",
        experience_version: "medusa",
        user_id: actorId,
        ...properties,
      },
    }
  }

  private sendToJitsu(payload: Record<string, any>): void {
    const { jitsuHost, jitsuServerSecret } = this.options_

    if (!jitsuHost || !jitsuServerSecret) {
      this.logger_.warn("Analytics: Jitsu not configured, skipping event")
      return
    }

    const url = `${jitsuHost}/api/v1/s2s/event`

    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": jitsuServerSecret,
      },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (res.ok) return
        const text =
          typeof res.text === "function" ? await res.text().catch(() => "") : ""
        const firstLine = text.split(/\r?\n/)[0] || ""
        this.logger_.warn(
          `Analytics: Jitsu rejected ${payload.event_type} with ${res.status}: ${firstLine}`
        )
        await this.emitAnalyticsDeliveryFailureAlert({
          target: "jitsu",
          eventType: String(payload.event_type || "unknown"),
          stage: "http_rejected",
          status: res.status,
          error: firstLine || res.statusText || "Jitsu request rejected",
          properties: payload.eventn_ctx,
        })
      })
      .catch((err) => {
        this.logger_.error(
          `Analytics: Failed to send ${payload.event_type} to Jitsu: ${err.message}`
        )
        void this.emitAnalyticsDeliveryFailureAlert({
          target: "jitsu",
          eventType: String(payload.event_type || "unknown"),
          stage: "request_failed",
          error: err,
          properties: payload.eventn_ctx,
        }).catch(() => undefined)
      })
  }

  private emitAnalyticsDeliveryFailureAlert(input: {
    target: AnalyticsDeliveryTarget
    eventType: string
    stage: AnalyticsDeliveryStage
    status?: number
    error: unknown
    properties?: Record<string, any>
  }) {
    if (input.eventType === "ops_alert") {
      return Promise.resolve({ ok: false, skipped: true })
    }

    const properties = input.properties || {}
    const orderId = firstText(properties.order_id, properties.transaction_id)

    return emitOpsAlert({
      alertKind: "analytics_delivery_failed",
      severity: "warn",
      title: `Analytics delivery to ${input.target} failed for ${input.eventType}`,
      path: "src/modules/gp-analytics/service.ts",
      source: "medusa-server",
      logger: this.logger_,
      meta: {
        target: input.target,
        event_type: input.eventType,
        stage: input.stage,
        status: input.status ?? null,
        order_id: orderId || null,
        cart_id: firstText(properties.cart_id) || null,
        customer_id: firstText(properties.customer_id) || null,
        idempotency_key:
          firstText(properties.idempotency_key, properties.medusa_event_id) ||
          null,
        route_market: firstText(properties.route_market) || null,
        customer_type: firstText(properties.customer_type) || null,
        source: firstText(properties.source) || null,
        error: redactedAnalyticsError(input.error),
      },
    })
  }

  private routeMarket(value: any): string {
    if (
      value === "atlanta_metro" ||
      value === "southeast" ||
      value === "national"
    ) {
      return value
    }
    if (value === "core") return "atlanta_metro"
    if (value === "scheduled_pod") return "southeast"
    return "unknown"
  }

  private customerType(value: any): string {
    return value === "dtc" || value === "institutional" ? value : "unknown"
  }

  private isStaffSource(value: any): boolean {
    return STAFF_SOURCES.has(String(value || "").trim())
  }

  private fulfillmentTier(value: any): string | null {
    const text = firstText(value).toLowerCase().replace(/[\s-]+/g, "_")
    if (!text) return null

    if (text === "plant_pickup") return "plant_pickup"
    if (text === "atlanta_delivery" || text === "local_delivery") {
      return "atlanta_delivery"
    }
    if (text === "southeast_pickup" || text === "regional_pickup") {
      return "southeast_pickup"
    }
    if (text === "ups_ground" || text === "ground") return "ups_ground"
    if (
      text === "ups_3day" ||
      text === "ups_3_day_select" ||
      text === "3_day_select" ||
      text.includes("3_day")
    ) {
      return "ups_3day"
    }
    if (
      text === "ups_2da" ||
      text === "ups_2day" ||
      text === "ups_2_day" ||
      text === "ups_2nd_day_air" ||
      text === "2nd_day_air" ||
      text === "2_day_air" ||
      text.includes("2nd_day") ||
      text.includes("second_day")
    ) {
      return "ups_2da"
    }
    if (
      text === "ups_overnight" ||
      text === "overnight" ||
      text.includes("next_day")
    ) {
      return "ups_overnight"
    }
    if (text.includes("southeast") && text.includes("pickup")) {
      return "southeast_pickup"
    }
    if (text.includes("atlanta") && text.includes("delivery")) {
      return "atlanta_delivery"
    }
    if (text.includes("pickup")) return "plant_pickup"
    if (text.includes("ground")) return "ups_ground"
    if (text.includes("3_day")) return "ups_3day"
    if (text.includes("2nd_day") || text.includes("second_day")) {
      return "ups_2da"
    }
    if (text.includes("overnight")) return "ups_overnight"

    return null
  }

  // The warehouse `events` table is ReplacingMergeTree(_inserted_at) keyed on
  // (event_name, timestamp, event_id). A replay of the SAME logical event MUST
  // produce an IDENTICAL `timestamp` (derived from event_timestamp_ms) or the
  // dedup key changes and the row is duplicated — which double-counts the
  // insert-triggered daily_revenue MV. So we NEVER use Date.now() for the
  // mirror; we derive a DETERMINISTIC ms timestamp:
  //   1. an explicit occurred-at the subscriber threads through
  //      (order.created_at → occurred_at_ms / event_timestamp_ms), else
  //   2. a stable value hashed from the idempotency seed, so two replays of the
  //      same event collapse to the same instant.
  private eventTimestampMs(
    properties: Record<string, any>,
    idempotencyKey: string | null
  ): number {
    // 1. Explicit occurred-at threaded from the subscriber.
    const explicitMs = this.toEpochMs(
      properties.occurred_at_ms,
      properties.event_timestamp_ms,
      properties.occurred_at,
      properties.created_at,
      properties.order_created_at
    )
    if (explicitMs !== null) return explicitMs

    // 2. Derive a STABLE pseudo-timestamp from the idempotency seed so replays
    //    are identical. We map the seed into a bounded, deterministic offset
    //    anchored at a fixed epoch (the GP analytics launch) rather than
    //    "now", so the same seed always yields the same ms.
    const seed =
      idempotencyKey ||
      firstText(
        properties.order_id,
        properties.transaction_id,
        properties.cart_id,
        properties.medusa_event_id
      )
    if (seed) {
      const hash = createHash("sha1").update(seed).digest()
      // 6 bytes → up to ~281e12 ms (~8900 years) of offset range; anchor at the
      // GP analytics epoch so values stay within a sane DateTime range.
      const offsetMs = Number(hash.readUIntBE(0, 6))
      return GP_ANALYTICS_EPOCH_MS + (offsetMs % MAX_DERIVED_OFFSET_MS)
    }

    // 3. Last resort: a truly identity-less ad-hoc server event. There is no
    //    stable seed to dedup on, so a replay would duplicate regardless — use
    //    Date.now() so the single delivery still lands with a real timestamp.
    return Date.now()
  }

  private toEpochMs(...values: unknown[]): number | null {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) {
        // Heuristic: seconds vs milliseconds. Anything below ~1e12 is seconds.
        return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
      }
      if (typeof value === "string" && value.trim()) {
        const asNumber = Number(value)
        if (Number.isFinite(asNumber) && value.trim() === String(asNumber)) {
          return asNumber < 1e12
            ? Math.round(asNumber * 1000)
            : Math.round(asNumber)
        }
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
      if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.getTime()
      }
    }
    return null
  }

  private idempotencyKey(
    eventType: string,
    properties?: Record<string, any>
  ): string | null {
    const explicit = firstText(
      properties?.idempotency_key,
      properties?.medusa_event_id
    )
    if (explicit) return explicit

    if (!eventType.startsWith("order_")) return null

    const orderId = firstText(properties?.order_id, properties?.transaction_id)
    if (orderId) return `${eventType}:${orderId}`

    return null
  }

  private sessionId(properties?: Record<string, any>): string {
    const candidate = firstText(properties?.session_id)
    if (candidate && UUID_RE.test(candidate)) return candidate

    const deterministicSeed = firstText(
      properties?.cart_id,
      properties?.order_id,
      properties?.transaction_id
    )
    if (deterministicSeed) return uuidV5(`session:${deterministicSeed}`)

    return randomUUID()
  }

  private anonymousId(
    userId: string | undefined,
    properties?: Record<string, any>
  ): string | undefined {
    // If we already have a real user_id, the schema's anyOf is satisfied — but
    // we still backfill a stable anonymous_id so identified and (later) guest
    // events for the same order share one visitor key.
    const existing = firstText(properties?.anonymous_id)
    if (existing && UUID_RE.test(existing)) return existing

    const deterministicSeed = firstText(
      properties?.order_id,
      properties?.transaction_id,
      properties?.cart_id,
      properties?.idempotency_key,
      properties?.medusa_event_id
    )
    if (deterministicSeed) return uuidV5(`anon:${deterministicSeed}`)

    // No stable seed (e.g. an identity-less ad-hoc server event). If we have a
    // user_id the schema is already satisfied and we can leave anonymous_id
    // unset; otherwise we MUST emit something valid so the event still lands.
    if (userId) return undefined

    return randomUUID()
  }

  private sendToGpAnalytics(
    eventType: string,
    actorId?: string,
    properties?: Record<string, any>
  ): void {
    const {
      gpAnalyticsEndpoint,
      gpAnalyticsServerKey,
      gpAnalyticsDualRun = true,
    } = this.options_

    if (!gpAnalyticsEndpoint || !gpAnalyticsServerKey || !gpAnalyticsDualRun) {
      return
    }

    const sourceProperties = { ...(properties || {}) }
    const body = this.gpAnalyticsPayload(eventType, actorId, properties)

    fetch(`${gpAnalyticsEndpoint.replace(/\/$/, "")}/v1/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gpAnalyticsServerKey}`,
      },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (res.ok) return
        const text =
          typeof res.text === "function" ? await res.text().catch(() => "") : ""
        const firstLine = text.split(/\r?\n/)[0] || ""
        this.logger_.warn(
          `Analytics: GP analytics rejected ${eventType} with ${res.status}: ${firstLine}`
        )
        await this.emitAnalyticsDeliveryFailureAlert({
          target: "gp_analytics",
          eventType,
          stage: "http_rejected",
          status: res.status,
          error: firstLine || res.statusText || "GP analytics request rejected",
          properties: sourceProperties,
        })
      })
      .catch((err) => {
        this.logger_.error(
          `Analytics: Failed to send ${eventType} to GP analytics: ${err.message}`
        )
        void this.emitAnalyticsDeliveryFailureAlert({
          target: "gp_analytics",
          eventType,
          stage: "request_failed",
          error: err,
          properties: sourceProperties,
        }).catch(() => undefined)
      })
  }

  private gpAnalyticsPayload(eventType: string, actorId?: string, properties?: Record<string, any>) {
    // Work from the full producer properties to DERIVE the mirror keys
    // (session, idempotency, timestamp can read PII-adjacent fields like
    // created_at), then strip raw PII before anything is POSTed.
    const sourceProperties = { ...(properties || {}) }
    if (!sourceProperties.order_id && sourceProperties.transaction_id) {
      sourceProperties.order_id = sourceProperties.transaction_id
    }

    const sessionId = this.sessionId(sourceProperties)
    const idempotencyKey = this.idempotencyKey(eventType, sourceProperties)
    const fulfillmentTier = this.fulfillmentTier(
      sourceProperties.fulfillment_tier || sourceProperties.shipping_tier
    )
    const userId = firstText(actorId, sourceProperties.customer_id) || undefined
    // Deterministic timestamp: a replay of the same logical event must produce
    // an IDENTICAL (event_name, timestamp, event_id) so ReplacingMergeTree
    // dedups it and the insert-triggered daily_revenue MV never double-counts.
    const eventTimestampMs = this.eventTimestampMs(
      sourceProperties,
      idempotencyKey
    )

    // P2: strip raw PII from the GP mirror (email/name/phone/address). IDs and
    // coarse geo (customer_id, order_id, value, zip/region) are retained. The
    // Jitsu payload built in sendToJitsu() is unaffected.
    const mirrorProperties = stripMirrorPii(sourceProperties)

    // The warehouse schema requires either a (uuid) anonymous_id or a
    // (non-empty) user_id. Server-side order events frequently have neither —
    // guest checkouts carry no customer_id, and no anonymous_id is threaded
    // through from the storefront. Rather than silently drop those events
    // (which left ZERO order_completed rows in grillers_pride for weeks), we
    // synthesize a STABLE anonymous_id so every server event satisfies the
    // schema and lands. Stability (uuidV5 over a stable order/cart seed) keeps
    // replays idempotent and lets multiple events for one order correlate.
    const anonymousId = this.anonymousId(userId, sourceProperties)

    mirrorProperties.session_id = sessionId
    if (anonymousId) {
      mirrorProperties.anonymous_id = anonymousId
    }
    if (fulfillmentTier) {
      mirrorProperties.fulfillment_tier = fulfillmentTier
    }

    return {
      event: eventType,
      event_id: idempotencyKey ? uuidV5(idempotencyKey) : randomUUID(),
      idempotency_key: idempotencyKey || undefined,
      event_timestamp_ms: eventTimestampMs,
      user_id: userId,
      anonymous_id: anonymousId,
      session_id: String(sessionId),
      experience_version: "medusa",
      route_market: this.routeMarket(mirrorProperties.route_market),
      fulfillment_tier: fulfillmentTier,
      customer_type: this.customerType(mirrorProperties.customer_type),
      source: this.isStaffSource(mirrorProperties.source)
        ? "admin"
        : "medusa-server",
      properties: mirrorProperties,
      context: {
        library: {
          name: "grillers-medusa-admin-gp-analytics-dual-run",
          version: "0.1.0",
        },
      },
    }

  }

  /** Await a bounded transport acknowledgment. The publication journal, not
   * track(), owns retries and per-target status for accepted order events. */
  publicationRehearsalRoute(target: RehearsalTarget) {
    return rehearsalRoute(target, this.options_.rehearsal, this.options_)
  }

  async deliverOrderPublication(target: Exclude<PublicationTarget, "communications" | "communications_automation">, data: ProviderTrackAnalyticsEventDTO): Promise<DeliveryResult> {
    const p = data.properties || {}
    if (!p.idempotency_key || !Number.isFinite(p.event_timestamp_ms) || !Object.values(PUBLICATION_EVENTS).includes(data.event as any)) throw new Error("publication_transport_contract_invalid")
    return this.deliverClassifiedMeasurement(target, data)
  }

  async deliverCustomerMeasurement(target: Exclude<PublicationTarget, "communications" | "communications_automation">, data: ProviderTrackAnalyticsEventDTO): Promise<DeliveryResult> {
    const p = data.properties || {}
    if (!["customer_created", "customer_updated"].includes(data.event) || !data.actor_id ||
      !String(p.idempotency_key || "").startsWith(`native-customer:${data.event.slice(9)}:${data.actor_id}:`) ||
      !Number.isFinite(p.event_timestamp_ms)) throw new Error("customer_measurement_transport_contract_invalid")
    if (target.endsWith("_rehearsal") && p.rehearsal_id !== this.options_.rehearsal?.id)
      return { status: "held", reason: "original_rehearsal_route_unavailable" }
    const properties = stripMirrorPii(p)
    if (!UUID_RE.test(String(properties.session_id || ""))) {
      properties.session_id = uuidV5(`native-source-session:${p.idempotency_key}`)
      properties.session_context_status = "unavailable"
    } else properties.session_context_status = "captured"
    return this.deliverClassifiedMeasurement(target, { ...data, properties })
  }

  private async deliverClassifiedMeasurement(target: Exclude<PublicationTarget, "communications" | "communications_automation">, data: ProviderTrackAnalyticsEventDTO): Promise<DeliveryResult> {
    const p = data.properties || {}
    const ineligible = publicationEligibility(target, p)
    if (ineligible) return ineligible
    const rehearsal = target === "jitsu_rehearsal" || target === "gp_analytics_rehearsal"
      ? this.publicationRehearsalRoute(target) : undefined
    if (target.endsWith("_rehearsal") && !rehearsal) return { status: "held", reason: "rehearsal_isolation_not_configured" }
    const properties = rehearsal ? { ...p, analytics_environment: "rehearsal", rehearsal_id: rehearsal.id } : p
    let url: string, headers: Record<string, string>, body: any
    if (target === "jitsu" || target === "jitsu_rehearsal") {
      if (!this.options_.jitsuHost || !this.options_.jitsuServerSecret) return { status: "held", reason: "jitsu_not_configured" }
      url = rehearsal?.url || `${this.options_.jitsuHost.replace(/\/$/, "")}/api/v1/s2s/event`
      headers = { "Content-Type": "application/json", "X-Auth-Token": rehearsal?.key || this.options_.jitsuServerSecret }
      body = this.buildPayload(data.event, data.actor_id, { ...properties, event_id: uuidV5(p.idempotency_key) })
    } else {
      if (!this.options_.gpAnalyticsEndpoint || !this.options_.gpAnalyticsServerKey || (!rehearsal && this.options_.gpAnalyticsDualRun === false)) return { status: "held", reason: "gp_analytics_not_enabled" }
      url = rehearsal?.url || `${this.options_.gpAnalyticsEndpoint.replace(/\/$/, "")}/v1/track`
      headers = { "Content-Type": "application/json", Authorization: `Bearer ${rehearsal?.key || this.options_.gpAnalyticsServerKey}` }
      body = this.gpAnalyticsPayload(data.event, data.actor_id, properties)
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error" })
    // Never persist response bodies; they can include secrets or customer data.
    if (!response.ok) throw new Error("publication_transport_not_acknowledged")
    if (target === "gp_analytics_rehearsal" && (
      response.headers.get("x-gp-analytics-environment") !== "rehearsal" ||
      response.headers.get("x-gp-rehearsal-id") !== rehearsal?.id
    )) throw new Error("rehearsal_receiver_not_acknowledged")
    return { status: "accepted" }
  }

  async track(data: ProviderTrackAnalyticsEventDTO): Promise<void> {
    // Customer facts belong to the immutable native capture/recovery path.
    if (["customer_created", "customer_updated"].includes(data.event)) return
    // Fail-soft: analytics is a side-channel and must NEVER throw back into a
    // subscriber (a throw here surfaces as "Failed to track <event>" and, worse,
    // the Jitsu sink and the GP dual-run share this method — one synchronous
    // throw while building one envelope would kill BOTH. The network POSTs are
    // already fire-and-forget; this wraps the synchronous envelope-building
    // (buildPayload / uuidV5 / timestamp derivation / PII strip) so a malformed
    // property can't take down tracking. Each sink is also isolated so a failure
    // building the Jitsu payload still lets the GP mirror fire, and vice versa.
    this.logger_.debug(`Analytics: Tracking ${data.event}`)

    if (data.event !== "order_finalized") {
      try {
        const payload = this.buildPayload(
          data.event,
          data.actor_id,
          data.properties
        )
        this.sendToJitsu(payload)
      } catch (err) {
        this.logger_.error(
          `Analytics: Failed to build/send Jitsu payload for ${data.event}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        void this.emitAnalyticsDeliveryFailureAlert({
          target: "jitsu",
          eventType: data.event,
          stage: "payload_build_failed",
          error: err,
          properties: data.properties,
        }).catch(() => undefined)
      }
    }

    try {
      this.sendToGpAnalytics(data.event, data.actor_id, data.properties)
    } catch (err) {
      this.logger_.error(
        `Analytics: Failed to build/send GP analytics event for ${data.event}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      void this.emitAnalyticsDeliveryFailureAlert({
        target: "gp_analytics",
        eventType: data.event,
        stage: "payload_build_failed",
        error: err,
        properties: data.properties,
      }).catch(() => undefined)
    }
  }

  async identify(_data: ProviderIdentifyAnalyticsEventDTO): Promise<void> {
    // The old customer subscribers sent current PII without source consent.
    // Native customer events now carry the opaque actor ID; browser authenticated
    // identity continuity is a separate producer contract, not a PII fallback.
  }
}

export default GpAnalyticsProviderService
