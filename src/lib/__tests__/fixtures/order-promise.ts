import type { OrderPromise } from "../../order-promise";

export const promiseNow = new Date("2026-09-20T18:00:00.000Z");
export function promiseFixture(
  cartId = "cart_promise",
  customerId = "cus_promise"
): OrderPromise {
  const address = {
    first_name: "Synthetic",
    last_name: "Customer",
    company: "",
    address_1: "1 Fixture Road",
    address_2: "",
    city: "Atlanta",
    province: "GA",
    postal_code: "30303",
    country_code: "us" as const,
  };
  return {
    schema_version: 1,
    cart_id: cartId,
    customer_id: customerId,
    currency: "usd",
    amount_unit: "major",
    amount_basis: "accepted_placement_estimate_v1",
    placement_total: 91.25,
    item_total: 60,
    shipping_total: 25,
    tax_total: 6.25,
    discount_total: 0,
    shipping_address: { ...address },
    billing_address: { ...address },
    contact: {
      checkout_email: "checkout@example.invalid",
      receipt_email: "receipt@example.invalid",
      receipt_snapshot_id: "gprs_fixture",
      phone: "+12025550123",
    },
    lines: [
      {
        cart_line_id: "line_fixture",
        variant_id: "variant_fixture",
        product_id: "prod_fixture",
        qbd_list_id: "8000-FIXTURE",
        customer_title: "Synthetic roast",
        quantity: 2,
        pricing_mode: "per_lb",
        estimated_unit_price: 10,
        estimated_line_total: 60,
        rate_per_lb: 10,
        estimated_weight_lb: 6,
        weight_snapshot: { revision: "synthetic-weight-1", physical_lb: 3 },
      },
    ],
    fulfillment: {
      mode: "ups_shipping",
      arrival_date: "2026-09-24",
      window_label: "",
      timezone: "America/New_York",
      service_code: "03",
      calendar_revision: "synthetic-calendar-1",
      calendar_selection: {
        quoteId: "synthetic-calendar-quote",
        cartId,
        expiresAt: "2026-09-20T18:15:00.000Z",
      },
      packing_plan: {
        id: "synthetic-packing-plan",
        revision: "synthetic-packing-1",
      },
      accepted_shipping_price: { policy: "retain_accepted", amount: 25 },
    },
    terms: {
      review_version: "synthetic-review-1",
      sale_terms_revision: "synthetic-terms-1",
      payment_mode: "card",
      final_charge_consent_version: "synthetic-consent-1",
      final_charge_consent_text: "Synthetic consent for this fixture only.",
      invoice_terms: null,
    },
    attribution: {
      experiment_assignments: [
        {
          experiment_id: "synthetic_experiment",
          version: "1",
          variant: "control",
        },
      ],
      analytics_consent: false,
      test_order: true,
    },
  };
}

/** Controlled native workflow boundary, not a full checkout run. */
export function completedPromiseCart(
  cartId = "cart_promise",
  orderId = "order_promise"
) {
  return {
    result: { id: orderId },
    errors: [],
    transaction: {
      modelId: "complete-cart",
      transactionId: cartId,
      runId: "run_fixture",
      payload: { id: cartId },
      hasFinished: () => true,
      getState: () => "done",
      getErrors: () => [],
    },
  };
}
