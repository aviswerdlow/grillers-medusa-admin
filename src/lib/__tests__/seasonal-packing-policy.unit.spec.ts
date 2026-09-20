import {
  packingConfig,
  packingContext,
  seasonalPolicy,
  shippingLine,
  weightRecord,
} from "./__fixtures__/shipping-inputs";
import { createShippingPackingPlan } from "../shipping-packing-plan";
import {
  parseSeasonalPackingPolicies,
  selectSeasonalPackingPolicy,
  PackingPolicyError,
} from "../seasonal-packing-policy";
import { carrierPackageWeightLimit } from "../shipping-carrier-limits";
import { ShippingInputError, SHIPPING_WEIGHT_KEY } from "../shipping-weights";

const now = new Date("2026-09-20T00:00:00Z");
const policies = (rows: any[]) => parseSeasonalPackingPolicies(rows, now);
const plan = (
  config = packingConfig(),
  context = packingContext(),
  lines = [shippingLine()],
) => createShippingPackingPlan(lines, context, config);
const compactLine = (mass: number, fit: number, quantity = 1) =>
  shippingLine({
    quantity,
    variant: {
      ...shippingLine().variant,
      metadata: {
        qbd_list_id: "fixture-list-id",
        [SHIPPING_WEIGHT_KEY]: weightRecord({
          physical_weight: mass,
          fit_units: fit,
        }),
      },
    },
  });

test("effective-date hot policy changes ice and package count for the same food, preserving dimensions", () => {
  const config = packingConfig();
  config.seasonalPolicies = [
    seasonalPolicy({ EffectiveThrough: "2026-09-30" }),
    seasonalPolicy({
      Name: "Synthetic hot",
      Revision: "fixture-hot-v1",
      EffectiveFrom: "2026-10-01",
      ExposureRules: [{ ThroughHours: 168, DryIceMultiplier: 2 }],
    }),
  ];
  config.continuous!.boxRules.forEach((b) => {
    b.dryIceFitUnitsPerLb = 0.5;
  });
  const context = packingContext(),
    lines = [compactLine(8, 4.5, 2)];
  const normal = plan(
    config,
    {
      ...context,
      validatedTransit: {
        ...context.validatedTransit,
        packedAt: "2026-09-22T16:00:00Z",
        arrivalBy: "2026-09-23T16:00:00Z",
      },
    },
    lines,
  );
  const hot = plan(config, context, lines);
  expect(normal).toMatchObject({
    boxes: 1,
    dryIceLb: 2,
    weights: { physicalWeightLb: 16 },
  });
  expect(hot).toMatchObject({
    boxes: 2,
    dryIceLb: 8,
    weights: { physicalWeightLb: 16 },
    appliedPolicy: { policy: { revision: "fixture-hot-v1" } },
  });
  expect(hot.packages[0]).toMatchObject({
    lengthIn: 10,
    widthIn: 11,
    heightIn: 12,
    productWeightLb: 8,
    dryIceLb: 4,
    tareLb: 1,
    grossWeightLb: 13,
    fitUnits: 4.5,
    dryIceFitUnits: 2,
    totalFitUnits: 6.5,
    fitCapacity: 10,
  });
});

test("a delay allowance crosses the exposure band without changing carrier business days", () => {
  const config = packingConfig();
  config.seasonalPolicies = [seasonalPolicy({ DelayAllowanceHours: 1 })];
  expect(plan(config)).toMatchObject({
    transitDays: 1,
    packingDays: 1,
    dryIceLb: 4,
    appliedPolicy: { elapsedHours: 24, exposureHours: 25 },
  });
});

test("actual instants include the fall DST hour and warehouse/holiday holds", () => {
  const context = packingContext();
  context.validatedTransit = {
    ...context.validatedTransit,
    packedAt: "2026-10-31T12:00:00-04:00",
    arrivalBy: "2026-11-01T12:00:00-05:00",
    elapsedHours: 25,
    packingDays: 2,
  };
  expect(plan(packingConfig(), context)).toMatchObject({
    transitDays: 1,
    dryIceLb: 4,
    appliedPolicy: { elapsedHours: 25 },
  });
  context.validatedTransit = {
    ...context.validatedTransit,
    packedAt: "2026-10-02T16:00:00Z",
    arrivalBy: "2026-10-06T16:00:00Z",
    elapsedHours: 96,
    packingDays: 4,
  };
  expect(plan(packingConfig(), context).packages[0].boxTier).toBe("l345");
});

