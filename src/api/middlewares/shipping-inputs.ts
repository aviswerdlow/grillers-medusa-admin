import { SHIPPING_PRICE_ACCEPTED_KEY } from "../../lib/shipping-price-contract";
import { ORDER_PROMISE_KEY } from "../../lib/order-promise";
import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http";
import { prepareShippingAcceptance } from "../../lib/shipping-acceptance";
import {
  SHIPPING_WEIGHT_KEY,
  SHIPPING_WEIGHT_SNAPSHOT_KEY,
  ShippingInputError,
} from "../../lib/shipping-weights";
import { SHIPPING_PACKING_PLAN_KEY } from "../../lib/shipping-packing-plan";
import {
  CALENDAR_ACCEPTED_KEY,
  FulfillmentCalendarError,
} from "../../lib/fulfillment-calendar";
import { prepareCalendarAcceptance } from "../../lib/fulfillment-calendar-runtime";

const privateKeys = new Set([
  SHIPPING_PRICE_ACCEPTED_KEY,
  "shipping_final_cost_v1",
  SHIPPING_WEIGHT_KEY,
  SHIPPING_WEIGHT_SNAPSHOT_KEY,
  SHIPPING_PACKING_PLAN_KEY,
  CALENDAR_ACCEPTED_KEY,
  ORDER_PROMISE_KEY,
]);
export function publicShippingProjection(value: any): any {
  if (Array.isArray(value)) return value.map(publicShippingProjection);
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !privateKeys.has(key))
      .map(([key, entry]) => [key, publicShippingProjection(entry)])
  );
}
export function hideShippingInternals(
  _req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const json = res.json.bind(res);
  res.json = ((body: any) =>
    json(publicShippingProjection(body))) as typeof res.json;
  next();
}
export async function prepareNativeShippingAcceptance(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    await prepareCalendarAcceptance(req.scope, req.params.id);
    await prepareShippingAcceptance(req.scope, req.params.id);
    return next();
  } catch (error) {
    if (error instanceof FulfillmentCalendarError)
      return res.status(error.status).json({
        type: "fulfillment_date_review_required",
        message: error.message,
      });
    if (error instanceof ShippingInputError)
      return res
        .status(409)
        .json({ type: "shipping_review_required", message: error.message });
    return next(error);
  }
}
