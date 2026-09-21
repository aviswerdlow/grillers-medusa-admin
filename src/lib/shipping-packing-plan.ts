import { createHash } from "node:crypto";
import {
  type PackagingCostConfig,
  type ContinuousPackagingBoxRule,
} from "./packaging-cost";
import {
  resolveShippingWeights,
  ShippingInputError,
  type ShippingLine,
  type ResolvedShippingWeights,
} from "./shipping-weights";
import {
  PackingPolicyError,
  selectSeasonalPackingPolicy,
  selectPackingExposureRule,
  type PackingExposureRule,
  validatePackingPublication,
} from "./seasonal-packing-policy";
export const SHIPPING_PACKING_PLAN_KEY = "shipping_packing_plan_v1";

export type ShippingPackingContext = {
  service: string;
  postalCode: string;
  dispatchDate?: string | null;
  arrivalDate?: string | null;
  /** Supplied only by a server calendar adapter, not directly from Store input. */
  validatedTransit?: {
    days: number;
    revision: string;
    packingDays?: number;
    elapsedHours?: number;
    packedAt?: string;
    arrivalBy?: string;
  };
};
export type PlannedShippingPackage = {
  boxTier: string;
  boxName: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  productWeightLb: number;
  dryIceLb: number;
  tareLb: number;
  grossWeightLb: number;
  fitUnits: number;
  fitCapacity: number;
  dryIceFitUnits: number;
  totalFitUnits: number;
  grossWeightLimitLb: number;
  contents: Array<{ variantId: string; quantity: number }>;
};
export type ShippingPackingPlan = {
  version: 1;
  id: string;
  policyVersion: string;
  fitRuleId: string;
  service: string;
  dispatchDate: string | null;
  arrivalDate: string | null;
  transitDays: number;
  transitSource: string;
  packingDays?: number;
  elapsedPackingHours?: number;
  appliedPolicy: ReturnType<typeof selectSeasonalPackingPolicy> & {
    rule: PackingExposureRule;
    minimumDryIceAmountLb: number;
    dryIceBlockWeightLb: number;
    dryIceUsdPerLb: number;
    boxUnitCost: number;
    dryIceFitUnitsPerLb: number;
    carrierMaxPackageWeightLb: number;
  };
  weights: ResolvedShippingWeights;
  packages: PlannedShippingPackage[];
  boxes: number;
  dryIceLb: number;
  dryIceCost: number;
  boxCost: number;
  total: number;
};

const rounded = (v: number, places = 4) => Number(v.toFixed(places));
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Whole sellable units are packed deterministically. Fit units select capacity;
 * only physical contents + ice + tare contribute to a carrier's gross mass. */
