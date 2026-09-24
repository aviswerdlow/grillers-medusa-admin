import type { ShippingWeightRecord } from "../../shipping-weights";
import { SHIPPING_WEIGHT_KEY } from "../../shipping-weights";
import { resolvePackagingConfig } from "../../packaging-cost";

// Entirely synthetic. These are not Peter's approved masses or packing rules.
export function weightRecord(
  overrides: Partial<ShippingWeightRecord> = {},
): ShippingWeightRecord {
  return {
    version: 1,
    qbd_list_id: "fixture-list-id",
    kind: "physical",
    physical_weight: 1.5,
    physical_unit: "lb",
    physical_basis: "per_sellable_unit",
    units_per_sellable: 1,
    fit_units: 6,
    fit_rule_id: "fixture-fit-v1",
    raw_sam_value: "6.00",
    raw_sam_unit: "lb",
    raw_sam_meaning: "space_proxy",
    source_item_id: "fixture-item",
    source_revision: "fixture-revision",
    source_captured_at: "2026-09-19T00:00:00Z",
    review_status: "approved",
    approved_by: "synthetic-fixture",
    approved_at: "2026-09-19T01:00:00Z",
    ...overrides,
  };
}
export function shippingLine(overrides: Record<string, any> = {}) {
  return {
    id: "line_fixture",
    variant_id: "variant_fixture",
    unit_price: 10,
    quantity: 1,
    metadata: { pricing_mode: "fixed" },
    variant: {
      id: "variant_fixture",
      sku: "fixture-sku",
      metadata: {
        qbd_list_id: "fixture-list-id",
        [SHIPPING_WEIGHT_KEY]: weightRecord(),
      },
    },
    ...overrides,
  };
}
export const packingConfig = () =>
  resolvePackagingConfig({
    env: {},
    strapi: {
      model: "continuous_weight",
      policyVersion: "fixture-packing-v1",
      dryIceUsdPerLb: 1,
      minimumDryIceAmountLb: 2,
      transitDayThresholds: [
        { transitDays: 1, dryIceMultiplier: 1 },
        { transitDays: 2, dryIceMultiplier: 2 },
        { transitDays: 3, dryIceMultiplier: 3 },
      ],
      packagingBoxes: [
        {
          boxTier: "m330",
          name: "Synthetic box",
          unitCost: 10,
          maxProductWeightLb: 30,
          maxTransitDays: 3,
          maxTotalWeightLb: 50,
          tareWeightLb: 1,
          lengthIn: 10,
          widthIn: 11,
          heightIn: 12,
          maxFitUnits: 10,
          fitRuleId: "fixture-fit-v1",
        },
        {
          boxTier: "l345",
          name: "Synthetic fallback",
          unitCost: 100,
          maxProductWeightLb: null,
          maxTransitDays: null,
          maxTotalWeightLb: 50,
          tareWeightLb: 1,
          lengthIn: 10,
          widthIn: 11,
          heightIn: 12,
          maxFitUnits: 10,
          fitRuleId: "fixture-fit-v1",
        },
      ],
    },
  });
