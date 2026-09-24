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
import { shippingLine, packingConfig } from "./__fixtures__/shipping-inputs";
import path from "node:path";
jest.mock("../packaging-cost-strapi", () => ({
  getPackagingConfig: jest.fn(),
}));
const clone = (v: any) => JSON.parse(JSON.stringify(v));
function harness() {
  const line = shippingLine();
  const plan = createShippingPackingPlan(
    [line],
    { service: "GROUND", postalCode: "30340" },
    packingConfig(),
  );
  const cart: any = {
    id: "cart_fixture",
    metadata: { other: "keep" },
    items: [line],
    shipping_address: { postal_code: "30340" },
    shipping_methods: [
      {
        shipping_option_id: "so_ground",
        data: { [SHIPPING_PACKING_PLAN_KEY]: plan },
      },
    ],
  };
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

test("the installed Medusa line conversion carries the prepared snapshot into the order", async () => {
  const h = harness();
  await prepareShippingAcceptance(h.container, h.cart.id);
  const { prepareLineItemData } = require(path.join(path.dirname(require.resolve("@medusajs/core-flows")), "cart/utils/prepare-line-item-data.js"));
  const line = h.cart.items[0];
  const orderLine = prepareLineItemData({item:line,variant:{...line.variant,product:{id:"product_fixture",title:"Synthetic product",is_giftcard:false}},cartId:h.cart.id,unitPrice:10,isTaxInclusive:false,taxLines:[],adjustments:[]});
  expect(orderLine.metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY]).toEqual(line.metadata[SHIPPING_WEIGHT_SNAPSHOT_KEY]);
  expect(orderLine.variant_id).toBe(line.variant_id);
});
