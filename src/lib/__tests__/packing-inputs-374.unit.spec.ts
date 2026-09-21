import { packagingOverridesFromColdChainSetting, getPackagingConfig, resetPackagingOverridesCache } from "../packaging-cost-strapi";
import { resolvePackagingConfig } from "../packaging-cost";
import { createShippingPackingPlan } from "../shipping-packing-plan";
import { packingContext, shippingLine, weightRecord } from "./__fixtures__/shipping-inputs";
import { SHIPPING_WEIGHT_KEY, ShippingInputError } from "../shipping-weights";
import { validatePackingPublication } from "../seasonal-packing-policy";

// Synthetic fit/tare/limits and exposure labels, not Peter's operating approval.
// Quantities/costs exercise #371's three inputs and fractional small-box cases.
function settings() {
  const rule = (Service: string, BoxTier: string, ThroughHours: number, DryIceBlocksPerBox: number) =>
    ({ Service, BoxTier, ThroughHours, DryIceBlocksPerBox });
  return {
    Enabled: true, PackagingCostModel: "continuous_weight", PackingPolicyVersion: "fixture-blocks-v1",
    MinimumDryIceAmount: 2, DryIceBlockWeightLb: 10, DryIcePricePerLb: 1,
    PackagingBoxes: [
      { PackagingTier: "m330", Name: "Synthetic 330", UnitCost: 10, MaxProductWeightLb: 10, MaxTransitDays: 2 },
      { PackagingTier: "l345", Name: "Synthetic 345", UnitCost: 13.38, MaxProductWeightLb: null, MaxTransitDays: null },
    ].map(b => ({ ...b, MaxTotalWeightLb: 50, TareWeightLb: 1, LengthIn: 24, WidthIn: 17, HeightIn: 13,
      MaxFitUnits: 200, FitRuleId: "fixture-fit-v1", DryIceFitUnitsPerLb: 0.5 })),
    SeasonalPackingPolicies: [{ Name: "Synthetic block rules", Revision: "fixture-service-box-v1", Active: true,
      ApprovedBy: "synthetic-fixture", ApprovedAt: "2026-09-19T00:00:00Z", ApprovalReference: "test-only",
      EffectiveFrom: "2026-09-20", EffectiveThrough: "2026-12-31", DelayAllowanceHours: 0,
      MaxExposureHours: 72, MaxGrossWeightLb: 50, AllowGround: true, Allow2Day: true, AllowOvernight: true,
      Allow330: true, Allow345: true,
      ExposureRules: [
        rule("GROUND", "m330", 24, 1), rule("GROUND", "m330", 48, 1.5),
        rule("GROUND", "l345", 24, 1), rule("GROUND", "l345", 72, 2),
        rule("UPS_2ND_DAY_AIR", "m330", 48, 1.5), rule("UPS_2ND_DAY_AIR", "l345", 72, 2),
        rule("OVERNIGHT", "m330", 24, 0.75), rule("OVERNIGHT", "l345", 72, 1),
      ] }],
  };
}
function context(service = "GROUND", hours = 24) {
  const c = packingContext();
  return { ...c, service, validatedTransit: { ...c.validatedTransit,
    days: service === "2ND_DAY_AIR" ? 2 : 1, packingDays: Math.ceil(hours / 24), elapsedHours: hours,
    arrivalBy: new Date(Date.parse(c.validatedTransit.packedAt) + hours * 3600000).toISOString() } };
}
const configuration = (raw: unknown) => resolvePackagingConfig({
  strapi: packagingOverridesFromColdChainSetting(raw), env: { WWEX_MAX_PACKAGE_WEIGHT_LB: "50" },
});
const makePlan = (raw = settings(), c = context(), lines = [shippingLine()]) => createShippingPackingPlan(lines, c, configuration(raw));
const expectShippingFailure = (work: () => unknown, code: string) => {
  let failure: unknown;
  try { work(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ShippingInputError);
  expect(failure).toHaveProperty("code", code);
};

test.each([
  ["GROUND", 24, 10, 20], ["GROUND", 48, 15, 25], ["2ND_DAY_AIR", 48, 15, 25], ["OVERNIGHT", 24, 7.5, 17.5],
])("%s / %s hours preserves the small-box quantity without fractional physical boxes", (service, hours, ice, cost) => {
  const result = makePlan(settings(), context(service as string, hours as number));
  expect(result.boxes).toBe(1);
  expect(result.packages[0]).toMatchObject({ boxTier: "m330", dryIceLb: ice });
  expect(result.total).toBe(cost);
  expect(result.appliedPolicy.dryIceBlockWeightLb).toBe(10);
  expect(result.appliedPolicy.rule.service).toBe(service);
});

test("all three editable headers flow from CMS into quantities, costs and immutable quote identity", () => {
  const raw = settings(), original = makePlan(raw), frozen = JSON.stringify(original);
  raw.DryIcePricePerLb = 2;
  const price = makePlan(raw);
  expect(price.dryIceLb).toBe(10); expect(price.dryIceCost).toBe(20); expect(price.boxes).toBe(1);
  raw.DryIcePricePerLb = 1; raw.DryIceBlockWeightLb = 7;
  const seven = makePlan(raw);
  expect(seven.dryIceLb).toBe(7); expect(seven.dryIceCost).toBe(7); expect(seven.packages[0].grossWeightLb).toBe(9.5);
  raw.DryIceBlockWeightLb = 5;
  expect(makePlan(raw).dryIceLb).toBe(5);
  raw.DryIceBlockWeightLb = 10;
  const largeBasket = [shippingLine({ quantity: 12 })];
  const large = makePlan(raw, context(), largeBasket);
  expect(large.packages[0].boxTier).toBe("l345"); expect(large.boxCost).toBe(13.38);
  raw.PackagingBoxes[1].UnitCost = 15;
  const boxPrice = makePlan(raw, context(), largeBasket);
  expect(boxPrice.boxCost).toBe(15); expect(boxPrice.dryIceLb).toBe(large.dryIceLb);
  expect(new Set([original.id, price.id, seven.id]).size).toBe(3);
  expect(boxPrice.id).not.toBe(large.id);
  expect(JSON.stringify(original)).toBe(frozen);
});

test("minimum ice remains a physical floor, not an alias for block weight", () => {
  const raw = settings(); raw.DryIceBlockWeightLb = 5; raw.MinimumDryIceAmount = 7;
  const result = makePlan(raw, context("OVERNIGHT"));
  expect(result.dryIceLb).toBe(7);
  expect(result.appliedPolicy).toMatchObject({ minimumDryIceAmountLb: 7, dryIceBlockWeightLb: 5,
    rule: { dryIceBlocksPerBox: 0.75 } });
});

test("long exposure removes the small box instead of borrowing another service's rule", () => {
  const result = makePlan(settings(), context("GROUND", 60));
  expect(result.packages[0].boxTier).toBe("l345"); expect(result.dryIceLb).toBe(20);
  expect(result.transitDays).toBe(1); expect(result.elapsedPackingHours).toBe(60);
});

test("38 lb of food plus 20 lb ice is split rather than forced into a 50 lb package", () => {
  const line = shippingLine({ quantity: 2, variant: { ...shippingLine().variant, metadata: {
    qbd_list_id: "fixture-list-id", [SHIPPING_WEIGHT_KEY]: weightRecord({ physical_weight: 19, fit_units: 5 }),
  } } });
  const result = makePlan(settings(), context("GROUND", 48), [line]);
  expect(result.boxes).toBe(2); expect(result.dryIceLb).toBe(40);
  expect(result.packages.map(p => p.grossWeightLb)).toEqual([40, 40]);
});

test("changing block size repacks the same food when gross capacity is crossed", () => {
  const raw = settings(); raw.DryIceBlockWeightLb = 5;
  const line = shippingLine({ quantity: 2, variant: { ...shippingLine().variant, metadata: {
    qbd_list_id: "fixture-list-id", [SHIPPING_WEIGHT_KEY]: weightRecord({ physical_weight: 17, fit_units: 5 }),
  } } });
  const smallBlocks = makePlan(raw, context("GROUND", 48), [line]);
  raw.DryIceBlockWeightLb = 10;
  const largeBlocks = makePlan(raw, context("GROUND", 48), [line]);
  expect(smallBlocks.boxes).toBe(1); expect(largeBlocks.boxes).toBe(2);
  expect(smallBlocks.weights.physicalWeightLb).toBe(34);
  expect(largeBlocks.weights.physicalWeightLb).toBe(34);
  expect(largeBlocks.packages.every(p => p.grossWeightLb <= 50)).toBe(true);
});

test("another service's full-duration rule cannot cover a missing service band", () => {
  const raw = settings();
  raw.SeasonalPackingPolicies[0].ExposureRules = raw.SeasonalPackingPolicies[0].ExposureRules.filter(r =>
    !(r.Service === "OVERNIGHT" && r.BoxTier === "l345"));
  expectShippingFailure(() => makePlan(raw), "uncovered_exposure_limit");
});

test.each([undefined, null, 0, -1, "", "invalid"])("missing or invalid block weight %p never inherits a minimum/default", value => {
  const raw: any = settings(); raw.DryIceBlockWeightLb = value;
  expectShippingFailure(() => makePlan(raw), "invalid_ice_inputs");
});

test("ambiguous, foreign or legacy multiplier rules cannot publish or quote", () => {
  const changes = [
    (r: any) => { delete r.Service; }, (r: any) => { delete r.BoxTier; },
    (r: any) => { r.Service = "2ND_DAY_AIR"; }, (r: any) => { r.BoxTier = "unknown"; },
    (r: any) => { r.DryIceMultiplier = 1; },
    (r: any) => { delete r.DryIceBlocksPerBox; r.DryIceMultiplier = 1; },
  ];
  for (const change of changes) {
    const raw = settings(); change(raw.SeasonalPackingPolicies[0].ExposureRules[0]);
    expect(() => validatePackingPublication(raw)).toThrow("invalid_exposure_rule");
    expectShippingFailure(() => makePlan(raw), "invalid_exposure_rule");
  }
  const duplicate = settings(); duplicate.SeasonalPackingPolicies[0].ExposureRules.push({ ...duplicate.SeasonalPackingPolicies[0].ExposureRules[0] });
  expectShippingFailure(() => makePlan(duplicate), "contradictory_exposure_rules");
});

test("published read/cache refresh carries block-size edits without mutating an accepted plan", async () => {
  const originalFetch = global.fetch, raw = settings(); resetPackagingOverridesCache();
  const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(raw)) }) }));
  global.fetch = fetchMock as any;
  try {
    const env = { STRAPI_URL: "https://cms.example.test", STRAPI_TOKEN: "fixture", WWEX_MAX_PACKAGE_WEIGHT_LB: "50" };
    const accepted = createShippingPackingPlan([shippingLine()], context(), await getPackagingConfig(env, 1000));
    raw.DryIceBlockWeightLb = 7;
    const changed = createShippingPackingPlan([shippingLine()], context(), await getPackagingConfig(env, 301001));
    expect(changed.dryIceLb).toBe(7); expect(accepted.dryIceLb).toBe(10); expect(changed.id).not.toBe(accepted.id);
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect((fetchMock.mock.calls as any)[0][0]).toContain("status=published");
  } finally { global.fetch = originalFetch; resetPackagingOverridesCache(); }
});