export function createShippingPackingPlan(
  lines: ShippingLine[],
  context: ShippingPackingContext,
  config: PackagingCostConfig,
  options: { persistedOrder?: boolean } = {},
): ShippingPackingPlan {
  const weights = resolveShippingWeights(lines, options);
  if (!weights.physicalWeightLb || !weights.fitRuleId)
    throw new ShippingInputError("no_physical_shipping_contents");
  if (
    config.model !== "continuous_weight" ||
    !config.continuous ||
    !config.policyVersion?.trim() ||
    config.enabled !== true
  )
    throw new ShippingInputError("unapproved_packing_policy");
  if (!positive(config.dryIceUsdPerLb))
    throw new ShippingInputError("invalid_dry_ice_cost");
  const transitDays = context.validatedTransit?.days;
  if (
    !Number.isSafeInteger(transitDays) ||
    !transitDays ||
    transitDays <= 0 ||
    !context.validatedTransit?.revision
  )
    throw new ShippingInputError("invalid_transit_context");
  const packingDays = context.validatedTransit?.packingDays;
  const elapsedHours = context.validatedTransit?.elapsedHours;
  if (packingDays !== undefined || elapsedHours !== undefined) {
    if (
      !Number.isSafeInteger(packingDays) ||
      packingDays! < 1 ||
      !Number.isFinite(elapsedHours) ||
      elapsedHours! <= 0 ||
      packingDays !== Math.ceil(elapsedHours! / 24)
    )
      throw new ShippingInputError("invalid_elapsed_packing_context");
  }
  let selected: ReturnType<typeof selectSeasonalPackingPolicy>;
  try {
    // Validate the same complete contract as the CMS publication gate. No
    // incomplete field may inherit an unstated legacy operating value.
    const policies = validatePackingPublication({
      Enabled: config.enabled,
      PackagingCostModel: config.model,
      PackingPolicyVersion: config.policyVersion,
      MinimumDryIceAmount: config.minimumDryIceAmountLb,
      DryIceBlockWeightLb: config.dryIceBlockWeightLb,
      DryIcePricePerLb: config.dryIceUsdPerLb,
      SeasonalPackingPolicies: config.seasonalPolicies,
      PackagingBoxes: config.continuous.boxRules.map((b) => ({
        PackagingTier: b.boxTier,
        Name: b.name,
        UnitCost: b.unitCost,
        LengthIn: b.lengthIn,
        WidthIn: b.widthIn,
        HeightIn: b.heightIn,
        MaxProductWeightLb: b.maxProductWeightLb,
        MaxTransitDays: b.maxTransitDays,
        MaxTotalWeightLb: b.maxTotalWeightLb,
        TareWeightLb: b.tareWeightLb,
        MaxFitUnits: b.maxFitUnits,
        FitRuleId: b.fitRuleId,
        DryIceFitUnitsPerLb: b.dryIceFitUnitsPerLb,
      })),
    });
    selected = selectSeasonalPackingPolicy(policies, {
      service: context.service,
      ...context.validatedTransit,
    });
  } catch (error) {
    if (error instanceof PackingPolicyError)
      throw new ShippingInputError(error.code);
    throw error;
  }
  if (!positive(config.carrierMaxPackageWeightLb))
    throw new ShippingInputError("invalid_carrier_package_limit");
  const physical = weights.lines.filter((line) => line.kind === "physical");
  const unitCount = physical.reduce((n, l) => n + l.quantity, 0);
  if (unitCount > 10000) throw new ShippingInputError("packing_unit_limit");

  const pack = (
    box: ContinuousPackagingBoxRule,
  ): { packages: PlannedShippingPackage[]; rule: PackingExposureRule } | null => {
    if (
      !selected.policy.boxTiers.includes(box.boxTier) ||
      (box.maxTransitDays !== null &&
        Math.ceil(selected.exposureHours / 24) > box.maxTransitDays)
    )
      return null;
    const rule = selectPackingExposureRule(selected.policy, context.service, box.boxTier, selected.exposureHours);
    if (!rule) return null;
    const ice = Math.max(config.minimumDryIceAmountLb!, config.dryIceBlockWeightLb! * rule.dryIceBlocksPerBox);
    if (!positive(ice)) throw new ShippingInputError("invalid_dry_ice_quantity");
    if (
      !positive(box.lengthIn) ||
      !positive(box.widthIn) ||
      !positive(box.heightIn) ||
      !positive(box.maxFitUnits) ||
      !positive(box.dryIceFitUnitsPerLb) ||
      box.fitRuleId !== weights.fitRuleId ||
      !positive(box.unitCost)
    )
      return null;
    const grossWeightLimitLb = Math.min(
      box.maxTotalWeightLb,
      selected.policy.maxGrossWeightLb,
      config.carrierMaxPackageWeightLb!,
    );
    const dryIceFitUnits = ice * box.dryIceFitUnitsPerLb;
    const foodFitCapacity = box.maxFitUnits - dryIceFitUnits;
    const capacity = Math.min(
      box.maxProductWeightLb ?? Infinity,
      grossWeightLimitLb - ice - box.tareWeightLb,
    );
    if (
      !positive(capacity) ||
      !positive(foodFitCapacity) ||
      !Number.isFinite(box.tareWeightLb) ||
      box.tareWeightLb < 0
    )
      return null;
    const units = physical
      .flatMap((l) =>
        Array.from({ length: l.quantity }, () => ({
          variantId: l.variantId,
          weight: l.physicalWeightLb / l.quantity,
          fit: l.fitUnits / l.quantity,
        })),
      )
      .sort(
        (a, b) =>
          Math.max(b.weight / capacity, b.fit / foodFitCapacity) -
            Math.max(a.weight / capacity, a.fit / foodFitCapacity) ||
          a.variantId.localeCompare(b.variantId),
      );
    const packages: PlannedShippingPackage[] = [];
    for (const unit of units) {
      if (unit.weight > capacity || unit.fit > foodFitCapacity) return null;
      let target = packages.find(
        (p) =>
          p.productWeightLb + unit.weight <= capacity + 1e-9 &&
          p.fitUnits + unit.fit <= foodFitCapacity + 1e-9,
      );
      if (!target) {
        target = {
          boxTier: box.boxTier,
          boxName: box.name,
          lengthIn: box.lengthIn,
          widthIn: box.widthIn,
          heightIn: box.heightIn,
          productWeightLb: 0,
          dryIceLb: ice,
          tareLb: box.tareWeightLb,
          grossWeightLb: 0,
          fitUnits: 0,
          fitCapacity: box.maxFitUnits,
          dryIceFitUnits,
          totalFitUnits: dryIceFitUnits,
          grossWeightLimitLb,
          contents: [],
        };
        packages.push(target);
      }
      target.productWeightLb += unit.weight;
      target.fitUnits += unit.fit;
      const existing = target.contents.find(
        (c) => c.variantId === unit.variantId,
      );
      if (existing) existing.quantity++;
      else target.contents.push({ variantId: unit.variantId, quantity: 1 });
    }
    return { rule, packages: packages.map((p) => ({
      ...p,
      productWeightLb: rounded(p.productWeightLb),
      fitUnits: rounded(p.fitUnits),
      totalFitUnits: rounded(p.fitUnits + p.dryIceFitUnits),
      grossWeightLb: rounded(p.productWeightLb + p.dryIceLb + p.tareLb),
    })) };
  };
  const candidates = config.continuous.boxRules
    .map((box) => ({ box, packed: pack(box) }))
    .filter((c) => c.packed !== null)
    .map((c) => ({
      ...c,
      packages: c.packed!.packages,
      rule: c.packed!.rule,
      cost: c.packed!.packages.reduce((cost, p) => cost + c.box.unitCost + p.dryIceLb * config.dryIceUsdPerLb, 0),
    }))
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        a.packages.length - b.packages.length ||
        a.box.boxTier.localeCompare(b.box.boxTier),
    );
  const choice = candidates[0];
  if (!choice) throw new ShippingInputError("no_approved_box_fits");
  const dryIceLb = choice.packages.reduce((total, p) => total + p.dryIceLb, 0);
  const dryIceCost = rounded(dryIceLb * config.dryIceUsdPerLb, 2),
    boxCost = rounded(choice.packages.length * choice.box.unitCost, 2);
  const result = {
    version: 1 as const,
    policyVersion: config.policyVersion,
    fitRuleId: weights.fitRuleId,
    // Copy approved values, not live references. Hash includes all policy,
    // exposure, capacity and cost inputs so changed quotes require acceptance.
    appliedPolicy: {
      ...selected,
      rule: choice.rule,
      minimumDryIceAmountLb: config.minimumDryIceAmountLb!,
      dryIceBlockWeightLb: config.dryIceBlockWeightLb!,
      dryIceUsdPerLb: config.dryIceUsdPerLb,
      boxUnitCost: choice.box.unitCost,
      dryIceFitUnitsPerLb: choice.box.dryIceFitUnitsPerLb!,
      carrierMaxPackageWeightLb: config.carrierMaxPackageWeightLb!,
    },
    service: context.service,
    dispatchDate: context.dispatchDate ?? null,
    arrivalDate: context.arrivalDate ?? null,
    ...(context.validatedTransit?.packingDays !== undefined
      ? {
          packingDays: context.validatedTransit.packingDays,
          elapsedPackingHours: context.validatedTransit.elapsedHours,
        }
      : {}),
    transitDays: transitDays!,
    transitSource: context.validatedTransit!.revision,
    weights,
    packages: choice.packages,
    boxes: choice.packages.length,
    dryIceLb,
    dryIceCost,
    boxCost,
    total: rounded(dryIceCost + boxCost, 2),
  };
  return {
    ...result,
    id: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  };
}