test.each([
  { ApprovedBy: "" },
  { ApprovedAt: "2099-01-01T00:00:00Z" },
  { EffectiveFrom: "2026-02-30" },
  { MaxExposureHours: 0 },
  { DelayAllowanceHours: -1 },
  { ExposureRules: [{ ThroughHours: 24, DryIceMultiplier: 1 }] },
  {
    ExposureRules: [
      { ThroughHours: 24, DryIceMultiplier: 3 },
      { ThroughHours: 168, DryIceMultiplier: 2 },
    ],
  },
  {
    ExposureRules: [
      { ThroughHours: 168, DryIceMultiplier: 1 },
      { ThroughHours: 168, DryIceMultiplier: 1 },
    ],
  },
  {
    AllowGround: false,
    Allow3Day: false,
    Allow2Day: false,
    AllowOvernight: false,
  },
])("rejects incomplete or contradictory approval %p", (change) => {
  expect(() => policies([seasonalPolicy(change)])).toThrow(PackingPolicyError);
});

test("overlap for one service is ambiguous; disjoint service policies can coexist", () => {
  expect(() =>
    policies([seasonalPolicy(), seasonalPolicy({ Revision: "second" })]),
  ).toThrow("overlapping_policy_periods");
  const ground = seasonalPolicy({
    Allow3Day: false,
    Allow2Day: false,
    AllowOvernight: false,
  });
  const air = seasonalPolicy({ Revision: "air", AllowGround: false });
  expect(policies([ground, air])).toHaveLength(2);
});

test("missing, inactive, uncovered, service-restricted or cross-season rules do not get a normal fallback", () => {
  for (const raw of [
    undefined,
    [],
    [seasonalPolicy({ Active: false })],
    [seasonalPolicy({ AllowGround: false })],
    [seasonalPolicy({ EffectiveThrough: "2026-10-05" })],
    [
      seasonalPolicy({
        EffectiveThrough: "2026-10-06",
        DelayAllowanceHours: 20,
      }),
    ],
  ]) {
    const config = packingConfig();
    config.seasonalPolicies = raw;
    expect(() => plan(config)).toThrow(ShippingInputError);
  }
  const context = packingContext();
  expect(() =>
    selectSeasonalPackingPolicy(policies([seasonalPolicy()]), {
      service: "GROUND",
      ...context.validatedTransit,
      packedAt: "2026-10-05T16:00:00",
    }),
  ).toThrow("missing_packing_instants");
  expect(() =>
    plan(packingConfig(), {
      ...context,
      validatedTransit: { ...context.validatedTransit, elapsedHours: 23 },
    }),
  ).toThrow(ShippingInputError);
});

test("ice cost alone changes the frozen quote price/id, never ice quantity or box count", () => {
  const config = packingConfig(),
    original = plan(config),
    frozen = JSON.stringify(original);
  config.dryIceUsdPerLb = 2;
  const changed = plan(config);
  expect(changed.dryIceLb).toBe(original.dryIceLb);
  expect(changed.boxes).toBe(original.boxes);
  expect(changed.dryIceCost).toBe(original.dryIceCost * 2);
  expect(changed.id).not.toBe(original.id);
  (config.seasonalPolicies as any[])[0].ExposureRules[0].DryIceMultiplier = 20;
  expect(JSON.stringify(original)).toBe(frozen);
});

test("planner and carrier share the lower configured gross cap, including ice and tare", () => {
  const config = packingConfig();
  expect(config.carrierMaxPackageWeightLb).toBe(carrierPackageWeightLimit({}));
  expect(plan(config, packingContext(), [compactLine(19, 1, 2)]).boxes).toBe(2);
  config.continuous!.boxRules.forEach((b) => {
    b.maxProductWeightLb = null;
  });
  config.carrierMaxPackageWeightLb = carrierPackageWeightLimit({
    WWEX_MAX_PACKAGE_WEIGHT_LB: "50",
  });
  expect(
    plan(config, packingContext(), [compactLine(19, 1, 2)]).packages[0]
      .grossWeightLb,
  ).toBe(41);
  expect(() =>
    carrierPackageWeightLimit({ WWEX_MAX_PACKAGE_WEIGHT_LB: "garbage" }),
  ).toThrow(ShippingInputError);
});

test("unsupported fit, ice consuming all space, box restrictions, or disabled policy cannot quote", () => {
  for (const change of [
    (c: ReturnType<typeof packingConfig>) => {
      c.enabled = false;
    },
    (c: ReturnType<typeof packingConfig>) => {
      c.continuous!.boxRules.forEach((b) => {
        b.dryIceFitUnitsPerLb = null;
      });
    },
    (c: ReturnType<typeof packingConfig>) => {
      c.continuous!.boxRules.forEach((b) => {
        b.dryIceFitUnitsPerLb = 100;
      });
    },
    (c: ReturnType<typeof packingConfig>) => {
      c.seasonalPolicies = [
        seasonalPolicy({ Allow330: false, Allow345: false }),
      ];
    },
    (c: ReturnType<typeof packingConfig>) => {
      c.carrierMaxPackageWeightLb = 3;
    },
  ]) {
    const config = packingConfig();
    change(config);
    expect(() => plan(config)).toThrow(ShippingInputError);
  }
});
