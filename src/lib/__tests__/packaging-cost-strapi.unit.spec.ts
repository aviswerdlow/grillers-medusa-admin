import { resolvePackagingConfig } from "../packaging-cost"
import { createShippingPackingPlan } from "../shipping-packing-plan"
import { ShippingInputError } from "../shipping-weights"
import { packingContext, seasonalPolicy, shippingLine } from "./__fixtures__/shipping-inputs"
import {
  fetchPackagingOverridesFromStrapi,
  getPackagingConfig,
  packagingOverridesFromColdChainSetting,
  resetPackagingOverridesCache,
} from "../packaging-cost-strapi"

it("retains the reviewed policy, external dimensions and separate fit calibration",()=>{
  expect(packagingOverridesFromColdChainSetting({PackingPolicyVersion:"review-v1",PackagingBoxes:[{PackagingTier:"m330",LengthIn:18,WidthIn:15,HeightIn:13,MaxFitUnits:12,FitRuleId:"fit-v1"}]})).toMatchObject({policyVersion:"review-v1",packagingBoxes:[{lengthIn:18,widthIn:15,heightIn:13,maxFitUnits:12,fitRuleId:"fit-v1"}]})
})

it("preserves the approved seasonal rows and ice space without fabricating defaults", () => {
  const rows = [seasonalPolicy()];
  expect(packagingOverridesFromColdChainSetting({ Enabled: true, SeasonalPackingPolicies: rows, PackagingBoxes: [{ DryIceFitUnitsPerLb: 0.25 }] })).toMatchObject({ enabled: true, seasonalPolicies: rows, packagingBoxes: [{ dryIceFitUnitsPerLb: 0.25 }] });
})

describe("resolvePackagingConfig — layering default < strapi < env", () => {
  it("defaults to Peter's numbers with no strapi/env", () => {
    const c = resolvePackagingConfig({})
    expect(c.dryIceUsdPerLb).toBe(0.6)
    expect(c.boxCost).toEqual({ micro: 7.54, m330: 9.98, l345: 16.06 })
  })

  it("Strapi overrides the default", () => {
    const c = resolvePackagingConfig({
      strapi: { dryIceUsdPerLb: 0.5, boxCost: { l345: 18.0 } },
      env: {},
    })
    expect(c.dryIceUsdPerLb).toBe(0.5)
    expect(c.boxCost.l345).toBe(18.0)
    expect(c.boxCost.micro).toBe(7.54) // untouched → default
  })

  it("env overrides Strapi", () => {
    const c = resolvePackagingConfig({
      strapi: { dryIceUsdPerLb: 0.5 },
      env: { GRILLERS_DRY_ICE_USD_PER_LB: "0.8" },
    })
    expect(c.dryIceUsdPerLb).toBe(0.8)
  })

  it("ignores invalid Strapi values (null / negative / zero) → default", () => {
    const c = resolvePackagingConfig({
      strapi: { dryIceUsdPerLb: null, boxCost: { l345: -3, m330: 0 } },
      env: {},
    })
    expect(c.dryIceUsdPerLb).toBe(0.6)
    expect(c.boxCost.l345).toBe(16.06)
    expect(c.boxCost.m330).toBe(9.98) // explicit 0 rejected → default
  })

  it("activates continuous mode only with a complete normalized table", () => {
    const strapi = {
      model: "continuous_weight",
      minimumDryIceAmountLb: 7,
      transitDayThresholds: [
        { transitDays: 3, dryIceMultiplier: 3 },
        { transitDays: 1, dryIceMultiplier: 1 },
        { transitDays: 2, dryIceMultiplier: 2 },
      ],
      packagingBoxes: [
        {
          boxTier: "m330",
          name: "Medium",
          unitCost: 10,
          maxProductWeightLb: 10,
          maxTransitDays: 2,
          maxTotalWeightLb: 50,
          tareWeightLb: 0,
        },
        {
          boxTier: "l345",
          name: "Large",
          unitCost: 13.38,
          maxProductWeightLb: null,
          maxTransitDays: null,
          maxTotalWeightLb: 50,
          tareWeightLb: 0,
        },
      ],
    }
    const c = resolvePackagingConfig({ strapi, env: {} })
    expect(c.model).toBe("continuous_weight")
    expect(c.continuous?.dryIceByTransitDays).toEqual([
      { transitDays: 1, dryIceLbPerBox: 7 },
      { transitDays: 2, dryIceLbPerBox: 14 },
      { transitDays: 3, dryIceLbPerBox: 21 },
    ])
    expect(c.continuous?.boxRules.map((box) => box.boxTier)).toEqual(["m330", "l345"])

    expect(
      resolvePackagingConfig({
        strapi: {
          ...strapi,
          transitDayThresholds: strapi.transitDayThresholds.filter(
            (row) => row.transitDays !== 2
          ),
        },
        env: {},
      }).model
    ).toBe("legacy_tiered")
    expect(
      resolvePackagingConfig({
        strapi,
        env: { GRILLERS_PACKAGING_COST_MODEL: "legacy_tiered" },
      }).model
    ).toBe("legacy_tiered")
  })
})

