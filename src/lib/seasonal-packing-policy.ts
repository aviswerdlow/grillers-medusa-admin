// Portable contract: keep byte-identical with grillers-strapi/src/lib/seasonal-packing-policy.ts.
// Effective periods are approved operating inputs, not inferred weather forecasts.
export const PACKING_SERVICES = [
  "GROUND",
  "3_DAY_SELECT",
  "2ND_DAY_AIR",
  "OVERNIGHT",
] as const;
export type PackingService = (typeof PACKING_SERVICES)[number];
const CMS_SERVICES: Partial<Record<string, PackingService>> = {
  GROUND: "GROUND", UPS_3_DAY_SELECT: "3_DAY_SELECT",
  UPS_2ND_DAY_AIR: "2ND_DAY_AIR", OVERNIGHT: "OVERNIGHT",
};
export type PackingExposureRule = {
  service: PackingService;
  boxTier: string;
  throughHours: number;
  dryIceBlocksPerBox: number;
};
export type SeasonalPackingPolicy = {
  name: string;
  revision: string;
  approvedBy: string;
  approvedAt: string;
  approvalReference: string;
  effectiveFrom: string;
  effectiveThrough: string;
  delayAllowanceHours: number;
  maxExposureHours: number;
  maxGrossWeightLb: number;
  services: PackingService[];
  boxTiers: string[];
  rules: PackingExposureRule[];
};

export class PackingPolicyError extends Error {
  constructor(public code: string) {
    super(`Packing policy needs review (${code}).`);
    this.name = "PackingPolicyError";
  }
}
const fail = (code: string): never => {
  throw new PackingPolicyError(code);
};
const row = (value: any): Record<string, any> =>
  value?.attributes ?? value ?? {};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const number = (value: unknown): number => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return NaN;
  return Number(value);
};
const positive = (value: unknown) =>
  Number.isFinite(number(value)) && number(value) > 0;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));
const civilDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

