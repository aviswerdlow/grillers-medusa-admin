import { packageCaptureErrors, orderRequiresPackageCapture } from "../catch-weight-finalization";
import {
  acceptShippingPrice,
  composeShippingPrice,
  issueShippingPriceToken,
  readShippingPriceToken,
  readAcceptedShippingPrice,
  sealAcceptedShippingPrice,
  SHIPPING_PRICE_ACCEPTED_KEY,
  validateShippingPricePolicy,
  priceCents,
} from "../shipping-price-contract";
import { createShippingPackingPlan } from "../shipping-packing-plan";
import {
  packingConfig,
  packingContext,
  shippingLine,
  pricePolicy,
} from "./__fixtures__/shipping-inputs";
import { getShippingMethodTotals } from "@medusajs/framework/utils";
const env = { ...process.env };
beforeEach(() => {
  process.env.GP_SHIPPING_PRICE_ACTIVE_KEY_ID = "fixture";
  process.env.GP_SHIPPING_PRICE_KEYS_JSON = JSON.stringify({
    fixture: "synthetic-shipping-price-test-secret-32-characters",
  });
});
afterAll(() => {
  process.env = env;
});
function fixture() {
  const plan = createShippingPackingPlan(
    [shippingLine()],
    packingContext(),
    packingConfig(),
  );
  const policy = pricePolicy({ cmsFallbackBasis: "freight_only" });
  const quote = composeShippingPrice({
    source: "wwex",
    rate: 20,
    currency: "usd",
    plan,
    policy,
  });
  const cart: any = {
    id: "cart_test",
    currency_code: "usd",
    items: [shippingLine()],
    shipping_address: { postal_code: "30340" },
    shipping_total: 32,
    shipping_discount_total: 0,
    shipping_tax_total: 0,
    item_subtotal: 100,
    tax_total: 5,
    total: 127,
    promotions: [{ id: "promo_item" }],
  };
  return { plan, policy, quote, cart };
}
it.each(["forecast", "wwex", "cms_fallback"] as const)(
  "composes %s packaging once; records costs and caps the full amount",
  (source) => {
    const { plan, policy } = fixture();
    const q = composeShippingPrice({
      source,
      rate: 20,
      carrierFreightEstimate: 20,
      currency: "usd",
      plan,
      policy,
    });
    expect(q).toMatchObject({
      rateBasis: 20,
      boxCost: 10,
      dryIceCost: 2,
      packagingAddition: 12,
      customerShippingBeforePromotions: 32,
      carrierFreightEstimate: source === "cms_fallback" ? null : 20,
    });
    expect(() =>
      composeShippingPrice({
        source,
        rate: 20,
        carrierFreightEstimate: 20,
        currency: "usd",
        plan,
        policy: { ...policy, maxCustomerShipping: 31 },
      }),
    ).toThrow();
  },
);
it("does not add packaging again to a declared inclusive CMS tariff", () => {
  const { plan } = fixture();
  expect(
    composeShippingPrice({
      source: "cms_fallback",
      rate: 75,
      currency: "usd",
      plan,
      policy: pricePolicy(),
    }),
  ).toMatchObject({
    packagingAddition: 0,
    packagingCost: 12,
    carrierFreightEstimate: null,
    customerShippingBeforePromotions: 75,
  });
});
it("retains real costs on free shipping and keeps an item credit distinct", () => {
  const { cart, quote } = fixture();
  cart.shipping_total = 0;
  cart.shipping_discount_total = 32;
  cart.total = 95;
  const accepted = acceptShippingPrice(cart, { amount: 32 }, quote);
  expect(accepted).toMatchObject({
    customerShipping: 0,
    shippingDiscount: 32,
    nonShippingCredit: 10,
    quote: { packagingCost: 12 },
  });
  const order = {
    cart_id: cart.id,
    currency_code: "usd",
    shipping_total: 0,
    metadata: {
      [SHIPPING_PRICE_ACCEPTED_KEY]: sealAcceptedShippingPrice(accepted),
    },
  };
  expect(readAcceptedShippingPrice(order)).toEqual(accepted);
  expect(() =>
    readAcceptedShippingPrice({ ...order, cart_id: "another_cart" }),
  ).toThrow();
});
it("matches native Medusa tax-inclusive shipping totals without discount or tax duplication", () => {
  const { cart, quote } = fixture();
  const native = getShippingMethodTotals(
    {
      amount: 110,
      is_tax_inclusive: true,
      tax_lines: [{ rate: 10 }],
      adjustments: [{ amount: 20 }],
    } as any,
    {} as any,
  );
  const accepted = acceptShippingPrice(
    {
      ...cart,
      shipping_total: Number(native.total),
      shipping_discount_total: Number(native.discount_total),
      shipping_tax_total: Number(native.tax_total),
      item_subtotal: 100,
      tax_total: 17,
      total: 187,
    },
    { amount: 110 },
    { ...quote, customerShippingBeforePromotions: 110 },
  );
  expect(accepted).toMatchObject({
    customerShipping: 88,
    shippingTax: 8,
    shippingDiscount: 22,
    nonShippingCredit: 10,
  });
});
it("binds the quote to cart, basket, address, packing and current policy without exposing them", () => {
  const { cart, quote, plan, policy } = fixture();
  const token = issueShippingPriceToken(cart, plan, quote);
  expect(token).not.toContain("synthetic");
  expect(readShippingPriceToken(token, cart, plan, policy)).toEqual(quote);
  for (const changed of [
    { ...cart, id: "other" },
    { ...cart, shipping_address: { postal_code: "90210" } },
    { ...cart, items: [shippingLine({ quantity: 2 })] },
  ])
    expect(() =>
      readShippingPriceToken(token, changed, plan, policy),
    ).toThrow();
  expect(() =>
    readShippingPriceToken(token, cart, plan, { ...policy, revision: "new" }),
  ).toThrow();
  expect(() =>
    readShippingPriceToken(token, cart, { ...plan, id: "changed" }, policy),
  ).toThrow();
  expect(() =>
    readShippingPriceToken(token.slice(0, -4) + "abcd", cart, plan, policy),
  ).toThrow();
  expect(() =>
    readShippingPriceToken(token, cart, plan, policy, Date.now() + 16 * 60_000),
  ).toThrow();
});
it.each([null, undefined, "", NaN, Infinity, -1, true])(
  "rejects missing/invalid money %s",
  (value) => expect(() => priceCents(value)).toThrow(),
);
it("rejects incomplete approval, unsupported final repricing and expired policies", () => {
  for (const patch of [
    { approvedBy: "" },
    { effectiveThrough: "2026-01-01T00:00:00Z" },
    { finalShipping: "raw_carrier" },
    { maxCustomerShipping: 0 },
    { cmsFallbackBasis: null },
  ])
    expect(() => validateShippingPricePolicy(pricePolicy(patch))).toThrow();
});
it("never signs with a missing/development secret", () => {
  const { cart, plan, quote } = fixture();
  delete process.env.GP_SHIPPING_PRICE_KEYS_JSON;
  expect(() => issueShippingPriceToken(cart, plan, quote)).toThrow();
  process.env.GP_SHIPPING_PRICE_KEYS_JSON = JSON.stringify({
    fixture: "too-short",
  });
  expect(() => issueShippingPriceToken(cart, plan, quote)).toThrow();
});
it("rejects a method mismatch, impossible discount, and incomplete ledger", () => {
  const { cart, quote } = fixture();
  expect(() => acceptShippingPrice(cart, { amount: 1 }, quote)).toThrow();
  expect(() =>
    acceptShippingPrice(
      { ...cart, shipping_discount_total: 33 },
      { amount: 32 },
      quote,
    ),
  ).toThrow();
  expect(() =>
    acceptShippingPrice({ ...cart, total: 1000 }, { amount: 32 }, quote),
  ).toThrow();
});

