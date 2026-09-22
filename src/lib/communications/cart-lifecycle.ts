import { randomUUID } from "node:crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  cartSourceFromRow,
  deriveCartMeasurement,
  saveCartMeasurement,
  CART_MEASUREMENT_SOURCE,
  type CartMeasurement,
} from "../cart-measurement"
import { nativeSnapshotHash } from "../analytics/customer-measurement-context"

const now = () => new Date()
const CART_ACTIVITY_EVENTS = new Set([
  "cart_viewed",
  "product_added_to_cart",
  "checkout_started",
  "shipping_info_submitted",
  "payment_info_submitted",
])
const time = (v: any) =>
  v && Number.isFinite(new Date(v).getTime()) ? new Date(v) : null
const ttl = () => {
  const value = Number(process.env.COMMUNICATIONS_CART_EXPIRE_MINUTES)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 10080) : 60
}
async function lockCart(db: any, cartId: string) {
  const result = await db.raw(
    "select pg_try_advisory_xact_lock(hashtextextended(?, 0)) as locked",
    [`gp-cart-lifecycle:${cartId}`]
  )
  return result.rows[0].locked
}
async function newerCartActivity(db: any, source: CartMeasurement) {
  return db("gp_communication_event")
    .where({
      source: CART_MEASUREMENT_SOURCE,
      cart_id: source.cart.id,
      event_name: "cart_updated",
    })
    .whereNull("deleted_at")
    .where("occurred_at", ">=", source.occurred_at)
    .whereNot("event_id", source.event_id)
    .first()
}

/** Called in the saved source receipt transaction. No external side effects. */
export async function projectNativeCartActivity(
  db: any,
  snapshot: CartMeasurement,
  event: any
) {
  if (snapshot.kind !== "activity" || snapshot.lane !== "production")
    return {
      status: "excluded",
      reason: "nonproduction_cart_activity",
    } as const
  if (!(await lockCart(db, snapshot.cart.id)))
    return { status: "held", reason: "cart_projection_busy" } as const
  const existing = await db("gp_cart_lifecycle")
    .where({ cart_id: snapshot.cart.id })
    .whereNull("deleted_at")
    .first()
  const original = time(snapshot.occurred_at)!
  const previous = time(existing?.metadata?.native_observed_at)
  if (previous && original < previous)
    return { status: "excluded", reason: "older_cart_activity" } as const
  if (
    previous?.getTime() === original.getTime() &&
    existing.metadata.native_source_event_id !== snapshot.event_id
  ) {
    await db("gp_cart_lifecycle")
      .where({ id: existing.id })
      .update({
        status: "unavailable",
        metadata: {
          ...existing.metadata,
          unavailable_reason: "ambiguous_activity_order",
        },
        updated_at: now(),
      })
    return { status: "excluded", reason: "ambiguous_activity_order" } as const
  }
  if (!existing && snapshot.cart.item_count === 0)
    return { status: "excluded", reason: "empty_cart" } as const
  const native = await db("cart")
    .where({ id: snapshot.cart.id })
    .whereNull("deleted_at")
    .first()
  const recovered = Boolean(snapshot.cart.completed_at || native?.completed_at)
  const lastActivity = time(existing?.last_activity_at)
  const row = {
    profile_id: event.profile_id || null,
    anonymous_id: snapshot.context?.anonymous_id || null,
    email: snapshot.cart.email,
    email_lower: snapshot.cart.email,
    customer_type: snapshot.cart.customer_type,
    route_market: snapshot.cart.route_market,
    status: recovered
      ? "recovered"
      : !native || snapshot.cart.item_count === 0
      ? "inactive"
      : "active",
    first_seen_at: existing?.first_seen_at || original,
    last_activity_at:
      lastActivity && lastActivity > original ? lastActivity : original,
    recovered_at: recovered
      ? native?.completed_at || snapshot.cart.completed_at
      : null,
    expired_at: null,
    expire_after_minutes: ttl(),
    updated_at: now(),
    metadata: {
      ...(existing?.metadata || {}),
      native_source_event_id: snapshot.event_id,
      native_source_hash: nativeSnapshotHash(snapshot),
      native_observed_at: snapshot.occurred_at,
      unavailable_reason: null,
    },
  }
  if (existing)
    await db("gp_cart_lifecycle").where({ id: existing.id }).update(row)
  else {
    await db("gp_cart_lifecycle").insert({
      id: `gpcart_${randomUUID()}`,
      cart_id: snapshot.cart.id,
      ...row,
      created_at: now(),
    })
    await saveCartMeasurement(
      db,
      deriveCartMeasurement(snapshot, "created", original)
    )
  }
  return { status: "accepted" } as const
}