export function parseSeasonalPackingPolicies(
  input: unknown,
  now = new Date(),
): SeasonalPackingPolicy[] {
  if (!Array.isArray(input)) return fail("missing_seasonal_policies");
  const policies = input
    .map(row)
    .filter((p) => p.Active === true)
    .map((p) => {
      if (
        ![p.Name, p.Revision, p.ApprovedBy, p.ApprovalReference].every((v) =>
          text(v),
        )
      )
        return fail("missing_policy_approval");
      if (!instant(p.ApprovedAt) || Date.parse(p.ApprovedAt) > now.getTime())
        return fail("invalid_policy_approval_time");
      if (
        !civilDate(p.EffectiveFrom) ||
        !civilDate(p.EffectiveThrough) ||
        p.EffectiveFrom > p.EffectiveThrough
      )
        return fail("invalid_policy_period");
      if (
        !Number.isFinite(number(p.DelayAllowanceHours)) ||
        number(p.DelayAllowanceHours) < 0 ||
        !positive(p.MaxExposureHours) ||
        !positive(p.MaxGrossWeightLb) ||
        number(p.DelayAllowanceHours) >= number(p.MaxExposureHours)
      )
        return fail("invalid_policy_limits");
      const services = PACKING_SERVICES.filter(
        (_, i) =>
          [p.AllowGround, p.Allow3Day, p.Allow2Day, p.AllowOvernight][i] ===
          true,
      );
      const boxTiers = ["micro", "m330", "l345"].filter(
        (_, i) => [p.AllowMicro, p.Allow330, p.Allow345][i] === true,
      );
      if (!services.length || !boxTiers.length)
        return fail("empty_policy_restrictions");
      if (!Array.isArray(p.ExposureRules) || !p.ExposureRules.length)
        return fail("missing_exposure_rules");
      const rules = p.ExposureRules.map(row)
        .map((r) => {
          // CMS enum names must be valid GraphQL identifiers. Carrier codes
          // remain unchanged outside this source adapter.
          const service = CMS_SERVICES[text(r.Service)];
          if (
            !positive(r.ThroughHours) ||
            !positive(r.DryIceBlocksPerBox) ||
            r.DryIceMultiplier != null ||
            !service || !services.includes(service) ||
            !boxTiers.includes(text(r.BoxTier)) ||
            number(r.ThroughHours) > number(p.MaxExposureHours)
          )
            return fail("invalid_exposure_rule");
          return {
            service,
            boxTier: text(r.BoxTier),
            throughHours: number(r.ThroughHours),
            dryIceBlocksPerBox: number(r.DryIceBlocksPerBox),
          };
        })
        .sort((a, b) => a.service.localeCompare(b.service) ||
          a.boxTier.localeCompare(b.boxTier) || a.throughHours - b.throughHours);
      for (const service of services) {
        // A small box may stop at an earlier exposure. Every permitted service
        // still needs a box covering the policy's full approved duration.
        if (!rules.some(r => r.service === service && r.throughHours === number(p.MaxExposureHours)))
          return fail("uncovered_exposure_limit");
        for (const tier of boxTiers) {
          const group = rules.filter(r => r.service === service && r.boxTier === tier);
          for (let i = 1; i < group.length; i++) {
            if (group[i].throughHours === group[i - 1].throughHours ||
              group[i].dryIceBlocksPerBox < group[i - 1].dryIceBlocksPerBox)
              return fail("contradictory_exposure_rules");
          }
        }
      }
      return {
        name: text(p.Name),
        revision: text(p.Revision),
        approvedBy: text(p.ApprovedBy),
        approvedAt: p.ApprovedAt,
        approvalReference: text(p.ApprovalReference),
        effectiveFrom: p.EffectiveFrom,
        effectiveThrough: p.EffectiveThrough,
        delayAllowanceHours: number(p.DelayAllowanceHours),
        maxExposureHours: number(p.MaxExposureHours),
        maxGrossWeightLb: number(p.MaxGrossWeightLb),
        services,
        boxTiers,
        rules,
      };
    });
  if (!policies.length) return fail("missing_approved_seasonal_policy");
  if (new Set(policies.map((p) => p.revision)).size !== policies.length)
    return fail("duplicate_policy_revision");
  for (let i = 0; i < policies.length; i++)
    for (let j = i + 1; j < policies.length; j++) {
      const a = policies[i],
        b = policies[j];
      if (
        a.services.some((s) => b.services.includes(s)) &&
        a.effectiveFrom <= b.effectiveThrough &&
        b.effectiveFrom <= a.effectiveThrough
      )
        return fail("overlapping_policy_periods");
    }
  return policies;
}

