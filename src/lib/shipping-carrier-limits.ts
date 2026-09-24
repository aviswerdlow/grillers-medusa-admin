import { ShippingInputError } from "./shipping-weights";

/** Preserve the existing WWEX adapter limit; this is configuration, not a
 * claim about UPS's general weight limit. All quote paths use the same cap. */
export function carrierPackageWeightLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.WWEX_MAX_PACKAGE_WEIGHT_LB;
  if (value == null || value === "") return 40;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0)
    throw new ShippingInputError("invalid_carrier_package_limit");
  return limit;
}
