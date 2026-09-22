import type { OrderPromise } from "./order-promise";
import {
  isUpsServiceCode,
  normalizeGrillersUpsServiceCode,
} from "../modules/fulfillment/wwex-speedship";

export const OPERATIONAL_MEASUREMENT_EVENTS = {
  shipping_forecast: "shipping_forecast",
  inventory_created: "inventory_allocation_created",
  inventory_released: "inventory_allocation_released",
} as const;
export type OperationalMeasurementKind =
  keyof typeof OPERATIONAL_MEASUREMENT_EVENTS;
export const isOperationalMeasurement = (
  kind: string
): kind is OperationalMeasurementKind =>
  Object.prototype.hasOwnProperty.call(OPERATIONAL_MEASUREMENT_EVENTS, kind);
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const money = (v: unknown) => {
  const n = number(v);
  return n !== null &&
    Number.isSafeInteger(Math.round(n * 100)) &&
    Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
    ? n
    : null;
};

/** Called only after readOriginalOrderPromise verifies the frozen binding/hash. */
export function originalShippingForecast(p: OrderPromise) {
  if (p.fulfillment.mode !== "ups_shipping") return null;
  const acceptedCodes = [p.fulfillment.service_code, p.fulfillment.service_label]
    .map(normalizeGrillersUpsServiceCode).filter(isUpsServiceCode);
  if (new Set(acceptedCodes).size > 1) throw new Error("shipping_measurement_service_conflict");
  const service = acceptedCodes[0];
  if (!isUpsServiceCode(service))
    throw new Error("shipping_measurement_service_unavailable");
  const plan: any = p.fulfillment.packing_plan;
  const validPlan =
    plan?.version === 1 &&
    text(plan.id) &&
    text(plan.policyVersion) &&
    normalizeGrillersUpsServiceCode(plan.service) === service &&
    Number.isSafeInteger(plan.boxes) &&
    plan.boxes > 0 &&
    Array.isArray(plan.packages) &&
    plan.packages.length === plan.boxes &&
    number(plan.weights?.physicalWeightLb) !== null &&
    plan.weights.physicalWeightLb > 0 &&
    [plan.transitDays, plan.dryIceLb].every((v) => number(v) !== null) &&
    [plan.boxCost, plan.dryIceCost, plan.total].every(
      (v) => money(v) !== null
    ) &&
    Math.round((plan.boxCost + plan.dryIceCost) * 100) ===
      Math.round(plan.total * 100);
  const accepted: any = p.fulfillment.accepted_shipping_price;
  const quote = accepted?.quote;
  const validQuote =
    validPlan &&
    accepted?.version === 1 &&
    accepted.cartId === p.cart_id &&
    quote?.version === 1 &&
    quote.packingPlanId === plan.id &&
    quote.packingPolicyRevision === plan.policyVersion &&
    quote.policy?.version === 1 &&
    text(quote.policy.revision) &&
    quote.policy.currency === p.currency &&
    quote.policy.finalShipping === "retain_accepted" &&
    ["forecast", "wwex", "cms_fallback"].includes(quote.source) &&
    [
      accepted.customerShipping,
      accepted.shippingDiscount,
      accepted.shippingTax,
      quote.customerShippingBeforePromotions,
      quote.packagingCost,
      quote.packagingAddition,
      quote.rateBasis,
    ].every((v) => money(v) !== null) &&
    accepted.customerShipping === p.shipping_total &&
    quote.packagingCost === plan.total &&
    Math.round(
      (quote.customerShippingBeforePromotions - accepted.shippingDiscount) * 100
    ) === Math.round(accepted.customerShipping * 100) &&
    Math.round((quote.rateBasis + quote.packagingAddition) * 100) ===
      Math.round(quote.customerShippingBeforePromotions * 100) &&
    (quote.carrierFreightEstimate === null ||
      money(quote.carrierFreightEstimate) !== null);
  return {
    measurement_schema: "original_shipping_estimate_v1",
    amount_basis: "accepted_shipping_estimate_v1",
    payment_evidence: "not_implied_by_shipping_estimate",
    service,
    fulfillment_tier: ({ GROUND: "ups_ground", "3_DAY_SELECT": "ups_3day",
      "2ND_DAY_AIR": "ups_2da", OVERNIGHT: "ups_overnight" } as Record<string, string>)[service],
    estimate_status: validPlan
      ? "accepted_snapshot"
      : "unavailable_accepted_packing",
    packing_plan_id: validPlan ? plan.id : null,
    packing_policy_version: validPlan ? plan.policyVersion : null,
    estimated_weight_lb: validPlan ? plan.weights.physicalWeightLb : null,
    boxes: validPlan ? plan.boxes : null,
    transit_days: validPlan ? plan.transitDays : null,
    dry_ice_lb: validPlan ? plan.dryIceLb : null,
    estimated_box_cost: validPlan ? plan.boxCost : null,
    estimated_dry_ice_cost: validPlan ? plan.dryIceCost : null,
    estimated_packaging_cost: validPlan ? plan.total : null,
    accepted_customer_shipping: p.shipping_total,
    price_decomposition_status: validQuote
      ? "accepted_snapshot"
      : "unavailable_accepted_price",
    shipping_price_policy_version: validQuote ? quote.policy.revision : null,
    shipping_quote_source: validQuote ? quote.source : null,
    estimated_carrier_freight: validQuote ? quote.carrierFreightEstimate : null,
    accepted_packaging_addition: validQuote ? quote.packagingAddition : null,
    accepted_shipping_discount: validQuote ? accepted.shippingDiscount : null,
    forecast_model_version: null,
    charged_shipping: null,
    freight: null,
    packaging_cost: null,
    actual_packaging_cost: null,
    shipping_margin: null,
  };
}

