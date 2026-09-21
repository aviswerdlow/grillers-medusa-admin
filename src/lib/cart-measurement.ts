import { randomUUID } from "node:crypto"
import {
  recordCommunicationEvent,
  upsertCustomerProfile,
} from "./communications/core"
import {
  cartItemCount,
  deriveCartCustomerType,
  deriveCartRouteMarket,
} from "./communications/cart-activity"
import {
  nativeSnapshotHash,
  type RequestMeasurementContext,
} from "./analytics/customer-measurement-context"
import { deliverNativeMeasurements } from "./native-measurement-delivery"
import type { DeliveryResult } from "./order-publication"

export const CART_MEASUREMENT_SOURCE = "medusa-native-cart-response-v1"
export const CART_MEASUREMENT_EVENT = "gp.cart_measurement_captured"
export const CART_TARGETS = [
  "native_cart_jitsu",
  "native_cart_gp",
  "native_cart_automation",
] as const
export type CartTarget = (typeof CART_TARGETS)[number]
export type CartLane = "production" | "rehearsal" | "unavailable"
export type CartMeasurement = {
  version: 1
  kind: "activity" | "created" | "expired"
  event_name: "cart_updated" | "gp_cart_created" | "gp_cart_expired"
  event_id: string
  request_id: string
  occurred_at: string
  derived_from: string | null
  lane: CartLane
  context: RequestMeasurementContext | null
  email_permission?: {
    approved: boolean
    consented_at: string | null
    profile_id: string | null
    email: string | null
  }
  cart: {
    id: string
    customer_id: string | null
    email: string | null
    native_updated_at: string | null
    completed_at: string | null
    item_count: number
    value: number | null
    currency: string | null
    customer_type: string
    route_market: string
  }
}
const text = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : null)
const date = (v: any) =>
  v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null
export function cartServerLane(): CartLane {
  const key = process.env.STRIPE_API_KEY || ""
  return key.startsWith("sk_live_")
    ? "production"
    : key.startsWith("sk_test_")
    ? "rehearsal"
    : "unavailable"
}

/** The returned native response is an observation, not a claimed commit time. */
export function captureCartResponse(
  cart: any,
  context: RequestMeasurementContext | null,
  lane: CartLane,
  observedAt = new Date(),
  requestId: string = randomUUID()
): CartMeasurement | null {
  if (
    !text(cart?.id) ||
    !cart.id.startsWith("cart_") ||
    !Array.isArray(cart.items) ||
    !Number.isFinite(observedAt.getTime())
  )
    return null
  const m = cart.metadata || {}
  if (
    m.staff_impersonation ||
    m.staff_target_customer_id ||
    m.source === "staff_impersonation"
  )
    return null
  const email = text(cart.email)
  return {
    version: 1,
    kind: "activity",
    event_name: "cart_updated",
    event_id: `native-cart:activity:${cart.id}:${requestId}`,
    request_id: requestId,
    occurred_at: observedAt.toISOString(),
    derived_from: null,
    lane,
    context:
      context && context.analytics_environment === lane
        ? JSON.parse(JSON.stringify(context))
        : null,
    cart: {
      id: cart.id,
      customer_id: text(cart.customer_id),
      email:
        email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          ? email.toLowerCase()
          : null,
      native_updated_at: date(cart.updated_at),
      completed_at: date(cart.completed_at),
      item_count: cartItemCount(cart),
      value:
        cart.total !== null &&
        cart.total !== undefined &&
        Number.isFinite(Number(cart.total))
          ? Number(cart.total)
          : null,
      currency: text(cart.currency_code)?.toLowerCase() || null,
      customer_type: deriveCartCustomerType(cart, cart.customer),
      route_market: deriveCartRouteMarket(cart, cart.customer),
    },
  }
}

