import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { emitAnalyticsSubscriberFailureAlert } from "../../lib/analytics/subscriber-alerts"
import { SHIPPING_PACKING_PLAN_KEY, type ShippingPackingPlan } from "../../lib/shipping-packing-plan"
import {
  isUpsServiceCode,
  normalizeGrillersUpsServiceCode,
} from "../../modules/fulfillment/wwex-speedship"

/** Reports the accepted packing estimate without recomputing old orders from
 * current catalog/CMS settings. Price decomposition awaits the versioned quote
 * contract (#331/#368); carrier freight must never be inferred by subtraction. */

const STAFF_SOURCES = new Set([
  "staff",
  "staff_phone_order",
  "staff_impersonation",
  "admin_staff_reorder",
])
const IN_REGION_STATES = new Set(["GA", "TN", "TX", "NC", "FL", "SC", "AL"])
const ATLANTA_DELIVERY_ZIPS = new Set([
  "30005",
  "30009",
  "30022",
  "30033",
  "30062",
  "30067",
  "30068",
  "30071",
  "30075",
  "30079",
  "30092",
  "30093",
  "30097",
  "30319",
  "30322",
  "30324",
  "30326",
  "30327",
  "30328",
  "30329",
  "30338",
  "30339",
  "30340",
  "30341",
  "30342",
  "30345",
  "30346",
  "30350",
  "30360",
])

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

function metadataObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>
      }
    } catch {
      return {}
    }
  }
  return {}
}

function numberValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null
  const parsed =
    typeof value === "object" && value !== null && "value" in value
      ? Number((value as Record<string, unknown>).value)
      : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function normalizeZip(value: unknown): string {
  const match = firstText(value).match(/\d{5}/)
  return match?.[0] || ""
}

function latestShippingMethod(order: Record<string, any>): Record<string, any> {
  const methods = Array.isArray(order.shipping_methods)
    ? order.shipping_methods
    : []
  return methods[methods.length - 1] || {}
}

/**
 * Resolve the UPS service code of the chosen shipping method, mirroring how the
 * fulfillment provider derives it. Returns "" when the method is not a UPS
 * calculated rate (pickup / local-delivery / flat) so the caller can skip.
 */
function upsServiceCodeForMethod(method: Record<string, any>): string {
  const methodData = metadataObject(method.data)
  const methodMetadata = metadataObject(method.metadata)
  // Try each source in priority order and return the FIRST that normalizes to a
  // real UPS service code. We must NOT first-win on a raw non-empty string:
  // shipping_option_id is an opaque `so_…` id that never normalizes to a UPS
  // code, so a plain firstText() would let it shadow the human-readable
  // method.name (e.g. "UPS Overnight Shipping") and make every real UPS order
  // get skipped (no service code → no shipping_forecast event).
  for (const candidate of [
    methodData.service_code,
    methodMetadata.service_code,
    method.shipping_option_id,
    method.name,
  ]) {
    const text = firstText(candidate)
    if (!text) continue
    const normalized = normalizeGrillersUpsServiceCode(text)
    if (isUpsServiceCode(normalized)) return normalized
  }
  return ""
}

function sourceForAnalytics(metadata: Record<string, any>): "staff" | "web" {
  if (STAFF_SOURCES.has(firstText(metadata.source))) return "staff"
  if (metadata.staff_phone_order === true) return "staff"
  return "web"
}

function customerTypeForAnalytics(
  order: Record<string, any>,
  metadata: Record<string, any>
): "dtc" | "institutional" {
  const groups = Array.isArray(order.customer?.groups)
    ? order.customer.groups
    : []
  const institutional = groups.some((group: Record<string, any>) => {
    const groupMetadata = metadataObject(group?.metadata)
    return (
      firstText(group?.name).toLowerCase().includes("institutional") ||
      firstText(group?.id).toLowerCase().includes("institutional") ||
      firstText(groupMetadata.customer_type).toLowerCase() === "institutional" ||
      groupMetadata.institutional === true
    )
  })
  if (institutional) return "institutional"
  if (metadata.customer_type === "institutional") return "institutional"
  return "dtc"
}

function routeMarketForAnalytics(
  order: Record<string, any>,
  metadata: Record<string, any>
): "atlanta_metro" | "southeast" | "national" | "unknown" {
  const shippingAddress = metadataObject(order.shipping_address)
  const zip = normalizeZip(
    shippingAddress.postal_code ||
      metadata.fulfillmentZip ||
      metadata.fulfillment_zip ||
      metadata.shipping_zip
  )
  const state = firstText(
    shippingAddress.province,
    shippingAddress.province_code,
    metadata.fulfillmentState,
    metadata.fulfillment_state,
    metadata.shipping_state
  )
    .toUpperCase()
    .replace(/^US[-\s]+/, "")

  if (zip && ATLANTA_DELIVERY_ZIPS.has(zip)) return "atlanta_metro"
  if (state && IN_REGION_STATES.has(state)) return "southeast"
  if (state || zip) return "national"
  return "unknown"
}

/**
 * Builds the `shipping_forecast` analytics payload for an order, or returns null
 * when the order is not a UPS-shipped order. Pure + side-effect-free so it can be
 * unit-tested without the Medusa container.
 */
