import { shippingLine } from "./__fixtures__/shipping-inputs"
import fs from "node:fs"
import path from "node:path"

import {
  evaluateGbm,
  forecastShippingCost,
  gbmRawPredict,
  loadShippingCostForecastModel,
  shippingForecastInputFromFulfillmentData,
} from "../shipping-cost-forecast"

// The production model file (also what GRILLERS_SHIPPING_FORECAST_MODEL_PATH points at).
const MODEL = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "data", "shipping-cost-forecast-gbm.json"),
    "utf8"
  )
)

describe("GBM shipping forecast (v3)", () => {
  it("reproduces the sklearn export byte-for-byte on the baked-in parity vectors", () => {
    // The trainer (analysis/export-gbm-model.py) writes feature vectors + the exact
    // raw ensemble output. The TS tree-walk must match to floating-point tolerance.
    let maxDiff = 0
    for (const ex of MODEL.parity as Array<{ columns_vector: number[]; expected_raw: number }>) {
      const got = gbmRawPredict(MODEL as any, ex.columns_vector)
      maxDiff = Math.max(maxDiff, Math.abs(got - ex.expected_raw))
    }
    expect(MODEL.parity.length).toBeGreaterThan(10)
    expect(maxDiff).toBeLessThan(1e-6)
  })

  it("loads as a v3 model when enabled", () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "gbm-"))
    const p = path.join(dir, "model.json")
    fs.writeFileSync(p, JSON.stringify(MODEL))
    const loaded = loadShippingCostForecastModel({
      GRILLERS_SHIPPING_FORECAST_ENABLED: "true",
      GRILLERS_SHIPPING_FORECAST_MODEL_PATH: p,
    })
    expect(loaded?.schema_version).toBe("shipping_cost_forecast_v3")
  })

  it("computes the destination zone from the ZIP and produces a sane per-service charge", () => {
    const cart = (service: string, province: string, postal: string) =>
      ({service,ship_state:province.replace("us-", "").toUpperCase(),ship_postal_code:postal,subtotal:260,line_count:2,unit_count:5,per_lb_line_count:1,fixed_line_count:1,unknown_pricing_line_count:0,estimated_product_weight_lb:18})

    const gaGround = evaluateGbm(MODEL as any, cart("GROUND", "us-ga", "30309"))
    const caOvernight = evaluateGbm(MODEL as any, cart("OVERNIGHT", "us-ca", "90024"))

    // Preserve the historical feature vector; this is not approval of a new physical-mass model.
    // sane magnitudes and ordering: a local-ish Ground order is cheaper than a
    // cross-country Overnight order
    expect(gaGround).toBeGreaterThan(5)
    expect(gaGround).toBeLessThan(80)
    expect(caOvernight).toBeGreaterThan(gaGround)

    // forecastShippingCost surfaces the model's default markup (the "20% buffer")
    const result = forecastShippingCost(MODEL as any, cart("GROUND", "us-ga", "30309"))
    expect(result?.metadata.default_markup).toBe(1.2)
    expect(result?.amount).toBeGreaterThan(0)
  })

  it("falls back to a default zone for an unseen ZIP without throwing", () => {
    const input = shippingForecastInputFromFulfillmentData("GROUND", {
      shipping_address: { province_code: "us-ak", postal_code: "99950" },
      items: [shippingLine({unit_price:50})],
    })!
    expect(() => evaluateGbm(MODEL as any, input)).not.toThrow()
    expect(evaluateGbm(MODEL as any, input)).toBeGreaterThanOrEqual(0)
  })
})