export function deriveCartMeasurement(
  source: CartMeasurement,
  kind: "created" | "expired",
  at: Date
): CartMeasurement {
  return {
    ...JSON.parse(JSON.stringify(source)),
    kind,
    event_name: `gp_cart_${kind}`,
    event_id: `native-cart:${kind}:${source.cart.id}:${
      source.event_id
    }:${at.toISOString()}`,
    occurred_at: at.toISOString(),
    derived_from: source.event_id,
  }
}
export function validCartMeasurement(s: any): s is CartMeasurement {
  if (
    !s ||
    s.version !== 1 ||
    !["activity", "created", "expired"].includes(s.kind) ||
    s.event_name !==
      (s.kind === "activity" ? "cart_updated" : `gp_cart_${s.kind}`) ||
    !text(s.cart?.id)?.startsWith("cart_") ||
    !text(s.request_id) ||
    !date(s.occurred_at) ||
    !["production", "rehearsal", "unavailable"].includes(s.lane) ||
    !Number.isFinite(s.cart.item_count) ||
    s.cart.item_count < 0 ||
    (s.cart.value !== null && !Number.isFinite(s.cart.value))
  )
    return false
  const expected =
    s.kind === "activity"
      ? `native-cart:activity:${s.cart.id}:${s.request_id}`
      : `native-cart:${s.kind}:${s.cart.id}:${s.derived_from}:${s.occurred_at}`
  if (
    s.event_id !== expected ||
    (s.kind === "activity" ? s.derived_from !== null : !text(s.derived_from))
  )
    return false
  const c = s.context
  if (c === null) return true
  return (
    typeof c?.analytics_consent === "boolean" &&
    typeof c.marketing_consent === "boolean" &&
    Number.isSafeInteger(c.analytics_consent_at) &&
    c.analytics_consent_at > 0 &&
    c.analytics_consent_at <= Date.parse(s.occurred_at) &&
    typeof c.test_order === "boolean" &&
    c.analytics_environment === s.lane &&
    s.lane === (c.test_order ? "rehearsal" : "production") &&
    (c.test_order
      ? /^[a-z][a-z0-9-]{2,47}$/.test(c.rehearsal_id || "")
      : !c.rehearsal_id) &&
    ["complete", "unverified"].includes(c.experiment_context_status) &&
    Array.isArray(c.experiment_assignments) &&
    (c.analytics_consent ||
      (!c.anonymous_id && !c.session_id && !c.experiment_assignments.length))
  )
}