/** Current vetoes never manufacture original source permission or classification. */
export async function cartRecoveryAllowed(db: any, event: any) {
  if (process.env.GP_CART_MEASUREMENT_ENABLED !== "true") return false
  const snapshot = cartSourceFromRow(event)
  const permission = snapshot?.email_permission
  if (
    !snapshot ||
    !["created", "expired"].includes(snapshot.kind) ||
    snapshot.lane !== "production" ||
    !permission?.approved ||
    !permission.profile_id ||
    !permission.email ||
    permission.email !== snapshot.cart.email ||
    !time(permission.consented_at) ||
    time(permission.consented_at)! > time(snapshot.occurred_at)!
  )
    return false
  const parentRow = await db("gp_communication_event")
    .where({ event_id: snapshot.derived_from })
    .whereNull("deleted_at")
    .first()
  const parent = cartSourceFromRow(parentRow)
  if (
    !parent ||
    parent.kind !== "activity" ||
    nativeSnapshotHash(
      deriveCartMeasurement(
        parent,
        snapshot.kind as "created" | "expired",
        new Date(snapshot.occurred_at)
      )
    ) !== nativeSnapshotHash(snapshot)
  )
    return false
  const lifecycle = await db("gp_cart_lifecycle")
    .where({ cart_id: snapshot.cart.id })
    .whereNull("deleted_at")
    .first()
  if (
    !lifecycle ||
    lifecycle.metadata?.native_source_event_id !== parent.event_id ||
    lifecycle.metadata?.native_source_hash !== nativeSnapshotHash(parent) ||
    lifecycle.status !== (snapshot.kind === "expired" ? "expired" : "active")
  )
    return false
  const native = await db("cart")
    .where({ id: snapshot.cart.id })
    .whereNull("deleted_at")
    .first()
  if (
    !native ||
    native.completed_at ||
    !time(native.updated_at) ||
    !time(snapshot.cart.native_updated_at) ||
    time(native.updated_at)! > time(snapshot.cart.native_updated_at)! ||
    (native.email || "").toLowerCase() !== snapshot.cart.email ||
    (native.customer_id || null) !== snapshot.cart.customer_id
  )
    return false
  // A newer accepted notification vetoes recovery even before its projection runs.
  const newer = await newerCartActivity(db, parent)
  if (newer) return false
  const profile = await db("gp_customer_profile")
    .where({ id: permission.profile_id })
    .whereNull("deleted_at")
    .first()
  return Boolean(
    profile?.email_consent &&
      time(profile.email_consent_at) &&
      time(profile.email_consent_at)!.getTime() ===
        time(permission.consented_at)!.getTime() &&
      profile.email_lower === permission.email
  )
}

export async function cartRecoveryEnrollmentAllowed(db: any, enrollment: any) {
  const event = await db("gp_communication_event")
    .where({ event_id: enrollment.trigger_event_id })
    .whereNull("deleted_at")
    .first()
  return Boolean(
    event &&
      event.profile_id === enrollment.profile_id &&
      (await cartRecoveryAllowed(db, event))
  )
}

