import fs from "node:fs"
import { PHYSICAL_WEIGHT_CONTRACT, resolveShippingWeights, type ResolvedShippingWeights, type ShippingLine } from "./shipping-weights"

type LineItemLike = {
  unit_price?: number | null
  quantity?: number | null
  subtotal?: number | null
  total?: number | null
  metadata?: Record<string, unknown> | null
  variant?: {
    metadata?: Record<string, unknown> | null
    product?: { metadata?: Record<string, unknown> | null } | null
  } | null
  product?: { metadata?: Record<string, unknown> | null } | null
}

const SCHEMA_VERSION = "shipping_cost_forecast_v2" as const // linear (ridge) model
const GBM_SCHEMA = "shipping_cost_forecast_v3" as const // gradient-boosted tree model

type CommonFallbacks = {
  global_median?: number
  by_service?: Record<string, number>
  by_state?: Record<string, number>
  by_service_state?: Record<string, number>
  residual_abs_p50?: number
  residual_abs_p75?: number
  residual_abs_p90?: number
}

// v2: ridge regression on log1p(cost) with Duan smearing.
type LinearForecastModel = {
  weight_input_contract?: string
  status: "trained"
  schema_version: typeof SCHEMA_VERSION
  generated_at?: string
  smearing_factor?: number
  features: {
    columns: string[]
    numeric_stats: Record<string, { mean: number; std: number }>
    categorical?: Record<string, string[]>
  }
  coefficients: Record<string, number>
  fallbacks?: CommonFallbacks
}

// v3: HistGradientBoosting ensemble exported from sklearn (analysis/export-gbm-model.py).
// Predicts the MEAN cost directly; the charge applies a markup (default 1.20).
type GbmColumn =
  | { kind: "num"; name: string }
  | { kind: "zone" }
  | { kind: "cat"; feature: string; level: string }
type GbmNode = { f: number; t: number; l: number; r: number; leaf: boolean; v: number; ml: boolean }
type GbmForecastModel = {
  weight_input_contract?: string
  status: "trained"
  schema_version: typeof GBM_SCHEMA
  model_type: "hist_gbm"
  generated_at?: string
  default_markup?: number
  baseline: number
  columns: GbmColumn[]
  service_levels: string[]
  zip3_zone: Record<string, number>
  state_zone: Record<string, number>
  default_zone: number
  trees: GbmNode[][]
  fallbacks?: CommonFallbacks
}

type ShippingCostForecastModel = LinearForecastModel | GbmForecastModel

function isGbmModel(model: ShippingCostForecastModel): model is GbmForecastModel {
  return (model as GbmForecastModel).schema_version === GBM_SCHEMA
}

export type ShippingCostForecastInput = {
  weight_input_contract?: string
  service: string
  ship_state?: string | null
  ship_postal_code?: string | null
  subtotal: number
  line_count: number
  unit_count: number
  fixed_line_count: number
  per_lb_line_count: number
  unknown_pricing_line_count: number
  estimated_product_weight_lb: number
  month?: string | null
}

export type ShippingCostForecastResult = {
  amount: number
  confidence: {
    low: number
    high: number
    residual_p75: number
    residual_p90: number
  }
  metadata: {
    model_generated_at?: string
    model_schema_version: string
    default_markup?: number
    service: string
    ship_state: string
  }
}

type EnvLike = Record<string, string | undefined>

