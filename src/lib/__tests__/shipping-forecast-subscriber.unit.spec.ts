import { buildShippingForecastEvent } from "../../subscribers/analytics/shipping-forecast";
import { shippingLine, packingConfig, packingContext } from "./__fixtures__/shipping-inputs";
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
} from "../shipping-packing-plan";
function order() {
  const items = [shippingLine({ quantity: 2 })],
    plan = createShippingPackingPlan(
      items,
      { ...packingContext(), postalCode: "19103" },
      packingConfig(),
    );
  return {
    id: "order_fixture",
    display_id: 4242,
    created_at: "2026-09-19T03:00:00Z",
    customer_id: "customer_fixture",
    shipping_total: 58,
    metadata: { source: "web", [SHIPPING_PACKING_PLAN_KEY]: plan },
    shipping_address: { province_code: "us-pa", postal_code: "19103" },
    items,
    shipping_methods: [
      {
        name: "UPS Ground Estimated Shipping",
        amount: 58,
        data: { service_code: "GROUND" },
      },
    ],
  };
}
test("reports the original accepted estimate and never infers charged freight", () => {
  const fixture = order(),
    plan = fixture.metadata[SHIPPING_PACKING_PLAN_KEY];
  const p = buildShippingForecastEvent(fixture)!.properties;
  expect(p).toMatchObject({
    order_id: fixture.id,
    service: "GROUND",
    ship_state: "PA",
    route_market: "national",
    estimated_weight_lb: 3,
    packing_plan_id: plan.id,
    packing_policy_version: plan.policyVersion,
    boxes: plan.boxes,
    box_cost: plan.boxCost,
    dry_ice_cost: plan.dryIceCost,
    estimated_packaging_cost: plan.total,
    charged_shipping: 58,
    packaging_cost: null,
    freight: null,
    estimate_status: "accepted_snapshot",
  });
  expect(JSON.stringify(p)).not.toContain("fixture-list-id");
  expect(p.idempotency_key).toBe(
    `order.placed:${fixture.id}:shipping_forecast`,
  );
});
test("current catalog and environment changes cannot rewrite an accepted packing estimate", () => {
  const fixture = order(),
    before = buildShippingForecastEvent(fixture);
  fixture.items[0].variant.metadata.shipping_weight_v1.physical_weight = 100;
  const old = process.env.GRILLERS_SHIPPING_FORECAST_INCLUDE_PACKAGING;
  try {
    process.env.GRILLERS_SHIPPING_FORECAST_INCLUDE_PACKAGING = "false";
    expect(buildShippingForecastEvent(fixture)).toEqual(before);
  } finally {
    if (old === undefined)
      delete process.env.GRILLERS_SHIPPING_FORECAST_INCLUDE_PACKAGING;
    else process.env.GRILLERS_SHIPPING_FORECAST_INCLUDE_PACKAGING = old;
  }
});
test("legacy missing snapshot is unavailable rather than a normal zero-pound/one-box forecast", () => {
  const fixture = order();
  delete (fixture.metadata as any)[SHIPPING_PACKING_PLAN_KEY];
  expect(buildShippingForecastEvent(fixture)?.properties).toMatchObject({
    estimate_status: "unavailable_legacy_snapshot",
    estimated_weight_lb: null,
    boxes: null,
    estimated_packaging_cost: null,
    charged_shipping: 58,
  });
});
test("pickup does not emit a carrier forecast", () => {
  const fixture = order();
  fixture.shipping_methods[0] = {
    name: "Plant Pickup",
    amount: 0,
    data: { service_code: "PICKUP" },
  };
  expect(buildShippingForecastEvent(fixture)).toBeNull();
});
