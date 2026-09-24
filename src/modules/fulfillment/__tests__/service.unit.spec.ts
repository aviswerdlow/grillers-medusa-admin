import { shippingLine, packingConfig } from "../../../lib/__tests__/__fixtures__/shipping-inputs"
import { PHYSICAL_WEIGHT_CONTRACT } from "../../../lib/shipping-weights"
import { getPackagingConfig } from "../../../lib/packaging-cost-strapi"
import { MedusaError } from "@medusajs/framework/utils"
import GrillersFulfillmentProviderService from "../service"
import { emitOpsAlert } from "../../../lib/ops-alert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

jest.mock("../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
}

const wwexEnv = {
  WWEX_AUTH_URL: "https://auth.example.test/oauth/token",
  WWEX_API_BASE_URL: "https://speedship.example.test/svc",
  WWEX_CLIENT_ID: "client_id",
  WWEX_CLIENT_SECRET: "client_secret",
  WWEX_AUDIENCE: "audience",
  WWEX_ORIGIN_ADDRESS_1: "123 Plant Rd",
  WWEX_ORIGIN_CITY: "Doraville",
  WWEX_ORIGIN_STATE: "GA",
  WWEX_ORIGIN_POSTAL_CODE: "30340",
  WWEX_ORIGIN_PHONE: "7704548108",
}

const forecastEnv = {
  GRILLERS_SHIPPING_FORECAST_ENABLED: "true",
}

jest.mock("../../../lib/packaging-cost-strapi", () => ({ getPackagingConfig: jest.fn() }))

function service() {
  const query={graph:jest.fn(async ({filters})=>({data:filters.id.map((id:string)=>({...shippingLine().variant,id}))}))}
  return new GrillersFulfillmentProviderService({ logger, query } as any, {})
}

function setWwexEnv() {
  Object.assign(process.env, wwexEnv)
}

function clearWwexEnv() {
  for (const key of Object.keys(wwexEnv)) {
    delete process.env[key]
  }
}

function clearForecastEnv() {
  delete process.env.GRILLERS_SHIPPING_FORECAST_ENABLED
  delete process.env.GRILLERS_SHIPPING_FORECAST_MODEL_PATH
  delete process.env.GRILLERS_SHIPPING_FORECAST_SAFETY_PERCENTILE
  delete process.env.GRILLERS_SHIPPING_FORECAST_MIN_USD
  delete process.env.GRILLERS_SHIPPING_FORECAST_MAX_USD
}

function writeConstantForecastModel(amount: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-shipping-forecast-"))
  const modelPath = path.join(dir, "model.json")
  fs.writeFileSync(
    modelPath,
    JSON.stringify({
      status: "trained",
      schema_version: "shipping_cost_forecast_v2",
      weight_input_contract: PHYSICAL_WEIGHT_CONTRACT,
      generated_at: "2026-06-16T00:00:00.000Z",
      smearing_factor: 1,
      features: {
        columns: ["__intercept"],
        numeric_stats: {},
      },
      coefficients: {
        __intercept: Math.log1p(amount),
      },
      fallbacks: {
        residual_abs_p75: 10,
        residual_abs_p90: 20,
      },
    })
  )
  return modelPath
}

function writeCorruptForecastModel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-shipping-forecast-corrupt-"))
  const modelPath = path.join(dir, "model.json")
  fs.writeFileSync(modelPath, "{ not valid json")
  return modelPath
}

function mockShippingZones(zones: any[]) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: zones }),
  } as any)
}

const forecastCart = {
  shipping_address: { province: "VA", postal_code: "23219" },
  items: [
    {
      variant_id: "variant_fixture",
      unit_price: 100,
      quantity: 2,
      metadata: { pricing_mode: "per lb", estimated_weight_lb: 1.2 },
    },
  ],
}