export async function saveCartMeasurement(db: any, snapshot: CartMeasurement) {
  if (!validCartMeasurement(snapshot))
    throw new Error("cart_measurement_source_invalid")
  const original = { ...snapshot }
  if (original.kind === "activity") delete original.email_permission
  const captureHash = nativeSnapshotHash(original)
  const prior = await db("gp_communication_event")
    .where({ event_id: snapshot.event_id })
    .whereNull("deleted_at")
    .first()
  if (prior) {
    if (
      !cartSourceFromRow(prior) ||
      prior.context.native_cart_capture_hash !== captureHash
    )
      throw new Error("cart_measurement_source_conflict")
    return prior
  }
  if (snapshot.kind === "activity") {
    const profile =
      snapshot.lane === "production" &&
      (snapshot.cart.email || snapshot.cart.customer_id)
        ? await upsertCustomerProfile(db, {
            email: snapshot.cart.email || undefined,
            medusa_customer_id: snapshot.cart.customer_id || undefined,
          })
        : null
    const consentedAt = date(profile?.email_consent_at)
    snapshot = {
      ...original,
      email_permission: {
        approved: Boolean(
          profile?.email_consent &&
            consentedAt &&
            consentedAt <= snapshot.occurred_at &&
            snapshot.cart.email &&
            profile.email_lower === snapshot.cart.email
        ),
        consented_at: consentedAt,
        profile_id: profile?.id || null,
        email: profile?.email_lower || null,
      },
    }
  } else {
    const parent = await db("gp_communication_event")
      .where({ event_id: snapshot.derived_from })
      .whereNull("deleted_at")
      .first()
    const source = cartSourceFromRow(parent)
    if (
      !source ||
      source.kind !== "activity" ||
      nativeSnapshotHash(
        deriveCartMeasurement(
          source,
          snapshot.kind,
          new Date(snapshot.occurred_at)
        )
      ) !== nativeSnapshotHash(snapshot)
    )
      throw new Error("cart_measurement_lineage_invalid")
  }
  const c = snapshot.context
  // A rehearsal/unknown source never creates or associates a production profile.
  const operational =
    snapshot.lane === "production"
      ? {
          profile_id: snapshot.email_permission?.profile_id,
          medusa_customer_id: snapshot.cart.customer_id,
          email: snapshot.cart.email,
          anonymous_id: c?.anonymous_id,
          session_id: c?.session_id,
        }
      : {}
  await recordCommunicationEvent(
    db,
    {
      event_name: snapshot.event_name,
      event_id: snapshot.event_id,
      source: CART_MEASUREMENT_SOURCE,
      ...operational,
      cart_id: snapshot.cart.id,
      occurred_at: snapshot.occurred_at,
      customer_type: snapshot.cart.customer_type,
      route_market: snapshot.cart.route_market,
      properties: {
        ...(c || {}),
        analytics_consent: c?.analytics_consent ?? null,
        test_event:
          snapshot.lane === "unavailable"
            ? null
            : snapshot.lane === "rehearsal",
        test_order:
          snapshot.lane === "unavailable"
            ? null
            : snapshot.lane === "rehearsal",
        analytics_environment: snapshot.lane,
        idempotency_key: snapshot.event_id,
        event_timestamp_ms: Date.parse(snapshot.occurred_at),
        item_count: snapshot.cart.item_count,
        value: snapshot.cart.value,
        currency: snapshot.cart.currency,
      },
      context: {
        native_cart_snapshot: snapshot,
        native_cart_hash: nativeSnapshotHash(snapshot),
        native_cart_capture_hash: captureHash,
      },
    },
    { deferSideEffects: true }
  )
  const saved = await db("gp_communication_event")
    .where({ event_id: snapshot.event_id })
    .whereNull("deleted_at")
    .first()
  if (
    !cartSourceFromRow(saved) ||
    saved.context.native_cart_capture_hash !== captureHash
  )
    throw new Error("cart_measurement_source_conflict")
  return saved
}
export function cartSourceFromRow(row: any): CartMeasurement | null {
  const s = row?.context?.native_cart_snapshot
  return row?.source === CART_MEASUREMENT_SOURCE &&
    validCartMeasurement(s) &&
    row.event_id === s.event_id &&
    row.event_name === s.event_name &&
    row.context.native_cart_hash === nativeSnapshotHash(s)
    ? s
    : null
}

export function cartMeasurementProperties(snapshot: CartMeasurement | null) {
  const c = snapshot?.context
  return {
    ...(c || {}),
    analytics_consent: c?.analytics_consent ?? null,
    test_event:
      snapshot?.lane === "production"
        ? false
        : snapshot?.lane === "rehearsal"
        ? true
        : null,
    test_order:
      snapshot?.lane === "production"
        ? false
        : snapshot?.lane === "rehearsal"
        ? true
        : null,
    analytics_environment: snapshot?.lane || "unavailable",
    experiment_context: Object.fromEntries(
      (c?.experiment_assignments || []).map((a: any) => [
        a.experiment_id,
        {
          variant_key: a.variant,
          assignment_id: a.assignment_id,
          version: a.version,
          evaluation_version: a.evaluation_version,
        },
      ])
    ),
    experiment_context_status: c?.experiment_context_status || "unverified",
  }
}

export function deliverCartMeasurements(
  db: any,
  deliver: (
    target: CartTarget,
    snapshot: CartMeasurement,
    row: any,
    trx: any
  ) => Promise<DeliveryResult>,
  now = new Date(),
  limit = 5
) {
  return deliverNativeMeasurements(
    db,
    {
      source: CART_MEASUREMENT_SOURCE,
      targets: CART_TARGETS,
      parse: cartSourceFromRow,
      hashKey: "native_cart_hash",
      lockPrefix: "gp-native-cart",
      errorPrefix: "cart_measurement",
      productionPending: (s) => s.lane === "production" && Boolean(s.context),
    },
    deliver,
    now,
    limit
  )
}
