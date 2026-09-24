export type ShippingPricePolicy = {
  version: 1;
  revision: string;
  approvedBy: string;
  approvedAt: string;
  approvalReference: string;
  effectiveFrom: string;
  effectiveThrough: string;
  currency: "usd";
  maxCustomerShipping: number;
  // CMS tables can already contain packaging. Never infer their cost basis.
  cmsFallbackBasis: "freight_only" | "inclusive_customer_tariff";
  finalShipping: "retain_accepted";
};

export class ShippingPricePolicyError extends Error {
  constructor() {
    super(
      "Customer shipping pricing needs an approved, complete policy and valid effective period.",
    );
    this.name = "ShippingPricePolicyError";
  }
}
/** Portable CMS/backend validation. Publication may precede the effective date;
 * checkout must be inside it. Supported policy is explicit, never a default. */
export function validateShippingPricePolicy(
  value: unknown,
  now = new Date(),
  requireActive = true,
): ShippingPricePolicy {
  const p = value as ShippingPricePolicy;
  const validDate = (v: unknown) =>
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(v) &&
    Number.isFinite(Date.parse(v));
  const maximum =
    p &&
    (typeof p.maxCustomerShipping === "number" ||
      typeof p.maxCustomerShipping === "string")
      ? Number(p.maxCustomerShipping)
      : NaN;
  if (
    !p ||
    p.version !== 1 ||
    p.currency !== "usd" ||
    ![p.revision, p.approvedBy, p.approvalReference].every(
      (v) => typeof v === "string" && v.trim(),
    ) ||
    !validDate(p.approvedAt) ||
    Date.parse(p.approvedAt) > now.getTime() ||
    !validDate(p.effectiveFrom) ||
    !validDate(p.effectiveThrough) ||
    Date.parse(p.effectiveFrom) >= Date.parse(p.effectiveThrough) ||
    (requireActive &&
      (Date.parse(p.effectiveFrom) > now.getTime() ||
        Date.parse(p.effectiveThrough) <= now.getTime())) ||
    !Number.isFinite(maximum) ||
    maximum <= 0 ||
    !Number.isSafeInteger(Math.round(maximum * 100)) ||
    !["freight_only", "inclusive_customer_tariff"].includes(
      p.cmsFallbackBasis,
    ) ||
    p.finalShipping !== "retain_accepted"
  )
    throw new ShippingPricePolicyError();
  return {
    version: 1,
    revision: p.revision,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    approvalReference: p.approvalReference,
    effectiveFrom: p.effectiveFrom,
    effectiveThrough: p.effectiveThrough,
    currency: "usd",
    maxCustomerShipping: Math.round((maximum + Number.EPSILON) * 100) / 100,
    cmsFallbackBasis: p.cmsFallbackBasis,
    finalShipping: p.finalShipping,
  };
}
