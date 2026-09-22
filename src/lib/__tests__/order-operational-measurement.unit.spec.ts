import { originalShippingForecast } from "../order-operational-measurement";
import { publicationIdentity } from "../order-publication";
import { promiseFixture } from "./fixtures/order-promise";
import shippingHandler from "../../subscribers/analytics/shipping-forecast";
import { requestOrderPublication } from "../order-publication";
import Service from "../../modules/gp-analytics/service";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

jest.mock("../order-publication", () => ({
  ...jest.requireActual("../order-publication"),
  requestOrderPublication: jest.fn(),
}));
function fixture() {
  const p = promiseFixture();
  p.fulfillment.packing_plan = {
    version: 1,
    id: "plan-1",
    policyVersion: "packing-1",
    service: "GROUND",
    boxes: 1,
    packages: [{ boxTier: "medium" }],
    weights: { physicalWeightLb: 3 },
    transitDays: 2,
    dryIceLb: 4,
    boxCost: 10,
    dryIceCost: 5,
    total: 15,
  };
  p.fulfillment.accepted_shipping_price = {
    version: 1,
    cartId: p.cart_id,
    customerShipping: 25,
    shippingDiscount: 0,
    shippingTax: 0,
    quote: {
      version: 1,
      packingPlanId: "plan-1",
      packingPolicyRevision: "packing-1",
      policy: {
        version: 1,
        revision: "price-1",
        currency: "usd",
        finalShipping: "retain_accepted",
      },
      source: "wwex",
      customerShippingBeforePromotions: 25,
      packagingCost: 15,
      packagingAddition: 15,
      rateBasis: 10,
      carrierFreightEstimate: 10,
    },
  };
  return p;
}
it("separates original estimated freight/packing/customer price from actual charges without PII", () => {
  const result = originalShippingForecast(fixture());
  expect(result).toMatchObject({
    accepted_customer_shipping: 25,
    estimated_carrier_freight: 10,
    estimated_packaging_cost: 15,
    price_decomposition_status: "accepted_snapshot",
    packing_plan_id: "plan-1",
    shipping_price_policy_version: "price-1",
    charged_shipping: null,
    freight: null,
    packaging_cost: null,
    forecast_model_version: null,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /example.invalid|Fixture Road|8000-FIXTURE|approvedBy|payment_consent/
  );
});
it("keeps free shipping zero without treating operating cost as zero", () => {
  const p = fixture();
  p.shipping_total = 0;
  Object.assign(p.fulfillment.accepted_shipping_price!, {
    customerShipping: 0,
    shippingDiscount: 25,
  });
  expect(originalShippingForecast(p)).toMatchObject({
    accepted_customer_shipping: 0,
    accepted_shipping_discount: 25,
    estimated_carrier_freight: 10,
    estimated_packaging_cost: 15,
    charged_shipping: null,
  });
});
it("retains unavailable decomposition instead of inventing a one-box/zero-cost estimate", () => {
  const p = fixture();
  p.fulfillment.packing_plan = null;
  expect(originalShippingForecast(p)).toMatchObject({
    estimate_status: "unavailable_accepted_packing",
    boxes: null,
    accepted_customer_shipping: 25,
    estimated_packaging_cost: null,
    estimated_carrier_freight: null,
  });
});
it.each(["cart", "amount", "packing"])(
  "refuses a mismatched %s quote without rewriting the accepted price",
  (field) => {
    const p = fixture(),
      a: any = p.fulfillment.accepted_shipping_price;
    if (field === "cart") a.cartId = "cart_other";
    if (field === "amount") a.customerShipping = 24;
    if (field === "packing") a.quote.packingPolicyRevision = "changed";
    expect(originalShippingForecast(p)).toMatchObject({
      accepted_customer_shipping: 25,
      price_decomposition_status: "unavailable_accepted_price",
      estimated_carrier_freight: null,
    });
  }
);
it("does not forecast carrier costs for local/pickup orders", () => {
  const p = fixture();
  p.fulfillment.mode = "plant_pickup";
  expect(originalShippingForecast(p)).toBeNull();
});
it.each([["3_DAY_SELECT", "ups_3day"], ["2ND_DAY_AIR", "ups_2da"], ["OVERNIGHT", "ups_overnight"]])(
  "uses the warehouse tier for the original %s service", (service, tier) => {
    const p = fixture(); p.fulfillment.service_code = service; p.fulfillment.service_label = service;
    p.fulfillment.packing_plan!.service = service;
    expect(originalShippingForecast(p)?.fulfillment_tier).toBe(tier);
  }
);
it("refuses conflicting original service labels instead of selecting a different carrier promise", () => {
  const p = fixture(); p.fulfillment.service_code = "OVERNIGHT";
  expect(() => originalShippingForecast(p)).toThrow("service_conflict");
});
it("keeps original shipping identity and distinct allocation audit identities", () => {
  expect(
    publicationIdentity("shipping_forecast", "order_one", "order_one")
  ).toBe("order.placed:order_one:shipping_forecast");
  expect(() =>
    publicationIdentity("shipping_forecast", "order_one", "other")
  ).toThrow();
  expect(
    publicationIdentity("inventory_released", "order_one", "audit_a")
  ).not.toBe(publicationIdentity("inventory_released", "order_one", "audit_b"));
});
it("retains shipping intent before binding without querying mutable order/customer data", async () => {
  const db = {},
    warn = jest.fn();
  const container = {
    resolve: (key: string) =>
      key === "logger"
        ? { warn }
        : key === ContainerRegistrationKeys.PG_CONNECTION
        ? db
        : (() => {
            throw new Error("Mutable query or transport forbidden");
          })(),
  };
  await shippingHandler({
    event: { name: "order.placed", data: { id: "order_one" } },
    container,
  } as any);
  expect(requestOrderPublication).toHaveBeenCalledWith(
    db,
    "shipping_forecast",
    "order_one",
    "order_one"
  );
  (requestOrderPublication as jest.Mock).mockRejectedValueOnce(
    new Error("offline")
  );
  await expect(
    shippingHandler({ event: { data: { id: "order_one" } }, container } as any)
  ).rejects.toThrow("intent_not_recorded");
  expect(warn).toHaveBeenCalled();
});
it("retires generic operational analytics and applies original test/consent gates on durable delivery", async () => {
  const old = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
  const service = new Service(
    { logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() } } as any,
    { jitsuHost: "https://jitsu.example.invalid", jitsuServerSecret: "fixture" }
  );
  try {
    for (const event of [
      "shipping_forecast",
      "inventory_allocation_created",
      "inventory_allocation_released",
    ]) {
      await service.track({ event, properties: {} });
      expect(
        await service.deliverOrderPublication("jitsu", {
          event,
          properties: {
            idempotency_key: "source-one",
            event_timestamp_ms: 1789927200000,
            test_order: true,
            analytics_consent: true,
          },
        })
      ).toMatchObject({ status: "excluded" });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    global.fetch = old;
  }
});
