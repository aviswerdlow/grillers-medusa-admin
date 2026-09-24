import { pricePolicy } from "./__fixtures__/shipping-inputs";
import {
  composeShippingPrice,
  issueShippingPriceToken,
  SHIPPING_PRICE_TOKEN_KEY,
} from "../shipping-price-contract";
jest.mock("../shipping-price-policy-strapi", () => ({
  getShippingPricePolicy: jest.fn(async () =>
    require("./__fixtures__/shipping-inputs").pricePolicy(),
  ),
}));
import {
  prepareShippingAcceptance,
  validateShippingAcceptance,
} from "../shipping-acceptance";
import { getPackagingConfig } from "../packaging-cost-strapi";
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
} from "../shipping-packing-plan";
import {
  SHIPPING_WEIGHT_SNAPSHOT_KEY,
  SHIPPING_WEIGHT_KEY,
} from "../shipping-weights";
import {
  shippingLine,
  packingConfig,
  packingContext,
} from "./__fixtures__/shipping-inputs";
import path from "node:path";
jest.mock("../fulfillment-calendar-runtime", () => ({
  currentCalendarSelection: jest.fn(async () => ({ selection: {} })),
}));
jest.mock("../fulfillment-calendar-selection", () => ({
  packingContextFromCalendar: jest.fn(() =>
    require("./__fixtures__/shipping-inputs").packingContext(),
  ),
}));
jest.mock("../packaging-cost-strapi", () => ({
  getPackagingConfig: jest.fn(),
}));
const clone = (v: any) => JSON.parse(JSON.stringify(v));
function harness() {
  const line = shippingLine();
  const plan = createShippingPackingPlan(
    [line],
    packingContext(),
    packingConfig(),
  );
  const cart: any = {
    id: "cart_fixture",
    currency_code: "usd",
    shipping_total: 32,
    shipping_discount_total: 0,
    shipping_tax_total: 0,
    item_subtotal: 10,
    tax_total: 0,
    total: 42,
    promotions: [],
    metadata: { other: "keep" },
    items: [line],
    shipping_address: { postal_code: "30340" },
    shipping_methods: [
      {
        shipping_option_id: "so_ground",
        amount: 32,
        data: { [SHIPPING_PACKING_PLAN_KEY]: plan },
      },
    ],
  };
  cart.shipping_methods[0].data[SHIPPING_PRICE_TOKEN_KEY] =
    issueShippingPriceToken(
      cart,
      plan,
      composeShippingPrice({
        source: "wwex",
        rate: 20,
        currency: "usd",
        plan,
        policy: pricePolicy(),
      }),
    );
  const variants = [line.variant];
  const query = {
    graph: jest.fn(async ({ entity }) => ({
      data:
        entity === "cart"
          ? [clone(cart)]
          : entity === "variant"
            ? clone(variants)
            : [{ id: "so_ground", data: { service_code: "GROUND" } }],
    })),
  };
  const module = {
    updateLineItems: jest.fn(async (rows) => {
      for (const row of rows)
        cart.items.find((l) => l.id === row.id).metadata = row.metadata;
    }),
    updateCarts: jest.fn(async (_id, data) => {
      Object.assign(cart, data);
    }),
  };
  const container = {
    resolve: (name: string) => (name === "query" ? query : module),
  };
  return { cart, container, module, variants, plan };
}
beforeEach(() => {
  process.env.GP_SHIPPING_PRICE_ACTIVE_KEY_ID = "fixture";
  process.env.GP_SHIPPING_PRICE_KEYS_JSON = JSON.stringify({
    fixture: "synthetic-shipping-price-test-secret-32-characters",
  });
  (getPackagingConfig as jest.Mock).mockResolvedValue(packingConfig());
});
test("acceptance stores trusted line and plan snapshots without changing other metadata", async () => {
  const h = harness();
  h.cart.items[0].metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY] = { fake: true };
  await prepareShippingAcceptance(h.container, h.cart.id);
  expect(h.cart.metadata).toMatchObject({
    other: "keep",
    [SHIPPING_PACKING_PLAN_KEY]: h.plan,
  });
  expect(
    h.cart.items[0].metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY].record
      .physical_weight,
  ).toBe(1.5);
  await expect(
    validateShippingAcceptance(h.container, clone(h.cart)),
  ).resolves.toBeUndefined();
});
test("missing selection, changed catalog, or changed quantity rejects before completion", async () => {
  const h = harness();
  delete h.cart.shipping_methods[0].data[SHIPPING_PACKING_PLAN_KEY];
  await expect(
    prepareShippingAcceptance(h.container, h.cart.id),
  ).rejects.toMatchObject({
    code: "shipping_selection_changed_refresh_required",
  });
  expect(h.module.updateLineItems).not.toHaveBeenCalled();
  const other = harness();
  await prepareShippingAcceptance(other.container, other.cart.id);
  const loaded = clone(other.cart);
  loaded.items[0].quantity = 2;
  await expect(
    validateShippingAcceptance(other.container, loaded),
  ).rejects.toMatchObject({ code: "shipping_acceptance_changed" });
  other.variants[0].metadata[SHIPPING_WEIGHT_KEY].physical_weight = 2;
  await expect(
    validateShippingAcceptance(other.container, other.cart),
  ).rejects.toMatchObject({
    code: "shipping_selection_changed_refresh_required",
  });
});
test("completed-cart replay does not replace accepted snapshots", async () => {
  const h = harness();
  h.cart.completed_at = "2026-09-19T03:00:00Z";
  await prepareShippingAcceptance(h.container, h.cart.id);
  expect(h.module.updateLineItems).not.toHaveBeenCalled();
});

