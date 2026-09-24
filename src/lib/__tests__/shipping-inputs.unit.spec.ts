import {
  weightRecord,
  shippingLine,
  packingConfig,
} from "./__fixtures__/shipping-inputs";
import {
  resolveShippingLine,
  resolveShippingWeights,
  SHIPPING_WEIGHT_KEY,
  SHIPPING_WEIGHT_SNAPSHOT_KEY,
  shippingWeightSnapshots,
  PHYSICAL_WEIGHT_CONTRACT,
  ShippingInputError,
} from "../shipping-weights";
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
} from "../shipping-packing-plan";
import { loadShippingCatalogLines } from "../shipping-catalog-inputs";
import { publicShippingProjection } from "../../api/middlewares/shipping-inputs";
import {
  shippingForecastInputFromFulfillmentData,
  forecastShippingCost,
} from "../shipping-cost-forecast";

const context = {
  service: "GROUND",
  postalCode: "30340",
  validatedTransit: { days: 1, revision: "fixture-calendar-v1" },
};
const withRecord = (record: any) =>
  shippingLine({
    variant: {
      id: "variant_fixture",
      metadata: {
        qbd_list_id: "fixture-list-id",
        [SHIPPING_WEIGHT_KEY]: record,
      },
    },
  });
describe("reviewed physical weights and box space", () => {
  test("raw SAM proxy never becomes physical mass or a pricing input", () => {
    const line = shippingLine({ quantity: 3 });
    const result = resolveShippingLine(line);
    expect(result).toMatchObject({ physicalWeightLb: 4.5, fitUnits: 18 });
    expect(line.unit_price).toBe(10);
    expect(result.record.raw_sam_value).toBe("6.00");
  });
  test("converts ounces, inner units and sellable quantity exactly once", () => {
    const line = withRecord(
      weightRecord({
        physical_weight: 8,
        physical_unit: "oz",
        physical_basis: "per_inner_unit",
        units_per_sellable: 5,
      }),
    );
    line.quantity = 2;
    expect(resolveShippingLine(line)).toMatchObject({
      physicalWeightLb: 5,
      fitUnits: 12,
    });
    expect(
      resolveShippingLine(
        withRecord(weightRecord({ physical_weight: 5, units_per_sellable: 1 })),
      ),
    ).toMatchObject({ physicalWeightLb: 5 });
  });
  test.each([null, 0, -1, "", true, "n/a", Infinity])(
    "rejects invalid physical mass %p",
    (mass) => {
      expect(() =>
        resolveShippingLine(
          withRecord(weightRecord({ physical_weight: mass as any })),
        ),
      ).toThrow(ShippingInputError);
    },
  );
  test.each([
    { physical_unit: "kg" },
    { physical_basis: "line_total" },
    { units_per_sellable: 5 },
    { review_status: "pending" },
    { approved_by: null },
    { fit_rule_id: null },
    { source_revision: "" },
    { qbd_list_id: "wrong" },
  ])("rejects ambiguous or unreviewed fields %p", (override) => {
    expect(() =>
      resolveShippingLine(withRecord(weightRecord(override as any))),
    ).toThrow(ShippingInputError);
  });
  test("ignores forged cart snapshots and never falls through a malformed variant override", () => {
    const line = shippingLine({
      metadata: {
        [SHIPPING_WEIGHT_SNAPSHOT_KEY]: {
          record: weightRecord({ physical_weight: 100 }),
        },
      },
    });
    expect(resolveShippingLine(line).physicalWeightLb).toBe(1.5);
    line.variant.metadata[SHIPPING_WEIGHT_KEY] = null as any;
    (line as any).product = {
      metadata: {
        qbd_list_id: "fixture-list-id",
        [SHIPPING_WEIGHT_KEY]: weightRecord(),
      },
    };
    expect(() => resolveShippingLine(line)).toThrow(ShippingInputError);
  });
  test("persisted order keeps its snapshot after catalog weight/lifecycle changes", () => {
    const line = shippingLine({ quantity: 2 });
    line.metadata = shippingWeightSnapshots([line], "2026-09-19T02:00:00Z")[0]
      .metadata as any;
    line.variant.metadata[SHIPPING_WEIGHT_KEY] = weightRecord({
      physical_weight: 99,
    });
    (line.variant.metadata as any).availability_lifecycle = "internal_only";
    expect(
      resolveShippingLine(line, { persistedOrder: true }).physicalWeightLb,
    ).toBe(3);
    expect(() =>
      resolveShippingLine({ ...line, quantity: 3 }, { persistedOrder: true }),
    ).toThrow(ShippingInputError);
  });
  test("uses product fallback only when a variant record is absent", () => {
    const line = shippingLine({
      variant: {
        id: "variant_fixture",
        metadata: {},
        product: {
          metadata: {
            qbd_list_id: "fixture-list-id",
            [SHIPPING_WEIGHT_KEY]: weightRecord(),
          },
        },
      },
    });
    expect(resolveShippingLine(line)).toMatchObject({
      source: "product",
      physicalWeightLb: 1.5,
    });
  });
  test("excludes explicitly reviewed nonphysical items and rejects internal merchandise", () => {
    const record = weightRecord({
      kind: "nonphysical",
      physical_weight: null,
      physical_unit: null,
      physical_basis: null,
      units_per_sellable: null,
      fit_units: null,
      fit_rule_id: null,
    });
    expect(resolveShippingWeights([withRecord(record)]).physicalWeightLb).toBe(
      0,
    );
    expect(() =>
      resolveShippingLine(
        shippingLine({
          variant: { sku: "RM-secret", id: "variant_fixture", metadata: {} },
        }),
      ),
    ).toThrow(ShippingInputError);
  });
  test("volume forces more whole-unit boxes without fabricating food mass", () => {
    const pie = shippingLine({ quantity: 3 });
    const roomy = withRecord(weightRecord({ fit_units: 1 }));
    roomy.quantity = 3;
    const small = createShippingPackingPlan([pie], context, packingConfig());
    const compact = createShippingPackingPlan(
      [roomy],
      context,
      packingConfig(),
    );
    expect(small.boxes).toBe(3);
    expect(compact.boxes).toBe(1);
    expect(small.weights.physicalWeightLb).toBe(
      compact.weights.physicalWeightLb,
    );
    for (const p of small.packages)
      expect(p).toMatchObject({
        productWeightLb: 1.5,
        dryIceLb: 2,
        tareLb: 1,
        grossWeightLb: 4.5,
        contents: [{ variantId: "variant_fixture", quantity: 1 }],
      });
    expect(small.packages.reduce((sum, p) => sum + p.productWeightLb, 0)).toBe(
      4.5,
    );
  });
  test("mixed products satisfy both gross and fit limits with explicit dimensions", () => {
    const beef = withRecord(
      weightRecord({ physical_weight: 20, fit_units: 2 }),
    );
    beef.variant_id = "variant_beef";
    beef.variant.id = "variant_beef";
    const plan = createShippingPackingPlan(
      [shippingLine(), beef],
      context,
      packingConfig(),
    );
    expect(plan.boxes).toBe(1);
    expect(plan.packages[0]).toMatchObject({
      grossWeightLb: 24.5,
      fitUnits: 8,
      lengthIn: 10,
      widthIn: 11,
      heightIn: 12,
    });
  });
  test("missing policy, incompatible fit rule or oversized indivisible unit is unavailable", () => {
    const config = packingConfig();
    delete config.policyVersion;
    expect(() =>
      createShippingPackingPlan([shippingLine()], context, config),
    ).toThrow(ShippingInputError);
    expect(() =>
      createShippingPackingPlan(
        [withRecord(weightRecord({ fit_rule_id: "other" }))],
        context,
        packingConfig(),
      ),
    ).toThrow(ShippingInputError);
    expect(() =>
      createShippingPackingPlan(
        [withRecord(weightRecord({ physical_weight: 100 }))],
        context,
        packingConfig(),
      ),
    ).toThrow(ShippingInputError);
  });
  test("forecast shares physical mass and refuses a model with unvalidated feature semantics", () => {
    const line = shippingLine(),
      plan = createShippingPackingPlan([line], context, packingConfig());
    const input = shippingForecastInputFromFulfillmentData(
      "GROUND",
      { items: [line] },
      { resolvedWeights: plan.weights },
    )!;
    expect(input).toMatchObject({
      estimated_product_weight_lb: 1.5,
      weight_input_contract: PHYSICAL_WEIGHT_CONTRACT,
    });
    const model: any = {
      status: "trained",
      schema_version: "shipping_cost_forecast_v2",
      features: { columns: ["__intercept"], numeric_stats: {} },
      coefficients: { __intercept: Math.log1p(42) },
      smearing_factor: 1,
      fallbacks: { residual_abs_p75: 1, residual_abs_p90: 2 },
    };
    expect(forecastShippingCost(model, input)).toBeNull();
    expect(
      forecastShippingCost(
        { ...model, weight_input_contract: PHYSICAL_WEIGHT_CONTRACT },
        input,
      )?.amount,
    ).toBe(42);
  });
  test("hydrates native minimal lines from catalog and ignores forged embedded metadata", async () => {
    const actual = shippingLine().variant,
      query = { graph: jest.fn(async () => ({ data: [actual] })) };
    const lines = await loadShippingCatalogLines(query, [
      {
        variant_id: actual.id,
        quantity: 2,
        variant: {
          ...actual,
          metadata: {
            [SHIPPING_WEIGHT_KEY]: weightRecord({ physical_weight: 100 }),
          },
        },
      },
    ]);
    expect(resolveShippingWeights(lines).physicalWeightLb).toBe(3);
    await expect(
      loadShippingCatalogLines({ graph: async () => ({ data: [] }) }, [
        { variant_id: "missing", quantity: 1 },
      ]),
    ).rejects.toThrow(ShippingInputError);
  });
  test("public projection removes operating records from cart, order and product responses", () => {
    const body = {
      cart: {
        metadata: {
          [SHIPPING_PACKING_PLAN_KEY]: { secret: true },
          note: "keep",
        },
        items: [
          {
            metadata: {
              [SHIPPING_WEIGHT_SNAPSHOT_KEY]: { secret: true },
              pricing_mode: "fixed",
            },
            variant: shippingLine().variant,
          },
        ],
      },
    };
    const result = publicShippingProjection(body);
    expect(JSON.stringify(result)).not.toContain("shipping_weight");
    expect(JSON.stringify(result)).not.toContain(SHIPPING_PACKING_PLAN_KEY);
    expect(result.cart.metadata.note).toBe("keep");
    expect(body.cart.metadata[SHIPPING_PACKING_PLAN_KEY]).toEqual({
      secret: true,
    });
  });
});