export function buildShippingForecastEvent(
  order: Record<string, any>,
): {
  event: "shipping_forecast"
  actor_id?: string
  properties: Record<string, any>
} | null {
  const method = latestShippingMethod(order)
  const service = upsServiceCodeForMethod(method)
  // Skip pickup / local-delivery / flat: no UPS freight to forecast or reconcile.
  if (!service || !order.items?.length) return null

  const metadata = metadataObject(order.metadata)
  const shippingAddress = metadataObject(order.shipping_address)

  const stored = metadata[SHIPPING_PACKING_PLAN_KEY] as ShippingPackingPlan | undefined
  const pkg = stored?.version === 1 && stored.service === service && stored.id && stored.packages?.length ? stored : null
  const estimatedWeightLb = pkg?.weights.physicalWeightLb ?? null
  const shipPostalCode = normalizeZip(shippingAddress.postal_code || shippingAddress.zip)
  const shipState = firstText(shippingAddress.province_code, shippingAddress.province, shippingAddress.state).toUpperCase().replace(/^US-/, "")

  // Charged shipping = what the customer actually paid for shipping. Prefer the
  // chosen method's amount, fall back to the order's shipping_total.
  const chargedShipping = roundMoney(
    numberValue(method.amount) ?? numberValue(order.shipping_total) ?? 0
  )

  const customerId = order.customer_id || undefined
  const orderId = order.id
  const idempotencyKey = `order.placed:${orderId}:shipping_forecast`

  return {
    event: "shipping_forecast",
    actor_id: customerId,
    properties: {
      order_id: orderId,
      // mirror id used by the GP analytics shim for stable session/idempotency.
      transaction_id: orderId,
      order_display_id: order.display_id,
      // Deterministic occurred-at so shim timestamps survive replays.
      order_created_at: order.created_at,
      customer_id: customerId,
      email: order.email,
      ship_state: shipState,
      dest_postal_code: shipPostalCode,
      service,
      estimate_status: pkg ? "accepted_snapshot" : "unavailable_legacy_snapshot",
      packing_plan_id: pkg?.id ?? null,
      packing_policy_version: pkg?.policyVersion ?? null,
      transit_days: pkg?.transitDays ?? null,
      estimated_weight_lb: estimatedWeightLb,
      boxes: pkg?.boxes ?? null,
      box_tier: pkg?.packages[0]?.boxTier ?? null,
      dry_ice_lb: pkg?.dryIceLb ?? null,
      box_cost: pkg?.boxCost ?? null,
      dry_ice_cost: pkg?.dryIceCost ?? null,
      estimated_packaging_cost: pkg?.total ?? null,
      charged_shipping: chargedShipping,
      price_decomposition_status: "awaiting_versioned_quote_contract",
      packaging_cost: null,
      freight: null,
      packaging_included_in_charge: null,
      source: sourceForAnalytics(metadata),
      customer_type: customerTypeForAnalytics(order, metadata),
      route_market: routeMarketForAnalytics(order, metadata),
      fulfillment_tier: `ups_${service.toLowerCase()}`,
      medusa_event_id: idempotencyKey,
      idempotency_key: idempotencyKey,
    },
  }
}

export default async function shippingForecastHandler({
  event: { name, data },
  container,
}: SubscriberArgs<{ id: string; order_id?: string }>) {
  const logger = container.resolve("logger")
  const query = container.resolve("query")
  const analyticsService = container.resolve("analytics")
  const orderId = data.order_id || data.id

  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "created_at",
        "email",
        "currency_code",
        "customer_id",
        "customer.*",
        "customer.groups.*",
        "customer.metadata",
        "customer.groups.metadata",
        "shipping_total",
        "metadata",
        "shipping_address.*",
        "items.*",
        "items.metadata",
        "items.variant.*",
        "items.variant.product.*",
        "items.variant.product.metadata",
        "shipping_methods.*",
        "shipping_methods.shipping_option_id",
        "shipping_methods.data",
        "shipping_methods.metadata",
      ],
      filters: { id: orderId },
    })

    const order = orders?.[0] as any
    if (!order) return

    const payload = buildShippingForecastEvent(order)
    // Not a UPS order (pickup / local / flat): nothing to forecast or reconcile.
    if (!payload) return

    // Fire-and-forget: emit through the same gp-analytics shim every other
    // subscriber uses (server + GP dual-run). Source = medusa-fulfillment.
    await analyticsService.track({
      event: payload.event,
      actor_id: payload.actor_id,
      properties: {
        ...payload.properties,
        source: "medusa-fulfillment",
      },
    })
  } catch (err) {
    logger.warn(
      `Analytics: Failed to track shipping_forecast for ${orderId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    void emitAnalyticsSubscriberFailureAlert({
      logger,
      medusaEvent: "order.placed",
      analyticsEvent: "shipping_forecast",
      entityId: orderId,
      path: "src/subscribers/analytics/shipping-forecast.ts",
      error: err,
    }).catch(() => undefined)
  }
}

export const config: SubscriberConfig = {
  // Fire on every order at checkout (matches order-placed.ts). order.completed
  // fires later and not for every order, so it would undercount the dashboard.
  event: "order.placed",
}