test("a policy cost change requires quote acceptance again and preserves the original cart snapshot", async () => {
  const h = harness();
  await prepareShippingAcceptance(h.container, h.cart.id);
  const original = clone(h.cart.metadata[SHIPPING_PACKING_PLAN_KEY]);
  const updated = packingConfig();
  updated.dryIceUsdPerLb = 2;
  (getPackagingConfig as jest.Mock).mockResolvedValue(updated);
  await expect(
    validateShippingAcceptance(h.container, h.cart),
  ).rejects.toMatchObject({
    code: "shipping_selection_changed_refresh_required",
  });
  expect(h.cart.metadata[SHIPPING_PACKING_PLAN_KEY]).toEqual(original);
});

test("the installed Medusa line conversion carries the prepared snapshot into the order", async () => {
  const h = harness();
  await prepareShippingAcceptance(h.container, h.cart.id);
  const { prepareLineItemData } = require(
    path.join(
      path.dirname(require.resolve("@medusajs/core-flows")),
      "cart/utils/prepare-line-item-data.js",
    ),
  );
  const line = h.cart.items[0];
  const orderLine = prepareLineItemData({
    item: line,
    variant: {
      ...line.variant,
      product: {
        id: "product_fixture",
        title: "Synthetic product",
        is_giftcard: false,
      },
    },
    cartId: h.cart.id,
    unitPrice: 10,
    isTaxInclusive: false,
    taxLines: [],
    adjustments: [],
  });
  expect(orderLine.metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY]).toEqual(
    line.metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY],
  );
  expect(orderLine.variant_id).toBe(line.variant_id);
});

test("completion rejects changed shipping amount or promotions after preparation", async () => {
  const h = harness();
  await prepareShippingAcceptance(h.container, h.cart.id);
  const loaded = clone(h.cart);
  delete loaded.shipping_discount_total;
  await expect(
    validateShippingAcceptance(h.container, loaded),
  ).resolves.toBeUndefined();
  loaded.shipping_methods[0].amount = 1;
  await expect(
    validateShippingAcceptance(h.container, loaded),
  ).rejects.toThrow();
  const promo = clone(h.cart);
  promo.promotions = [{ id: "unexpected_promo" }];
  await expect(
    validateShippingAcceptance(h.container, promo),
  ).rejects.toThrow();
});
