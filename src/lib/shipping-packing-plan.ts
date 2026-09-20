import { createHash } from "node:crypto";
import {
  transitDaysForOrder,
  type PackagingCostConfig,
  type ContinuousPackagingBoxRule,
} from "./packaging-cost";
import {
  resolveShippingWeights,
  ShippingInputError,
  type ShippingLine,
  type ResolvedShippingWeights,
} from "./shipping-weights";
export const SHIPPING_PACKING_PLAN_KEY = "shipping_packing_plan_v1";

export type ShippingPackingContext = {
  service: string;
  postalCode: string;
  dispatchDate?: string | null;
  arrivalDate?: string | null;
  /** Supplied only by a server calendar adapter, not directly from Store input. */
  validatedTransit?: { days: number; revision: string };
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
    !config.policyVersion?.trim()
  )
    throw new ShippingInputError("unapproved_packing_policy");
  if (!positive(config.dryIceUsdPerLb))
    throw new ShippingInputError("invalid_dry_ice_cost");
  const transitDays =
    context.validatedTransit?.days ??
    transitDaysForOrder(context.service, context.postalCode);
  if (
    !Number.isSafeInteger(transitDays) ||
    transitDays <= 0 ||
    (context.validatedTransit && !context.validatedTransit.revision)
  )
    throw new ShippingInputError("invalid_transit_context");
  const threshold = [...config.continuous.dryIceByTransitDays]
    .filter((r) => r.transitDays <= transitDays)
    .sort((a, b) => b.transitDays - a.transitDays)[0];
  if (!threshold || !positive(threshold.dryIceLbPerBox))
    throw new ShippingInputError("missing_transit_packing_rule");
  const ice = threshold.dryIceLbPerBox;
  const physical = weights.lines.filter((line) => line.kind === "physical");
  const unitCount = physical.reduce((n, l) => n + l.quantity, 0);
  if (unitCount > 10000) throw new ShippingInputError("packing_unit_limit");

  const pack = (
    box: ContinuousPackagingBoxRule,
  ): PlannedShippingPackage[] | null => {
    if (box.maxTransitDays !== null && transitDays > box.maxTransitDays)
      return null;
    if (
      !positive(box.lengthIn) ||
      !positive(box.widthIn) ||
      !positive(box.heightIn) ||
      !positive(box.maxFitUnits) ||
      box.fitRuleId !== weights.fitRuleId ||
      !positive(box.unitCost)
    )
      return null;
    const capacity = Math.min(
      box.maxProductWeightLb ?? Infinity,
      box.maxTotalWeightLb - ice - box.tareWeightLb,
    );
    if (
      !positive(capacity) ||
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
          Math.max(b.weight / capacity, b.fit / box.maxFitUnits!) -
            Math.max(a.weight / capacity, a.fit / box.maxFitUnits!) ||
          a.variantId.localeCompare(b.variantId),
      );
    const packages: PlannedShippingPackage[] = [];
    for (const unit of units) {
      if (unit.weight > capacity || unit.fit > box.maxFitUnits) return null;
      let target = packages.find(
        (p) =>
          p.productWeightLb + unit.weight <= capacity + 1e-9 &&
          p.fitUnits + unit.fit <= box.maxFitUnits! + 1e-9,
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
    return packages.map((p) => ({
      ...p,
      productWeightLb: rounded(p.productWeightLb),
      fitUnits: rounded(p.fitUnits),
      grossWeightLb: rounded(p.productWeightLb + p.dryIceLb + p.tareLb),
    }));
  };
  const candidates = config.continuous.boxRules
    .map((box) => ({ box, packages: pack(box) }))
    .filter((c) => c.packages !== null)
    .map((c) => ({
      ...c,
      packages: c.packages!,
      cost: c.packages!.length * (c.box.unitCost + ice * config.dryIceUsdPerLb),
    }))
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        a.packages.length - b.packages.length ||
        a.box.boxTier.localeCompare(b.box.boxTier),
    );
  const choice = candidates[0];
  if (!choice) throw new ShippingInputError("no_approved_box_fits");
  const dryIceLb = choice.packages.length * ice;
  const dryIceCost = rounded(dryIceLb * config.dryIceUsdPerLb, 2),
    boxCost = rounded(choice.packages.length * choice.box.unitCost, 2);
  const result = {
    version: 1 as const,
    policyVersion: config.policyVersion,
    fitRuleId: weights.fitRuleId,
    service: context.service,
    dispatchDate: context.dispatchDate ?? null,
    arrivalDate: context.arrivalDate ?? null,
    transitDays,
    transitSource: context.validatedTransit?.revision ?? "legacy_zip3_v1",
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
