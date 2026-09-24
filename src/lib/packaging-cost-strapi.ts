/**
 * Loads ops-editable packaging inputs from Strapi (cold-chain-setting) so the
 * dry-ice and box rules can change without an admin redeploy. Values layer as:
 * hardcoded legacy default < Strapi < env override.
 *
 * Strapi cold-chain-setting fields consumed:
 *   - DryIcePricePerLb  -> dryIceUsdPerLb
 *   - BoxCostMicro      -> boxCost.micro
 *   - BoxCost330        -> boxCost.m330
 *   - BoxCost345        -> boxCost.l345
 *   - PackagingCostModel, MinimumDryIceAmount, TransitDayThresholds and
 *     PackagingBoxes activate the continuous spreadsheet model only when the
 *     complete normalized input set is valid.
 *
 * Only published policies are fetched. A failed read supplies no approval;
 * the shared shipping planner then makes carrier quotes unavailable. Legacy
 * defaults remain for offline analysis, not as approval for customer quotes.
 */
import {
  resolvePackagingConfig,
  type PackagingCostConfig,
  type PackagingCostOverrides,
} from "./packaging-cost";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { value: PackagingCostOverrides; at: number; source: string } | null = null;

/** Reset the in-memory cache (tests). */
export function resetPackagingOverridesCache(): void {
  cache = null;
}

/** Maps a cold-chain-setting record (Strapi v4 or v5 shape) to overrides. */
export function packagingOverridesFromColdChainSetting(
  setting: unknown
): PackagingCostOverrides {
  const unwrap = (value: unknown): Record<string, any> => {
    if (!value || typeof value !== "object") return {};
    const row = value as Record<string, any>;
    return (row.attributes as Record<string, any>) ?? row;
  };
  const root =
    setting && typeof setting === "object" ? (setting as Record<string, any>) : {};
  const s = unwrap(root);
  const thresholds = Array.isArray(s?.TransitDayThresholds)
    ? s.TransitDayThresholds.map((row: unknown) => {
        const value = unwrap(row);
        return {
          transitDays: value.TransitDays ?? null,
          dryIceMultiplier: value.DryIceMultiplier ?? null,
        };
      })
    : [];
  const packagingBoxes = Array.isArray(s?.PackagingBoxes)
    ? s.PackagingBoxes.map((row: unknown) => {
        const value = unwrap(row);
        return {
          boxTier: value.PackagingTier ?? null,
          name: value.Name ?? null,
          unitCost: value.UnitCost ?? null,
          maxProductWeightLb: value.MaxProductWeightLb ?? null,
          maxTransitDays: value.MaxTransitDays ?? null,
          maxTotalWeightLb: value.MaxTotalWeightLb ?? null,
          tareWeightLb: value.TareWeightLb ?? null,
          active: value.Active ?? null,
          ...(value.LengthIn !== undefined ? { lengthIn: value.LengthIn } : {}),
          ...(value.WidthIn !== undefined ? { widthIn: value.WidthIn } : {}),
          ...(value.HeightIn !== undefined ? { heightIn: value.HeightIn } : {}),
          ...(value.MaxFitUnits !== undefined ? { maxFitUnits: value.MaxFitUnits } : {}),
          ...(value.FitRuleId !== undefined ? { fitRuleId: value.FitRuleId } : {}),
          ...(value.DryIceFitUnitsPerLb !== undefined ? { dryIceFitUnitsPerLb: value.DryIceFitUnitsPerLb } : {}),
        };
      })
    : [];
  return {
    ...(s?.Enabled !== undefined ? { enabled: s.Enabled === true } : {}),
    ...(s?.SeasonalPackingPolicies !== undefined ? { seasonalPolicies: s.SeasonalPackingPolicies } : {}),
    ...(s?.PackingPolicyVersion !== undefined ? { policyVersion: s.PackingPolicyVersion } : {}),
    model: s?.PackagingCostModel ?? null,
    dryIceUsdPerLb: s?.DryIcePricePerLb ?? null,
    boxCost: {
      micro: s?.BoxCostMicro ?? null,
      m330: s?.BoxCost330 ?? null,
      l345: s?.BoxCost345 ?? null,
    },
    minimumDryIceAmountLb: s?.MinimumDryIceAmount ?? null,
    dryIceBlockWeightLb: s?.DryIceBlockWeightLb ?? null,
    transitDayThresholds: thresholds,
    packagingBoxes,
  };
}

/** Fetches the cold-chain-setting single type from Strapi. Returns {} on any failure. */
export async function fetchPackagingOverridesFromStrapi(
  env: Record<string, string | undefined> = process.env
): Promise<PackagingCostOverrides> {
  const base = env.STRAPI_URL;
  const token = env.STRAPI_TOKEN;
  if (!base) return {};
  try {
    // Bound the request so a stalled Strapi can't add latency to the checkout
    // rate path. AbortError is swallowed by the catch below → falls back to {}.
    const url =
      `${base.replace(/\/+$/, "")}/api/cold-chain-setting` +
      `?status=published&populate[TransitDayThresholds]=*&populate[PackagingBoxes]=*&populate[SeasonalPackingPolicies][populate][ExposureRules]=*`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return {};
    const json = (await res.json()) as { data?: unknown };
    return packagingOverridesFromColdChainSetting(json?.data ?? json);
  } catch {
    return {};
  }
}

/**
 * Resolve the packaging config, layering Strapi overrides (cached) over the
 * hardcoded defaults, with env as the final override. `now` is injectable for
 * tests.
 */
export async function getPackagingConfig(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): Promise<PackagingCostConfig> {
  // Never reuse a different CMS origin/token's approved policy.
  const source = JSON.stringify([env.STRAPI_URL ?? "", env.STRAPI_TOKEN ?? ""]);
  if (!cache || cache.source !== source || now < cache.at || now - cache.at > CACHE_TTL_MS) {
    const overrides = await fetchPackagingOverridesFromStrapi(env);
    cache = { value: overrides, at: now, source };
  }
  return resolvePackagingConfig({ strapi: cache.value, env });
}