/** Bound-source anti-joins recover lost notifications without replaying stock operations. */
export async function reconcileOperationalMeasurements(
  db: any,
  starts: Date,
  request: (
    kind: OperationalMeasurementKind,
    orderId: string,
    sourceId: string
  ) => Promise<void>,
  limit = 100
) {
  const base = () =>
    db("gp_order_promise_binding as b").where("b.placed_at", ">=", starts);
  const shipping = await base()
    .whereNotExists(
      db("gp_order_publication as p")
        .select(db.raw("1"))
        .whereColumn("p.order_id", "b.order_id")
        .where("p.kind", "shipping_forecast")
    )
    .orderBy("b.placed_at")
    .orderBy("b.order_id")
    .limit(limit)
    .select("b.order_id");
  for (const row of shipping)
    await request("shipping_forecast", row.order_id, row.order_id);
  let inventory = 0;
  for (const kind of ["inventory_created", "inventory_released"] as const) {
    const rows = await base()
      .join("gp_inventory_allocation as a", "a.order_id", "b.order_id")
      .join("gp_inventory_allocation_audit as h", "h.allocation_id", "a.id")
      .whereNull("h.deleted_at")
      .where(
        "h.event_type",
        kind === "inventory_created" ? "created" : "released"
      )
      .whereNotExists(
        db("gp_order_publication as p")
          .select(db.raw("1"))
          .whereColumn("p.order_id", "b.order_id")
          .where("p.kind", kind)
          .whereColumn("p.source_id", "h.id")
      )
      .select("b.order_id", "h.id as source_id")
      .orderBy("h.created_at")
      .orderBy("h.id")
      .limit(limit);
    for (const row of rows) {
      await request(kind, row.order_id, row.source_id);
      inventory++;
    }
  }
  return { shipping: shipping.length, inventory };
}

export async function readOperationalMeasurement(
  db: any,
  intent: any,
  original: any
) {
  if (intent.kind === "shipping_forecast") {
    if (intent.source_id !== intent.order_id)
      throw new Error("shipping_measurement_source_mismatch");
    const properties = originalShippingForecast(original.promise);
    return properties ? { at: original.placed_at, properties } : null;
  }
  const event = intent.kind === "inventory_created" ? "created" : "released";
  const rows = await db("gp_inventory_allocation_audit as h")
    .join("gp_inventory_allocation as a", "a.id", "h.allocation_id")
    .where({
      "h.id": intent.source_id,
      "a.order_id": intent.order_id,
      "h.event_type": event,
    })
    .whereNull("h.deleted_at")
    .select("h.*", "a.order_id");
  if (rows.length !== 1)
    throw new Error("inventory_measurement_source_unavailable");
  const audit = rows[0];
  const quantity = (v: any) =>
    v === null || v === undefined || v === "" ? null : number(Number(v));
  const before = quantity(audit.previous_quantity),
    after = quantity(audit.next_quantity);
  if (
    after === null ||
    (event === "created"
      ? !["reserved", "future_committed", "blocked"].includes(
          audit.next_status
        ) || after <= 0
      : audit.next_status !== "released" || before === null || before <= 0)
  )
    throw new Error("inventory_measurement_transition_invalid");
  return {
    at: audit.created_at,
    properties: {
      measurement_schema: "allocation_audit_transition_v1",
      amount_basis: "non_monetary_allocation_audit_v1",
      payment_evidence: "not_implied_by_allocation",
      allocation_audit_id: audit.id,
      allocation_id: audit.allocation_id,
      allocation_transition: event,
      previous_status: audit.previous_status,
      next_status: audit.next_status,
      previous_quantity: before,
      next_quantity: after,
      ...(event === "created"
        ? {
            created_count: 1,
            blocked_count: audit.next_status === "blocked" ? 1 : 0,
          }
        : { released_count: 1 }),
      count_basis: "individual_audit_transition",
      retry_skip_count: null,
    },
  };
}