function envFlag(env: EnvLike, key: string, fallback = false): boolean {
  const value = env[key]
  if (value == null || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const parsed = Number.parseFloat(String(value ?? "0").replace(/[$,]/g, ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function normalizeService(value: unknown): string {
  const text = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_")
  if (!text) return "UNKNOWN"
  if (text.includes("GROUND") || text === "GND") return "GROUND"
  if (text.includes("3_DAY") || text.includes("3DS") || text.includes("THIRD")) {
    return "3_DAY_SELECT"
  }
  if (text.includes("2ND") || text.includes("2DA") || text.includes("SECOND")) {
    return "2ND_DAY_AIR"
  }
  if (
    text.includes("OVERNIGHT") ||
    text.includes("NEXT_DAY") ||
    text.includes("1DA") ||
    text.includes("1DP") ||
    text.includes("1DM")
  ) {
    return "OVERNIGHT"
  }
  if (text.includes("UPS") || text.includes("SHIP")) return "UPS_UNKNOWN"
  return text
}

// MUST stay byte-identical to the trainer's normalizeStateCode in
// analysis/shipping-cost-forecast-model.mjs, or ship_state one-hot levels learned
// at train time never match what checkout emits (Medusa carries ISO "us-ga").
const US_STATE_BY_NAME: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
  COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL",
  INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA",
  MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN",
  MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
  OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
  VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI",
  WYOMING: "WY", "PUERTO RICO": "PR",
}

function normalizeState(value: unknown): string {
  let text = String(value == null ? "" : value)
    .trim()
    .toUpperCase()
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
  if (!text) return "UNKNOWN"
  text = text.replace(/^US[-\s]+/, "")
  if (/^[A-Z]{2}$/.test(text)) return text
  if (US_STATE_BY_NAME[text]) return US_STATE_BY_NAME[text]
  return text
}

function currentMonth(): string {
  return String(new Date().getUTCMonth() + 1).padStart(2, "0")
}

function lineSubtotal(item: LineItemLike): number {
  const direct = item.subtotal ?? item.total
  if (typeof direct === "number" && Number.isFinite(direct)) return Math.max(0, direct)
  const unit = typeof item.unit_price === "number" ? item.unit_price : 0
  const quantity = typeof item.quantity === "number" ? item.quantity : 0
  return Math.max(0, unit * quantity)
}

function metadataValue(item: LineItemLike, names: string[]): unknown {
  const sources = [
    item.metadata,
    item.variant?.metadata,
    item.variant?.product?.metadata,
    item.product?.metadata,
  ].filter(Boolean) as Record<string, unknown>[]
  for (const source of sources) {
    for (const name of names) {
      if (source[name] != null) return source[name]
    }
  }
  return null
}

function pricingMode(item: LineItemLike): "fixed" | "per_lb" | "unknown" {
  const value = String(
    metadataValue(item, [
      "pricing_mode",
      "price_mode",
      "priceMode",
      "price_type",
      "PriceType",
      "unit_of_measure",
      "uom",
      "UoM",
    ]) || ""
  ).toLowerCase()
  if (value.includes("pack") || value.includes("fixed")) return "fixed"
  if (value.includes("lb") || value.includes("pound") || value.includes("variable")) {
    return "per_lb"
  }
  return "unknown"
}

export function shippingForecastInputFromFulfillmentData(
  serviceCode: unknown,
  data: Record<string, any>,
  options: { persistedOrder?: boolean; resolvedWeights?: ResolvedShippingWeights } = {}
): ShippingCostForecastInput | null {
  const items: LineItemLike[] = Array.isArray(data.items) ? data.items : []
  if (!items.length) return null

  const subtotal = items.reduce((sum, item) => sum + lineSubtotal(item), 0)
  const unitCount = items.reduce((sum, item) => sum + (toNumber(item.quantity) || 1), 0)
  const pricingCounts = items.reduce(
    (counts, item) => {
      counts[pricingMode(item)] += 1
      return counts
    },
    { fixed: 0, per_lb: 0, unknown: 0 }
  )
  const weights = options.resolvedWeights ?? resolveShippingWeights(items as ShippingLine[], options)
  const shippingAddress = data.shipping_address || {}
  return {
    service: normalizeService(serviceCode || data.service_code),
    // Medusa carries the 2-letter region in province_code (ISO "us-ga"); fall back
    // to province/state for other shapes. normalizeState canonicalizes all to "GA".
    ship_state: normalizeState(
      shippingAddress.province_code ||
        shippingAddress.province ||
        shippingAddress.state
    ),
    ship_postal_code: String(
      shippingAddress.postal_code || shippingAddress.zip || shippingAddress.postalCode || ""
    ),
    subtotal,
    line_count: items.length,
    unit_count: unitCount,
    fixed_line_count: pricingCounts.fixed,
    per_lb_line_count: pricingCounts.per_lb,
    unknown_pricing_line_count: pricingCounts.unknown,
    estimated_product_weight_lb: weights.physicalWeightLb,
    weight_input_contract: PHYSICAL_WEIGHT_CONTRACT,
    month: String((data.as_of_month as string) || currentMonth()),
  }
}

function featureValue(input: ShippingCostForecastInput, feature: string): number {
  const estimatedWeight = toNumber(input.estimated_product_weight_lb)
  const unitCount = toNumber(input.unit_count)
  switch (feature) {
    case "subtotal":
      return toNumber(input.subtotal)
    case "log_subtotal":
      return Math.log1p(toNumber(input.subtotal))
    case "line_count":
      return toNumber(input.line_count)
    case "unit_count":
      return unitCount
    case "fixed_line_count":
      return toNumber(input.fixed_line_count)
    case "per_lb_line_count":
      return toNumber(input.per_lb_line_count)
    case "unknown_pricing_line_count":
      return toNumber(input.unknown_pricing_line_count)
    case "estimated_product_weight_lb":
      return estimatedWeight
    case "estimated_weight_per_unit":
      return unitCount ? estimatedWeight / unitCount : 0
    default:
      return 0
  }
}

function columnValue(column: string, input: ShippingCostForecastInput, model: LinearForecastModel) {
  if (column === "__intercept") return 1
  if (column.startsWith("num:")) {
    const feature = column.slice("num:".length)
    const stats = model.features.numeric_stats[feature] || { mean: 0, std: 1 }
    const std = stats.std || 1
    return (featureValue(input, feature) - stats.mean) / std
  }
  if (column.startsWith("cat:")) {
    const [feature, expected] = column.slice("cat:".length).split("=")
    const actual =
      feature === "service"
        ? normalizeService(input.service)
        : feature === "ship_state"
          ? normalizeState(input.ship_state)
          : feature === "month"
            ? String(input.month || currentMonth()).padStart(2, "0")
            : String((input as any)[feature] || "unknown")
    return actual === expected ? 1 : 0
  }
  return 0
}

// ---- v3 gradient-boosted tree evaluation ----

// UPS zone from the destination ZIP (known at checkout). Falls back to a state-level
// zone, then a default. Baked-in lookups come from the training data.
function gbmZone(model: GbmForecastModel, input: ShippingCostForecastInput): number {
  const zip = String(input.ship_postal_code || "").replace(/[^0-9]/g, "")
  const z3 = zip.slice(0, 3)
  if (z3 && model.zip3_zone[z3] != null) return model.zip3_zone[z3]
  const st = normalizeState(input.ship_state)
  if (model.state_zone[st] != null) return model.state_zone[st]
  return toNumber(model.default_zone)
}

function gbmFeatureValue(col: GbmColumn, input: ShippingCostForecastInput, zone: number): number {
  // Defensive: a malformed/partially-uploaded model column (undefined/null or a
  // column missing `kind`) must never throw `reading 'kind'` — a forecast error
  // would crash the whole rate calculation / break the order.placed subscribers.
  // Fail soft to a neutral 0 contribution for any unrecognized column.
  if (!col || typeof col !== "object") return 0
  if (col.kind === "zone") return zone
  if (col.kind === "cat") {
    if (col.feature === "service") return normalizeService(input.service) === col.level ? 1 : 0
    return String((input as any)[col.feature] ?? "") === col.level ? 1 : 0
  }
  switch (col.name) {
    case "subtotal": return toNumber(input.subtotal)
    case "line_count": return toNumber(input.line_count)
    case "unit_count": return toNumber(input.unit_count)
    case "fixed_line_count": return toNumber(input.fixed_line_count)
    case "per_lb_line_count": return toNumber(input.per_lb_line_count)
    case "unknown_pricing_line_count": return toNumber(input.unknown_pricing_line_count)
    case "est_weight": return toNumber(input.estimated_product_weight_lb)
    default: return 0
  }
}

// Walks one tree. Mirrors sklearn HistGradientBoosting: go left when x <= threshold,
// route missing per missing_go_to_left. Verified to match sklearn to 1e-13.
function walkTree(tree: GbmNode[], vec: number[]): number {
  let i = 0
  for (let steps = 0; steps <= tree.length; steps += 1) {
    const n = tree[i]
    if (!n) return 0
    if (n.leaf) return n.v
    const xi = vec[n.f]
    i = xi == null || Number.isNaN(xi) ? (n.ml ? n.l : n.r) : xi <= n.t ? n.l : n.r
  }
  return 0
}

// Raw ensemble output for a prebuilt feature vector (baseline + sum of trees), no
// flooring. Exposed so tests can verify byte-for-byte parity with the sklearn export.
export function gbmRawPredict(model: GbmForecastModel, vec: number[]): number {
  let sum = toNumber(model.baseline)
  for (const tree of model.trees) sum += walkTree(tree, vec)
  return sum
}

export function evaluateGbm(model: GbmForecastModel, input: ShippingCostForecastInput): number {
  const zone = gbmZone(model, input)
  const vec = model.columns.map((c) => gbmFeatureValue(c, input, zone))
  return Math.max(0, gbmRawPredict(model, vec))
}

function buildResult(
  model: ShippingCostForecastModel,
  input: ShippingCostForecastInput,
  predicted: number,
  defaultMarkup: number
): ShippingCostForecastResult {
  const residualP75 = toNumber(model.fallbacks?.residual_abs_p75) || 25
  const residualP90 = toNumber(model.fallbacks?.residual_abs_p90) || residualP75 * 1.5
  return {
    amount: roundMoney(predicted),
    confidence: {
      low: roundMoney(Math.max(0, predicted - residualP75)),
      high: roundMoney(predicted + residualP75),
      residual_p75: roundMoney(residualP75),
      residual_p90: roundMoney(residualP90),
    },
    metadata: {
      model_generated_at: model.generated_at,
      model_schema_version: model.schema_version,
      default_markup: defaultMarkup,
      service: normalizeService(input.service),
      ship_state: normalizeState(input.ship_state),
    },
  }
}

export function forecastShippingCost(
  model: ShippingCostForecastModel,
  input: ShippingCostForecastInput
): ShippingCostForecastResult | null {
  if (!model || model.status !== "trained") return null
  // Historical v2/v3 training derived weight from invoice quantity/rate/copy.
  // New reviewed physical or SAM proxy inputs are not that same feature contract.
  // A model needs an explicitly validated contract before consuming the new input.
  if (input.weight_input_contract && model.weight_input_contract !== input.weight_input_contract) return null

  if (isGbmModel(model)) {
    const predicted = evaluateGbm(model, input) // mean cost; the markup buffer is applied at charge time
    const markup = toNumber(model.default_markup) || 1
    return buildResult(model, input, predicted, markup)
  }

  if (model.schema_version !== SCHEMA_VERSION) return null
  const logPrediction = model.features.columns.reduce(
    (sum, column) => sum + columnValue(column, input, model) * toNumber(model.coefficients[column]),
    0
  )
  // Retransformation with Duan smearing (mirrors the trainer's predictWithCoefficients):
  // exp(dot) * smearing - 1 targets the conditional MEAN cost, not the median.
  const rawSmearing = toNumber(model.smearing_factor)
  const smearing = Number.isFinite(rawSmearing) && rawSmearing > 0 ? rawSmearing : 1
  const predicted = Math.max(0, Math.exp(logPrediction) * smearing - 1)
  // Linear model carries no markup (cushion comes from the additive percentile buffer).
  return buildResult(model, input, predicted, 1)
}

export type ForecastModelLoadResult = {
  model: ShippingCostForecastModel | null
  path: string | null
  error?: string
}

/**
 * Boot-safe loader. NEVER throws: a missing/corrupt/partially-uploaded model file
 * returns { model: null, error } so the caller fails open to WWEX/Strapi instead
 * of crashing the fulfillment provider at construction time (would take down ALL
 * rate calculation, not just the forecast).
 */
export function loadShippingCostForecastModelResult(
  env: EnvLike = process.env
): ForecastModelLoadResult {
  if (!envFlag(env, "GRILLERS_SHIPPING_FORECAST_ENABLED", false)) {
    return { model: null, path: null }
  }
  const modelPath = env.GRILLERS_SHIPPING_FORECAST_MODEL_PATH
  if (!modelPath) return { model: null, path: null }
  try {
    const model = JSON.parse(fs.readFileSync(modelPath, "utf8")) as ShippingCostForecastModel
    if (
      model.status !== "trained" ||
      (model.schema_version !== SCHEMA_VERSION && model.schema_version !== GBM_SCHEMA)
    ) {
      return {
        model: null,
        path: modelPath,
        error: `model is not a trained ${SCHEMA_VERSION}/${GBM_SCHEMA} artifact`,
      }
    }
    return { model, path: modelPath }
  } catch (error) {
    return {
      model: null,
      path: modelPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function loadShippingCostForecastModel(
  env: EnvLike = process.env
): ShippingCostForecastModel | null {
  return loadShippingCostForecastModelResult(env).model
}

export function forecastModelFileMtimeMs(modelPath: string | null | undefined): number | null {
  if (!modelPath) return null
  try {
    return fs.statSync(modelPath).mtimeMs
  } catch {
    return null
  }
}