/** Used before CMS publication; runtime validates the same policy contract. */
export function validatePackingPublication(value: unknown, now = new Date()) {
  const setting = row(value);
  // A published disabled setting is a valid way to withdraw all quotes.
  if (setting.Enabled === false) return [];
  if (
    setting.Enabled !== true ||
    setting.PackagingCostModel !== "continuous_weight" ||
    !text(setting.PackingPolicyVersion)
  )
    return fail("unapproved_packing_configuration");
  if (
    !positive(setting.MinimumDryIceAmount) ||
    !positive(setting.DryIceBlockWeightLb) ||
    !positive(setting.DryIcePricePerLb)
  )
    return fail("invalid_ice_inputs");
  const policies = parseSeasonalPackingPolicies(
    setting.SeasonalPackingPolicies,
    now,
  );
  const boxes = Array.isArray(setting.PackagingBoxes)
    ? setting.PackagingBoxes.map(row).filter((b) => b.Active !== false)
    : [];
  if (!boxes.length) return fail("missing_packing_boxes");
  const tiers = new Set<string>();
  for (const b of boxes) {
    if (
      !["micro", "m330", "l345"].includes(b.PackagingTier) ||
      tiers.has(b.PackagingTier) ||
      !text(b.FitRuleId) ||
      !text(b.Name) ||
      ![
        b.UnitCost,
        b.LengthIn,
        b.WidthIn,
        b.HeightIn,
        b.MaxTotalWeightLb,
        b.MaxFitUnits,
        b.DryIceFitUnitsPerLb,
      ].every(positive) ||
      !Number.isFinite(number(b.TareWeightLb)) ||
      number(b.TareWeightLb) < 0 ||
      number(b.TareWeightLb) >= number(b.MaxTotalWeightLb) ||
      (b.MaxProductWeightLb != null && !positive(b.MaxProductWeightLb)) ||
      (b.MaxTransitDays != null &&
        (!positive(b.MaxTransitDays) ||
          !Number.isInteger(number(b.MaxTransitDays))))
    )
      return fail("invalid_packing_box");
    tiers.add(b.PackagingTier);
  }
  for (const p of policies) {
    if (p.rules.some(r => !tiers.has(r.boxTier))) return fail("missing_packing_rule_box");
    for (const service of p.services) {
      if (!boxes.some((b) => {
        const rule = selectPackingExposureRule(p, service, b.PackagingTier, p.maxExposureHours);
        if (!rule) return false;
        const ice = Math.max(number(setting.MinimumDryIceAmount),
          number(setting.DryIceBlockWeightLb) * rule.dryIceBlocksPerBox);
        return Math.min(number(b.MaxTotalWeightLb), p.maxGrossWeightLb) > ice + number(b.TareWeightLb) &&
          number(b.MaxFitUnits) > ice * number(b.DryIceFitUnitsPerLb) &&
          (b.MaxTransitDays == null || number(b.MaxTransitDays) >= Math.ceil(p.maxExposureHours / 24));
      })) return fail("no_box_for_policy_limit");
    }
  }
  return policies;
}

function easternDate(instant: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function selectSeasonalPackingPolicy(
  policies: SeasonalPackingPolicy[],
  context: {
    service: string;
    packedAt?: string;
    arrivalBy?: string;
    elapsedHours?: number;
  },
) {
  if (!instant(context.packedAt) || !instant(context.arrivalBy))
    return fail("missing_packing_instants");
  const elapsed =
    (Date.parse(context.arrivalBy) - Date.parse(context.packedAt)) / 3_600_000;
  if (
    elapsed <= 0 ||
    !Number.isFinite(context.elapsedHours) ||
    Math.abs(elapsed - context.elapsedHours!) > 0.000001
  )
    return fail("inconsistent_packing_exposure");
  const from = easternDate(context.packedAt),
    through = easternDate(context.arrivalBy);
  const matches = policies.filter(
    (p) =>
      p.services.includes(context.service as PackingService) &&
      p.effectiveFrom <= from &&
      p.effectiveThrough >= through,
  );
  if (matches.length !== 1) return fail("packing_policy_coverage_gap");
  const policy = matches[0],
    exposureHours = elapsed + policy.delayAllowanceHours;
  // The allowance can cross midnight or a seasonal boundary, too.
  const delayedMs =
    Date.parse(context.arrivalBy) + policy.delayAllowanceHours * 3_600_000;
  if (
    exposureHours > policy.maxExposureHours ||
    !Number.isFinite(new Date(delayedMs).getTime())
  )
    return fail("packing_policy_exposure_exceeded");
  const delayedArrival = new Date(delayedMs).toISOString();
  if (easternDate(delayedArrival) > policy.effectiveThrough)
    return fail("packing_policy_exposure_exceeded");
  return {
    policy,
    exposureHours,
    elapsedHours: elapsed,
    packedAt: context.packedAt,
    arrivalBy: context.arrivalBy,
  };
}

/** No wildcard precedence or fallback to another service/box's ice quantity. */
export function selectPackingExposureRule(
  policy: SeasonalPackingPolicy, service: string, boxTier: string, exposureHours: number,
): PackingExposureRule | undefined {
  return policy.rules.find(r => r.service === service && r.boxTier === boxTier && r.throughHours >= exposureHours);
}