describe("packagingOverridesFromColdChainSetting", () => {
  it("maps the Strapi v5 flat shape", () => {
    expect(
      packagingOverridesFromColdChainSetting({
        PackagingCostModel: "continuous_weight",
        DryIcePricePerLb: 0.6,
        BoxCostMicro: 7.54,
        BoxCost330: 9.98,
        BoxCost345: 16.06,
        MinimumDryIceAmount: 7,
        TransitDayThresholds: [
          { TransitDays: 1, DryIceMultiplier: 1 },
          { TransitDays: 2, DryIceMultiplier: 2 },
          { TransitDays: 3, DryIceMultiplier: 3 },
        ],
        PackagingBoxes: [
          {
            PackagingTier: "m330",
            Name: "Medium 18 x 15 x 13",
            UnitCost: 10,
            MaxProductWeightLb: 10,
            MaxTransitDays: 2,
            MaxTotalWeightLb: 50,
            TareWeightLb: 0,
            Active: true,
          },
        ],
      })
    ).toEqual({
      model: "continuous_weight",
      dryIceUsdPerLb: 0.6,
      boxCost: { micro: 7.54, m330: 9.98, l345: 16.06 },
      minimumDryIceAmountLb: 7,
      transitDayThresholds: [
        { transitDays: 1, dryIceMultiplier: 1 },
        { transitDays: 2, dryIceMultiplier: 2 },
        { transitDays: 3, dryIceMultiplier: 3 },
      ],
      packagingBoxes: [
        {
          boxTier: "m330",
          name: "Medium 18 x 15 x 13",
          unitCost: 10,
          maxProductWeightLb: 10,
          maxTransitDays: 2,
          maxTotalWeightLb: 50,
          tareWeightLb: 0,
          active: true,
        },
      ],
    })
  })

  it("maps the Strapi v4 attributes shape", () => {
    const o = packagingOverridesFromColdChainSetting({
      attributes: { DryIcePricePerLb: 0.55 },
    })
    expect(o.dryIceUsdPerLb).toBe(0.55)
  })

  it("unwraps v4 component rows", () => {
    const o = packagingOverridesFromColdChainSetting({
      attributes: {
        MinimumDryIceAmount: "7",
        TransitDayThresholds: [
          { attributes: { TransitDays: 1, DryIceMultiplier: "1" } },
        ],
        PackagingBoxes: [
          {
            attributes: {
              PackagingTier: "l345",
              Name: "Large",
              UnitCost: "13.38",
              MaxTotalWeightLb: "50",
              TareWeightLb: "0",
            },
          },
        ],
      },
    })
    expect(o.minimumDryIceAmountLb).toBe("7")
    expect(o.transitDayThresholds).toEqual([
      { transitDays: 1, dryIceMultiplier: "1" },
    ])
    expect(o.packagingBoxes?.[0]).toMatchObject({
      boxTier: "l345",
      unitCost: "13.38",
      tareWeightLb: "0",
    })
  })

  it("missing fields → null (fall back to defaults downstream)", () => {
    const o = packagingOverridesFromColdChainSetting({})
    expect(o.model).toBeNull()
    expect(o.dryIceUsdPerLb).toBeNull()
    expect(o.boxCost).toEqual({ micro: null, m330: null, l345: null })
    expect(o.minimumDryIceAmountLb).toBeNull()
    expect(o.transitDayThresholds).toEqual([])
    expect(o.packagingBoxes).toEqual([])
  })
})

describe("getPackagingConfig — fetch + cache", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    resetPackagingOverridesCache()
  })

  it("applies Strapi values and caches within the TTL", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: { DryIcePricePerLb: 0.55 } }),
    })) as any
    global.fetch = fetchMock
    const env = { STRAPI_URL: "https://strapi.test", STRAPI_TOKEN: "t" }

    const c1 = await getPackagingConfig(env, 1_000)
    const c2 = await getPackagingConfig(env, 2_000) // within TTL
    expect(c1.dryIceUsdPerLb).toBe(0.55)
    expect(c2.dryIceUsdPerLb).toBe(0.55)
    expect(fetchMock).toHaveBeenCalledTimes(1) // cached
    expect(fetchMock.mock.calls[0][0]).toContain(
      "populate[TransitDayThresholds]=*&populate[PackagingBoxes]=*"
    )
    expect(fetchMock.mock.calls[0][0]).toContain("status=published")
    expect(fetchMock.mock.calls[0][0]).toContain("populate[SeasonalPackingPolicies][populate][ExposureRules]=*")

    // past the TTL → refetch
    await getPackagingConfig(env, 1_000 + 6 * 60 * 1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not share cached policy between CMS origins or tokens", async () => {
    const mock = jest.fn(async () => ({ ok: true, json: async () => ({ data: { Enabled: false } }) }));
    global.fetch = mock as any;
    await getPackagingConfig({ STRAPI_URL: "https://first.test", STRAPI_TOKEN: "fixture-one" }, 1000);
    await getPackagingConfig({ STRAPI_URL: "https://second.test", STRAPI_TOKEN: "fixture-one" }, 2000);
    await getPackagingConfig({ STRAPI_URL: "https://second.test", STRAPI_TOKEN: "fixture-two" }, 3000);
    expect(mock).toHaveBeenCalledTimes(3);
  })

  it("falls back to defaults when Strapi fails (never throws)", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("network down")
    }) as any
    const c = await getPackagingConfig(
      { STRAPI_URL: "https://strapi.test" },
      Date.now()
    )
    expect(c.dryIceUsdPerLb).toBe(0.6) // default
    expect(() => createShippingPackingPlan([shippingLine()], packingContext(), c)).toThrow(ShippingInputError)
  })

  it("returns {} overrides when STRAPI_URL is unset", async () => {
    const o = await fetchPackagingOverridesFromStrapi({})
    expect(o).toEqual({})
  })
})
