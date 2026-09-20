import { shippingLine, weightRecord } from "./__fixtures__/shipping-inputs"
import { SHIPPING_WEIGHT_KEY } from "../shipping-weights"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  forecastShippingCost,
  loadShippingCostForecastModel,
  loadShippingCostForecastModelResult,
  shippingForecastInputFromFulfillmentData,
} from "../shipping-cost-forecast"

const constantModel = {
  status: "trained",
  schema_version: "shipping_cost_forecast_v2",
  generated_at: "2026-06-16T00:00:00.000Z",
  smearing_factor: 1,
  features: {
    columns: ["__intercept"],
    numeric_stats: {},
  },
  coefficients: {
    __intercept: Math.log1p(42),
  },
  fallbacks: {
    residual_abs_p75: 12,
    residual_abs_p90: 25,
  },
} as const

describe("shipping cost forecast", () => {
  it("extracts checkout-safe order features from fulfillment data", () => {
    const input = shippingForecastInputFromFulfillmentData("GROUND", {
      shipping_address: { province: "va" },
      items: [
        {
          ...shippingLine({variant:{id:"variant_fixture",metadata:{qbd_list_id:"fixture-list-id",[SHIPPING_WEIGHT_KEY]:weightRecord({physical_weight:1.1})}}}),
          unit_price: 12,
          quantity: 2,
          metadata: { pricing_mode: "per lb", estimated_weight_lb: 1.1 },
        },
        {
          ...shippingLine({variant:{id:"variant_fixture",metadata:{qbd_list_id:"fixture-list-id",[SHIPPING_WEIGHT_KEY]:weightRecord({physical_weight:16,physical_unit:"oz"})}}}),
          unit_price: 18,
          quantity: 1,
          metadata: { pricing_mode: "per pack", estimated_weight_oz: 16 },
        },
      ],
    })

    expect(input).toMatchObject({
      service: "GROUND",
      ship_state: "VA",
      subtotal: 42,
      line_count: 2,
      unit_count: 3,
      per_lb_line_count: 1,
      fixed_line_count: 1,
      estimated_product_weight_lb: 3.2,
    })
    // post-shipment facts must NOT be present (they are zeroed at checkout and were
    // the source of the train/serve undercharge bug)
    expect(input).not.toHaveProperty("reported_weight_lb")
    expect(input).not.toHaveProperty("shipment_count")
  })

  it("canonicalizes ship_state identically to the trainer (Medusa ISO province, full names, blank)", () => {
    // Parity with analysis/shipping-cost-forecast-model.mjs normalizeStateCode — if
    // these diverge, the ship_state one-hot silently misses on every live order.
    const state = (address: Record<string, any>) =>
      shippingForecastInputFromFulfillmentData("GROUND", {
        shipping_address: address,
        items: [shippingLine()],
      })?.ship_state

    expect(state({ province_code: "us-ga" })).toBe("GA")
    expect(state({ province: "ga" })).toBe("GA")
    expect(state({ province: "Georgia" })).toBe("GA")
    expect(state({ province: "US-GA" })).toBe("GA")
    expect(state({ province: "New York" })).toBe("NY")
    expect(state({})).toBe("UNKNOWN")
    // province_code (Medusa's 2-letter) wins over a stale province field
    expect(state({ province_code: "us-tx", province: "Georgia" })).toBe("TX")
  })

  it("predicts amount and confidence range from a trained model", () => {
    const result = forecastShippingCost(constantModel as any, {
      service: "Ground",
      ship_state: "VA",
      subtotal: 120,
      line_count: 3,
      unit_count: 5,
      fixed_line_count: 1,
      per_lb_line_count: 2,
      unknown_pricing_line_count: 0,
      estimated_product_weight_lb: 12,
      month: "06",
    })

    expect(result?.amount).toBe(42)
    expect(result?.confidence.low).toBe(30)
    expect(result?.confidence.high).toBe(54)
    expect(result?.metadata.service).toBe("GROUND")
  })

  it("applies the Duan smearing factor to correct retransformation bias", () => {
    // exp(log1p(42)) * smearing - 1 = 43 * 2 - 1 = 85
    const result = forecastShippingCost(
      { ...constantModel, smearing_factor: 2 } as any,
      {
        service: "Ground",
        ship_state: "VA",
        subtotal: 120,
        line_count: 3,
        unit_count: 5,
        fixed_line_count: 1,
        per_lb_line_count: 2,
        unknown_pricing_line_count: 0,
        estimated_product_weight_lb: 12,
      }
    )
    expect(result?.amount).toBe(85)
  })

  it("rejects a stale v1 model (schema mismatch)", () => {
    const result = forecastShippingCost(
      { ...constantModel, schema_version: "shipping_cost_forecast_v1" } as any,
      {
        service: "Ground",
        ship_state: "VA",
        subtotal: 120,
        line_count: 3,
        unit_count: 5,
        fixed_line_count: 1,
        per_lb_line_count: 2,
        unknown_pricing_line_count: 0,
        estimated_product_weight_lb: 12,
      }
    )
    expect(result).toBeNull()
  })

  it("loads a v2 model only when explicitly enabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipping-forecast-model-"))
    const modelPath = path.join(dir, "model.json")
    fs.writeFileSync(modelPath, JSON.stringify(constantModel))

    expect(
      loadShippingCostForecastModel({
        GRILLERS_SHIPPING_FORECAST_MODEL_PATH: modelPath,
      })
    ).toBeNull()

    expect(
      loadShippingCostForecastModel({
        GRILLERS_SHIPPING_FORECAST_ENABLED: "true",
        GRILLERS_SHIPPING_FORECAST_MODEL_PATH: modelPath,
      })?.schema_version
    ).toBe("shipping_cost_forecast_v2")
  })

  it("never throws on a corrupt or missing model file (fails open)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipping-forecast-corrupt-"))
    const corruptPath = path.join(dir, "model.json")
    fs.writeFileSync(corruptPath, "{ this is not valid json")

    expect(() =>
      loadShippingCostForecastModel({
        GRILLERS_SHIPPING_FORECAST_ENABLED: "true",
        GRILLERS_SHIPPING_FORECAST_MODEL_PATH: corruptPath,
      })
    ).not.toThrow()

    const corrupt = loadShippingCostForecastModelResult({
      GRILLERS_SHIPPING_FORECAST_ENABLED: "true",
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: corruptPath,
    })
    expect(corrupt.model).toBeNull()
    expect(corrupt.error).toBeTruthy()

    const missing = loadShippingCostForecastModelResult({
      GRILLERS_SHIPPING_FORECAST_ENABLED: "true",
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: path.join(dir, "does-not-exist.json"),
    })
    expect(missing.model).toBeNull()
    expect(missing.error).toBeTruthy()
  })
})
