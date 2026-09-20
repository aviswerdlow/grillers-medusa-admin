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

const privateKeys = new Set([
  SHIPPING_WEIGHT_KEY,
  SHIPPING_WEIGHT_SNAPSHOT_KEY,
  SHIPPING_PACKING_PLAN_KEY,
]);
export function publicShippingProjection(value: any): any {
  if (Array.isArray(value)) return value.map(publicShippingProjection);
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !privateKeys.has(key))
      .map(([key, entry]) => [key, publicShippingProjection(entry)]),
  );
}
export function hideShippingInternals(
  _req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) {
  const json = res.json.bind(res);
  res.json = ((body: any) =>
    json(publicShippingProjection(body))) as typeof res.json;
  next();
}
export async function prepareNativeShippingAcceptance(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) {
  try {
    await prepareShippingAcceptance(req.scope, req.params.id);
    return next();
  } catch (error) {
    if (error instanceof ShippingInputError)
      return res
        .status(409)
        .json({ type: "shipping_review_required", message: error.message });
    return next(error);
  }
}