it("retains accepted records across key rotation while old keys remain in custody", () => {
  const { cart, plan, quote, policy } = fixture();
  const token = issueShippingPriceToken(cart, plan, quote);
  process.env.GP_SHIPPING_PRICE_KEYS_JSON = JSON.stringify({
    fixture: "synthetic-shipping-price-test-secret-32-characters",
    next: "another-synthetic-shipping-price-key-32-characters",
  });
  process.env.GP_SHIPPING_PRICE_ACTIVE_KEY_ID = "next";
  expect(readShippingPriceToken(token, cart, plan, policy)).toEqual(quote);
  expect(issueShippingPriceToken(cart, plan, quote)).toMatch(/^next\./);
});

it("does not label forecast pricing cushion as raw freight cost", () => {
  const { plan, policy } = fixture();
  expect(
    composeShippingPrice({
      source: "forecast",
      rate: 30,
      carrierFreightEstimate: 20,
      currency: "usd",
      plan,
      policy,
    }),
  ).toMatchObject({
    carrierFreightEstimate: 20,
    freightPricingAdjustment: 10,
    customerShippingBeforePromotions: 42,
  });
});

it("requires a complete dimension triplet when staff supplies measured dimensions", () => {
  const order = { metadata: { fulfillmentType: "ups_shipping" } };
  const row = {
    package_type: "custom box",
    packed_weight_lb: 10,
    dry_ice_lb: 2,
    length_in: 10,
    width_in: 11,
    height_in: 12,
  };
  expect(
    packageCaptureErrors(order, { metadata: { packages: [row] } }),
  ).toEqual([]);
  expect(
    packageCaptureErrors(order, {
      metadata: { packages: [{ ...row, width_in: null }] },
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining(
          "all three positive measured dimensions",
        ),
      }),
    ]),
  );
});

it("keeps pickup/local delivery outside the carrier price contract",()=>{
 for(const code of ["PICKUP","ATLANTA_DELIVERY","SCHEDULED_DELIVERY"])
   expect(orderRequiresPackageCapture({metadata:{},shipping_methods:[{shipping_option_id:"shipping_option_fixture",data:{service_code:code}}]})).toBe(false);
 expect(orderRequiresPackageCapture({metadata:{},shipping_methods:[{shipping_option_id:"shipping_option_fixture",data:{service_code:"GROUND"}}]})).toBe(true);
});