/** Browser activity can extend, but cannot create or change the recipient/owner. */
export async function syncCartLifecycleFromEvent(
  db: any,
  event: Record<string, any>
) {
  const cartId = event.cart_id || event.properties?.cart_id
  if (!cartId) return null
  const existing = await db("gp_cart_lifecycle")
    .where({ cart_id: cartId })
    .whereNull("deleted_at")
    .first()
  if (!existing) return null
  const timestamp = time(event.occurred_at)
  if (!timestamp) return existing
  if (["order_received", "order_completed"].includes(event.event_name)) {
    const patch = {
      status: "recovered",
      recovered_at: timestamp,
      recovered_order_id: event.order_id || event.properties?.order_id || null,
      updated_at: now(),
    }
    await db("gp_cart_lifecycle").where({ id: existing.id }).update(patch)
    return { ...existing, ...patch }
  }
  const p = event.properties || {}
  const sameIdentity = Boolean(
    (existing.profile_id && existing.profile_id === event.profile_id) ||
      (existing.anonymous_id && existing.anonymous_id === event.anonymous_id)
  )
  if (
    !CART_ACTIVITY_EVENTS.has(event.event_name) ||
    !sameIdentity ||
    p.analytics_consent !== true ||
    p.test_event !== false ||
    p.analytics_environment !== "production" ||
    !existing.metadata?.native_source_event_id ||
    !["active", "expired"].includes(existing.status) ||
    timestamp <= (time(existing.last_activity_at) || timestamp) ||
    timestamp > now()
  )
    return existing
  const patch = {
    status: "active",
    expired_at: null,
    last_activity_at: timestamp,
    updated_at: now(),
    ...(event.event_name === "checkout_started"
      ? { checkout_started_at: timestamp }
      : {}),
  }
  await db("gp_cart_lifecycle").where({ id: existing.id }).update(patch)
  return { ...existing, ...patch }
}

export async function expireInactiveCarts(container: MedusaContainer) {
  if (process.env.GP_CART_MEASUREMENT_ENABLED !== "true")
    return { scanned: 0, expired: 0 }
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const configured = Number(process.env.COMMUNICATIONS_CART_EXPIRE_BATCH || 100)
  const limit = Number.isFinite(configured)
    ? Math.min(500, Math.max(1, Math.floor(configured)))
    : 100
  const rows = await db("gp_cart_lifecycle")
    .whereNull("deleted_at")
    .where("status", "active")
    .whereNotNull("last_activity_at")
    .whereRaw(
      "last_activity_at <= now() - make_interval(mins => expire_after_minutes::int)"
    )
    .orderBy("last_activity_at", "asc")
    .limit(limit)
  let expired = 0
  for (const candidate of rows)
    await db.transaction(async (trx: any) => {
      if (!(await lockCart(trx, candidate.cart_id))) return
      const cart = await trx("gp_cart_lifecycle")
        .where({ id: candidate.id })
        .whereNull("deleted_at")
        .first()
      if (cart?.status !== "active") return
      const last = time(cart.last_activity_at)
      if (!last) return
      const deadline = new Date(
        last.getTime() + Number(cart.expire_after_minutes) * 60_000
      )
      if (!Number.isFinite(deadline.getTime()) || deadline > now()) return
      const event = await trx("gp_communication_event")
        .where({ event_id: cart.metadata?.native_source_event_id || "" })
        .whereNull("deleted_at")
        .first()
      const source = cartSourceFromRow(event)
      if (
        !source ||
        source.kind !== "activity" ||
        source.lane !== "production" ||
        cart.metadata.native_source_hash !== nativeSnapshotHash(source)
      ) {
        await trx("gp_cart_lifecycle")
          .where({ id: cart.id })
          .update({ status: "unavailable", updated_at: now() })
        return
      }
      const native = await trx("cart")
        .where({ id: cart.cart_id })
        .whereNull("deleted_at")
        .first()
      if (!native || native.completed_at) {
        await trx("gp_cart_lifecycle")
          .where({ id: cart.id })
          .update({
            status: native?.completed_at ? "recovered" : "inactive",
            recovered_at: native?.completed_at || null,
            updated_at: now(),
          })
        return
      }
      if (await newerCartActivity(trx, source)) return
      if (
        !time(native.updated_at) ||
        !time(source.cart.native_updated_at) ||
        time(native.updated_at)! > time(source.cart.native_updated_at)!
      ) {
        await trx("gp_cart_lifecycle")
          .where({ id: cart.id })
          .update({ status: "unavailable", updated_at: now() })
        return
      }
      await saveCartMeasurement(
        trx,
        deriveCartMeasurement(source, "expired", deadline)
      )
      await trx("gp_cart_lifecycle")
        .where({ id: cart.id })
        .update({ status: "expired", expired_at: deadline, updated_at: now() })
      expired++
    })
  return { scanned: rows.length, expired }
}
