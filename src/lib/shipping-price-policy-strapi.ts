import {
  validateShippingPricePolicy,
  type ShippingPricePolicy,
} from "./shipping-price-contract";
import { ShippingInputError } from "./shipping-weights";

/** Published configuration only; no env/default formula or stale-error fallback. */
export async function getShippingPricePolicy(): Promise<ShippingPricePolicy> {
  const origin = process.env.STRAPI_URL;
  if (!origin)
    throw new ShippingInputError("shipping_price_policy_unavailable");
  try {
    const response = await fetch(
      `${origin.replace(/\/+$/, "")}/api/cold-chain-setting?status=published&populate[ShippingPricingPolicy]=*`,
      {
        headers: process.env.STRAPI_TOKEN
          ? { Authorization: `Bearer ${process.env.STRAPI_TOKEN}` }
          : {},
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw new Error("policy read failed");
    const body = (await response.json()) as any;
    return validateShippingPricePolicy(
      (body.data?.attributes ?? body.data)?.ShippingPricingPolicy,
    );
  } catch (error) {
    if (error instanceof ShippingInputError) throw error;
    throw new ShippingInputError("shipping_price_policy_unavailable");
  }
}
