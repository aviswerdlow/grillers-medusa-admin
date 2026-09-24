import {
  validateShippingPricePolicy,
  type ShippingPricePolicy,
} from "./shipping-price-policy";
export {
  validateShippingPricePolicy,
  type ShippingPricePolicy,
} from "./shipping-price-policy";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { ShippingInputError } from "./shipping-weights";
import type { ShippingPackingPlan } from "./shipping-packing-plan";
import { weightImportHash } from "./sam-shipping-weight-import";

export const SHIPPING_PRICE_TOKEN_KEY = "shipping_price_quote_v1";
export const SHIPPING_PRICE_ACCEPTED_KEY = "shipping_price_accepted_v1";
export type ShippingPriceSource = "forecast" | "wwex" | "cms_fallback";
export type ShippingPriceQuote = {
  version: 1;
  source: ShippingPriceSource;
  policy: ShippingPricePolicy;
  packingPlanId: string;
  packingPolicyRevision: string;
  carrierFreightEstimate: number | null;
  freightPricingAdjustment: number | null;
  rateBasis: number;
  boxes: number;
  dryIceLb: number;
  boxCost: number;
  dryIceCost: number;
  packagingCost: number;
  packagingAddition: number;
  customerShippingBeforePromotions: number;
};
export type AcceptedShippingPrice = {
  version: 1;
  cartId: string;
  quote: ShippingPriceQuote;
  shippingDiscount: number;
  customerShipping: number;
  promotionIds: string[];
  shippingTax: number;
  // Existing final food calculation uses gross subtotals; preserve its accepted
  // merchandise/order discount separately instead of netting it into shipping.
  nonShippingCredit: number;
};
function fail(code: string): never {
  throw new ShippingInputError(code);
}
export function priceCents(value: unknown): number {
  const raw =
    value && typeof value === "object" && "value" in value
      ? value.value
      : value;
  if (
    (typeof raw !== "number" && typeof raw !== "string") ||
    raw === "" ||
    (typeof raw === "string" && !raw.trim())
  )
    fail("invalid_shipping_money");
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    n < 0 ||
    !Number.isSafeInteger(Math.round(n * 100))
  )
    fail("invalid_shipping_money");
  return Math.round((n + Number.EPSILON) * 100);
}
const money = (v: unknown) => priceCents(v) / 100;
export function composeShippingPrice(input: {
  source: ShippingPriceSource;
  rate: unknown;
  currency: string;
  plan: ShippingPackingPlan;
  policy: ShippingPricePolicy;
  now?: Date;
  carrierFreightEstimate?: unknown;
}): ShippingPriceQuote {
  const policy = validateShippingPricePolicy(input.policy, input.now);
  if (
    input.currency.toLowerCase() !== policy.currency ||
    !["forecast", "wwex", "cms_fallback"].includes(input.source)
  )
    fail("shipping_price_currency_or_source_mismatch");
  const p = input.plan;
  if (
    !p?.id ||
    !p.policyVersion ||
    !Number.isSafeInteger(p.boxes) ||
    p.boxes < 1 ||
    !Number.isFinite(p.dryIceLb) ||
    p.dryIceLb <= 0
  )
    fail("shipping_price_packing_required");
  const box = priceCents(p.boxCost),
    ice = priceCents(p.dryIceCost);
  if (box + ice !== priceCents(p.total))
    fail("shipping_price_packing_inconsistent");
  const rate = priceCents(input.rate);
  const addition =
    input.source === "cms_fallback" &&
    policy.cmsFallbackBasis === "inclusive_customer_tariff"
      ? 0
      : box + ice;
  const freightEstimate =
    input.source === "cms_fallback"
      ? null
      : input.source === "forecast"
      ? priceCents(input.carrierFreightEstimate)
      : rate;
  const total = rate + addition;
  if (
    !Number.isSafeInteger(total) ||
    total > priceCents(policy.maxCustomerShipping)
  )
    fail("shipping_price_exceeds_approved_limit");
  return {
    version: 1,
    source: input.source,
    policy,
    packingPlanId: p.id,
    packingPolicyRevision: p.policyVersion,
    carrierFreightEstimate:
      freightEstimate === null ? null : freightEstimate / 100,
    freightPricingAdjustment:
      freightEstimate === null ? null : (rate - freightEstimate) / 100,
    rateBasis: rate / 100,
    boxes: p.boxes,
    dryIceLb: p.dryIceLb,
    boxCost: box / 100,
    dryIceCost: ice / 100,
    packagingCost: (box + ice) / 100,
    packagingAddition: addition / 100,
    customerShippingBeforePromotions: total / 100,
  };
}