describe("GrillersFulfillmentProviderService", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    clearWwexEnv()
    clearForecastEnv()
    ;(getPackagingConfig as jest.Mock).mockResolvedValue(packingConfig())
  })

  it("blocks unavailable physical inputs before forecast, carrier or price-table fallback",async()=>{
    const svc=service(); global.fetch=jest.fn();
    await expect(svc.calculatePrice({service_code:"GROUND"} as any,{items:[{quantity:1}],shipping_address:{postal_code:"30340"}} as any,{} as any)).rejects.toThrow("item-weight or packing review");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({alertKind:"shipping_inputs_unavailable"}));
  });

  it("replaces caller packing data with the reviewed server plan at selection",async()=>{
    const svc=service();
    const result=await svc.validateFulfillmentData({service_code:"GROUND"},{service_code:"PICKUP",packages:[{packed_weight_lb:1}],shipping_packing_plan_v1:{fake:true}},{items:[shippingLine()],shipping_address:{postal_code:"30340"}});
    expect(result.service_code).toBe("GROUND");expect(result.packages).toBeUndefined();
    expect(result.shipping_packing_plan_v1.weights.physicalWeightLb).toBe(1.5);
  });

  it("exposes UPS Ground, 3 Day Select, 2nd Day Air, and Overnight services", async () => {
    const options = await service().getFulfillmentOptions()
    expect(options.map((option) => option.service_code)).toEqual(
      expect.arrayContaining([
        "GROUND",
        "3_DAY_SELECT",
        "2ND_DAY_AIR",
        "OVERNIGHT",
      ])
    )
  })

  it("rates UPS 3 Day Select from a dedicated Strapi shipping-zone row", async () => {
    mockShippingZones([
      {
        ZoneCode: "FedexOvernight",
        Description: "Overnight Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 160 }],
      },
      {
        ZoneCode: "Fedex3Day",
        Description: "3 Day Select Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 75 }],
      },
    ])

    const result = await service().calculatePrice(
      { service_code: "3_DAY_SELECT" } as any,
      {
        shipping_address: { postal_code: "90048" },
        items: [{ variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} }],
      } as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(75)
  })

  it("alerts when Atlanta structured delivery rates fall back to shipping zones", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              ZIPCode: "30340",
              Description: "Atlanta delivery fallback",
              ShippingZoneBreakpoints: [
                { BreakpointPrice: 0, ShippingRate: 12 },
              ],
            },
          ],
        }),
      } as any)

    const result = await service().calculatePrice(
      { service_code: "ATLANTA_DELIVERY" } as any,
      {
        shipping_address: { postal_code: "30340", province: "GA" },
        items: [{ variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} }],
      } as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(12)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "atlanta_delivery_structured_rate_fallback",
        title:
          "Atlanta delivery structured rate unavailable; using shipping-zone fallback",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        meta: expect.objectContaining({
          service_code: "ATLANTA_DELIVERY",
          fallback: "shipping_zones",
          fallback_reason: "missing_active_zone",
          destination_postal_code: "30340",
          destination_province: "GA",
          item_count: 1,
          eligible_subtotal: 100,
          response_status: 200,
        }),
      })
    )
  })

  it("uses WWEX Speedship quotes for UPS services when configured", async () => {
    setWwexEnv()
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "token", expires_in: 86400 }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          clientStatus: { success: true },
          response: {
            offerList: [
              {
                offerId: "offer-ground",
                productTransactionId: "ptr-ground",
                offeredProductList: [
                  {
                    offerPrice: { value: 17.59, unit: "USD" },
                    shopRQShipment: {
                      timeInTransit: {
                        upsServiceCode: "GND",
                        transitDays: 1,
                        estimatedDeliveryDate: "2026-06-17",
                      },
                    },
                  },
                ],
              },
            ],
          },
        }),
      } as any)

    const result = await service().calculatePrice(
      { service_code: "GROUND" } as any,
      {
        shipping_address: {
          address_1: "3838 Oak Lawn Ave",
          city: "Highland Park",
          province: "TX",
          postal_code: "75219",
          country_code: "US",
          first_name: "Test",
          last_name: "Customer",
          phone: "2148798521",
        },
        items: [{ variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} }],
      } as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(17.59)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it("alerts and falls back to Strapi zones when a live WWEX checkout quote fails", async () => {
    setWwexEnv()
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "token", expires_in: 86400 }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          clientStatus: {
            success: false,
            message: "carrier maintenance window",
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              ZoneCode: "FedexGround",
              Description: "Ground Estimated Shipping Charge",
              ShippingZoneBreakpoints: [
                { BreakpointPrice: 0, ShippingRate: 75 },
              ],
            },
          ],
        }),
      } as any)

    const result = await service().calculatePrice(
      { service_code: "GROUND" } as any,
      {
        shipping_address: {
          address_1: "3838 Oak Lawn Ave",
          city: "Highland Park",
          province: "TX",
          postal_code: "75219",
          country_code: "US",
          first_name: "Test",
          last_name: "Customer",
          phone: "2148798521",
        },
        items: [
          { variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} },
          { variant_id: "variant_fixture", unit_price: 200, quantity: 2, metadata: {} },
        ],
      } as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(75)
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "wwex_checkout_quote_failed",
        title: "WWEX checkout GROUND quote failed; using Strapi fallback",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        meta: expect.objectContaining({
          service_code: "GROUND",
          fallback: "strapi_shipping_zones",
          destination_country: "US",
          destination_province: "TX",
          item_count: 2,
          error_message:
            "WWEX shopFlow failed: carrier maintenance window",
        }),
      })
    )
  })

  it("uses the historical shipping forecast (mean + p75 buffer) for UPS rates only when enabled", async () => {
    Object.assign(process.env, forecastEnv, {
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: writeConstantForecastModel(42),
    })
    mockShippingZones([
      {
        ZoneCode: "FedexGround",
        Description: "Ground Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 75 }],
      },
    ])

    const result = await service().calculatePrice(
      { service_code: "GROUND" } as any,
      forecastCart as any,
      {} as any
    )

    // mean 42 + p75 residual buffer 10 = 52; forecast short-circuits before Strapi
    expect(result.calculated_amount).toBe(52)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("respects GRILLERS_SHIPPING_FORECAST_SAFETY_PERCENTILE=p50 (no buffer)", async () => {
    Object.assign(process.env, forecastEnv, {
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: writeConstantForecastModel(42),
      GRILLERS_SHIPPING_FORECAST_SAFETY_PERCENTILE: "p50",
    })

    const result = await service().calculatePrice(
      { service_code: "GROUND" } as any,
      forecastCart as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(42)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("treats a degenerate $0 forecast as non-confident and falls through to the Strapi tier", async () => {
    Object.assign(process.env, forecastEnv, {
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: writeConstantForecastModel(0),
    })
    mockShippingZones([
      {
        ZoneCode: "FedexGround",
        Description: "Ground Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 75 }],
      },
    ])

    const result = await service().calculatePrice(
      { service_code: "GROUND" } as any,
      forecastCart as any,
      {} as any
    )

    // $0 point estimate => fall through to the conservative Strapi tier (75)
    expect(result.calculated_amount).toBe(75)
    expect(global.fetch).toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "shipping_forecast_fallthrough",
        title:
          "Shipping forecast outside confidence rails; checkout using WWEX/Strapi fallback",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        meta: expect.objectContaining({
          service_code: "GROUND",
          point_estimate: 0,
          fallback: "wwex_or_strapi",
          reason: "outside_confidence_rails",
        }),
      })
    )
  })

  it("does not crash and falls through to Strapi when the model file is corrupt", async () => {
    Object.assign(process.env, forecastEnv, {
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: writeCorruptForecastModel(),
    })
    mockShippingZones([
      {
        ZoneCode: "FedexGround",
        Description: "Ground Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 75 }],
      },
    ])

    // constructing the provider with a corrupt model must not throw (boot-safe)
    const svc = service()
    const result = await svc.calculatePrice(
      { service_code: "GROUND" } as any,
      forecastCart as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(75)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "shipping_forecast_model_unavailable",
        title:
          "Shipping forecast model unavailable; checkout using WWEX/Strapi fallback",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "page",
        meta: expect.objectContaining({
          fallback: "wwex_or_strapi",
          error_message: expect.stringContaining("Expected property name"),
        }),
      })
    )
  })

  it("applies a default max rail to the historical shipping forecast when env max is unset", async () => {
    Object.assign(process.env, forecastEnv, {
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: writeConstantForecastModel(300),
    })
    mockShippingZones([
      {
        ZoneCode: "FedexGround",
        Description: "Ground Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 75 }],
      },
    ])

    const result = await service().calculatePrice(
      { service_code: "GROUND" } as any,
      forecastCart as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(75)
    expect(global.fetch).toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "shipping_forecast_fallthrough",
        meta: expect.objectContaining({
          point_estimate: 300,
          max_usd: 250,
          reason: "outside_confidence_rails",
        }),
      })
    )
  })

  it("falls back to the conservative Overnight row for expedited UPS services without dedicated rows", async () => {
    mockShippingZones([
      {
        ZoneCode: "FedexGround",
        Description: "Ground Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 40 }],
      },
      {
        ZoneCode: "FedexOvernight",
        Description: "Overnight Estimated Shipping Charge",
        ShippingZoneBreakpoints: [{ BreakpointPrice: 0, ShippingRate: 160 }],
      },
    ])

    const result = await service().calculatePrice(
      { service_code: "2ND_DAY_AIR" } as any,
      {
        shipping_address: { postal_code: "90048" },
        items: [{ variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} }],
      } as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(160)
  })

  it("fails soft with a typed NOT_ALLOWED MedusaError when no Strapi shipping-zone tier matches", async () => {
    mockShippingZones([])

    const promise = service().calculatePrice(
      { service_code: "GROUND" } as any,
      {
        shipping_address: { postal_code: "30340" },
        items: [{ variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} }],
      } as any,
      {} as any
    )

    // Surfaces as a clean MedusaError (400 NOT_ALLOWED) rather than a raw 500.
    await expect(promise).rejects.toBeInstanceOf(MedusaError)
    await expect(promise).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    })
    await expect(promise).rejects.toThrow(
      /isn’t available for 30340\. Please choose a different shipping option\./
    )
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "shipping_rate_tier_missing",
        title: "Shipping rate tier missing for GROUND; checkout blocked",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        meta: expect.objectContaining({
          service_code: "GROUND",
          destination_postal_code: "30340",
          item_count: 1,
          eligible_subtotal: 100,
          zone_count: 0,
        }),
      })
    )
  })

  it("alerts and fails soft when the Strapi shipping-zone catalog is unavailable", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "maintenance" }),
    } as any)

    const promise = service().calculatePrice(
      { service_code: "GROUND" } as any,
      {
        shipping_address: { postal_code: "30340", province: "GA" },
        items: [{ variant_id: "variant_fixture", unit_price: 100, quantity: 1, metadata: {} }],
      } as any,
      {} as any
    )

    await expect(promise).rejects.toBeInstanceOf(MedusaError)
    await expect(promise).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    })
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "shipping_zone_catalog_unavailable",
        title: "Shipping zone catalog unavailable for GROUND",
        path: "src/modules/fulfillment/service.ts",
        source: "medusa",
        severity: "warn",
        meta: expect.objectContaining({
          service_code: "GROUND",
          destination_postal_code: "30340",
          destination_province: "GA",
          item_count: 1,
          response_status: 503,
          response_ok: false,
          has_data_array: false,
        }),
      })
    )
  })

  it("emits an ops alert if a shipping provider returns the legacy -10 sentinel", async () => {
    const svc = service()
    ;(svc as any).client.calculate = jest.fn(async () => -10)

    const result = await svc.calculatePrice(
      { service_code: "GROUND" } as any,
      {
        shipping_address: { postal_code: "30340" },
      } as any,
      {} as any
    )

    expect(result.calculated_amount).toBe(-10)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "shipping_calculate_price_sentinel",
        path: "src/modules/fulfillment/service.ts",
        meta: expect.objectContaining({
          service_code: "GROUND",
          postal_code: "30340",
        }),
      })
    )
  })
})