// Opaque authenticated envelopes keep costs, policy details and cart fingerprints
// off public API responses. Domain-separated keys; no development secret fallback.
function key(purpose: string, keyId: string): Buffer {
  let keys: any;
  try {
    keys = JSON.parse(process.env.GP_SHIPPING_PRICE_KEYS_JSON || "{}");
  } catch {
    fail("shipping_price_signing_unavailable");
  }
  const secret = keys?.[keyId];
  if (
    !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
    typeof secret !== "string" ||
    secret.length < 32
  )
    fail("shipping_price_signing_unavailable");
  return createHmac("sha256", secret)
    .update(`gp-shipping-price-v1:${purpose}`)
    .digest();
}
function seal(value: unknown, purpose: string): string {
  const keyId = process.env.GP_SHIPPING_PRICE_ACTIVE_KEY_ID || "";
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(purpose, keyId), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `${keyId}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString(
    "base64url"
  )}`;
}
function open(value: unknown, purpose: string): any {
  if (
    typeof value !== "string" ||
    value.length > 20000 ||
    !/^[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+$/.test(value)
  )
    fail("shipping_price_acceptance_required");
  try {
    const [keyId, payload] = (value as string).split(".");
    const raw = Buffer.from(payload, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(purpose, keyId),
      raw.subarray(0, 12)
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString("utf8")
    );
  } catch {
    return fail("shipping_price_acceptance_required");
  }
}
export function shippingPriceBinding(cart: any, plan: ShippingPackingPlan) {
  if (!cart?.id || String(cart.currency_code).toLowerCase() !== "usd")
    fail("shipping_price_cart_required");
  return weightImportHash({
    cartId: cart.id,
    currency: cart.currency_code.toLowerCase(),
    planId: plan.id,
    // Intentionally exclude promotions: Medusa applies them after rating. Freeze
    // them separately immediately before completion, and recheck the loaded cart.
    address: Object.fromEntries(
      [
        "address_1",
        "address_2",
        "city",
        "province",
        "postal_code",
        "country_code",
      ].map((k) => [k, cart.shipping_address?.[k] ?? null])
    ),
    items: (cart.items ?? [])
      .map((i: any) => ({
        id: i.id,
        variantId: i.variant_id,
        quantity: i.quantity,
        unitPrice: money(i.unit_price),
      }))
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))),
  });
}
export function issueShippingPriceToken(
  cart: any,
  plan: ShippingPackingPlan,
  quote: ShippingPriceQuote,
  now = Date.now()
) {
  return seal(
    {
      binding: shippingPriceBinding(cart, plan),
      expiresAt: now + 15 * 60_000,
      quote,
    },
    "quote"
  );
}
export function readShippingPriceToken(
  value: unknown,
  cart: any,
  plan: ShippingPackingPlan,
  policy: ShippingPricePolicy,
  now = Date.now()
): ShippingPriceQuote {
  const token = open(value, "quote");
  if (
    !Number.isFinite(token.expiresAt) ||
    token.expiresAt <= now ||
    token.expiresAt > now + 15 * 60_000 ||
    token.binding !== shippingPriceBinding(cart, plan) ||
    weightImportHash(token.quote?.policy) !== weightImportHash(policy)
  )
    fail("shipping_price_changed_refresh_required");
  const quote = composeShippingPrice({
    source: token.quote.source,
    rate: token.quote.rateBasis,
    carrierFreightEstimate: token.quote.carrierFreightEstimate,
    currency: cart.currency_code,
    plan,
    policy,
    now: new Date(now),
  });
  if (weightImportHash(quote) !== weightImportHash(token.quote))
    fail("shipping_price_changed_refresh_required");
  return quote;
}
/** Only trusted checkout code may inspect expiry; never expose private quote costs. */
export function shippingPriceTokenExpiry(value: unknown): number {
  const expiresAt = open(value, "quote").expiresAt;
  if (!Number.isFinite(expiresAt))
    fail("shipping_price_changed_refresh_required");
  return expiresAt;
}
export function acceptShippingPrice(
  cart: any,
  method: any,
  quote: ShippingPriceQuote
): AcceptedShippingPrice {
  const gross = priceCents(quote.customerShippingBeforePromotions);
  const shippingTax = priceCents(cart.shipping_tax_total);
  // Provider rates are tax inclusive. Medusa shipping_total includes that tax.
  const net = priceCents(cart.shipping_total);
  const discount = gross - net;
  // completeCartFields exposes totals but not shipping_discount_total. Derive
  // it from the tax-inclusive quote and net total, checking the explicit field
  // whenever the caller has it instead of treating a missing field as zero.
  if (
    priceCents(method.amount) !== gross ||
    discount < 0 ||
    shippingTax > net ||
    (cart.shipping_discount_total !== undefined &&
      priceCents(cart.shipping_discount_total) !== discount)
  )
    fail("shipping_price_totals_changed");
  const credit =
    priceCents(cart.item_subtotal) +
    net +
    priceCents(cart.tax_total) -
    shippingTax -
    priceCents(cart.total);
  if (!Number.isSafeInteger(credit) || credit < 0)
    fail("shipping_price_order_ledger_inconsistent");
  return {
    version: 1,
    cartId: cart.id,
    quote,
    shippingDiscount: discount / 100,
    customerShipping: net / 100,
    shippingTax: shippingTax / 100,
    nonShippingCredit: credit / 100,
    promotionIds: (cart.promotions ?? []).map((p: any) => String(p.id)).sort(),
  };
}
export function sealAcceptedShippingPrice(accepted: AcceptedShippingPrice) {
  return seal(accepted, "accepted");
}
export function readAcceptedShippingPrice(order: any): AcceptedShippingPrice {
  const value = open(
    order?.metadata?.[SHIPPING_PRICE_ACCEPTED_KEY],
    "accepted"
  ) as AcceptedShippingPrice;
  if (
    value.version !== 1 ||
    value.cartId !== order.cart_id ||
    value.quote?.policy?.finalShipping !== "retain_accepted" ||
    String(order.currency_code).toLowerCase() !== value.quote.policy.currency ||
    priceCents(order.shipping_total) !== priceCents(value.customerShipping)
  )
    fail("shipping_price_order_review_required");
  return value;
}
