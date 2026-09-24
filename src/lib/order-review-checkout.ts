import { requiresOrderReview } from "./order-review-rollout";
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { MedusaRequest } from "@medusajs/framework/http";
import { z } from "zod";
import {
  acceptOrderPromiseReview,
  createOrderPromiseReview,
  normalizedOrderPromise,
  ORDER_PROMISE_KEY,
  OrderPromiseError,
  validateOrderPromiseSnapshot,
  type OrderPromise,
} from "./order-promise";
import {
  prepareReceiptSnapshot,
  RECEIPT_SNAPSHOT_KEY,
} from "./receipt-email-orders";
import { prepareCalendarAcceptance } from "./fulfillment-calendar-runtime";
import { CALENDAR_ACCEPTED_KEY } from "./fulfillment-calendar";
import { loadCalendarSource } from "./fulfillment-calendar-source";
import { prepareShippingAcceptance } from "./shipping-acceptance";
import { SHIPPING_PACKING_PLAN_KEY } from "./shipping-packing-plan";
import { SHIPPING_WEIGHT_SNAPSHOT_KEY } from "./shipping-weights";
import {
  priceCents,
  readAcceptedShippingPrice,
  shippingPriceTokenExpiry,
  SHIPPING_PRICE_TOKEN_KEY,
} from "./shipping-price-contract";
import {
  buildFinalizationLineSnapshot,
  PAYMENT_WORKFLOW_INVOICE_AR,
  PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE,
} from "./catch-weight-finalization";
import { isOfflinePaymentApproved } from "./gp-offline-payment";
import {
  cartHasStaffMarkers,
  staffCartSigningSecret,
  verifiedStaffCartAuthority,
} from "./staff-cart-authority";
import { STAFF_AUTHORIZATION_HEADER } from "./staff-principal";
import { staffCapabilities, staffSessionIsCurrent } from "./staff-access-policy";
import {
  publishedSaleTerms,
  FINAL_CHARGE_CONSENT_TEXT,
  FINAL_CHARGE_CONSENT_VERSION,
  STAFF_CARD_CONSENT_TEXT,
  STAFF_CARD_CONSENT_VERSION,
} from "./order-review-terms";

export type ReviewPaymentMode = OrderPromise["terms"]["payment_mode"];
export type ReviewAcceptance = {
  reviewId: string;
  requestId: string;
  analyticsConsent: boolean | null;
};
export function readReviewAcceptance(value: any): ReviewAcceptance {
  const parsed = z
    .object({
      review_id: z.string().min(1).max(100),
      request_id: z.string().uuid(),
      analytics_consent: z.boolean().nullable(),
    })
    .safeParse(value);
  if (!parsed.success)
    throw new OrderPromiseError("order_review_required", 422);
  return {
    reviewId: parsed.data.review_id,
    requestId: parsed.data.request_id,
    analyticsConsent: parsed.data.analytics_consent,
  };
}
const record = (v: any): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const fail = (
  code = "order_review_changed_refresh_required",
  status = 409
): never => {
  throw new OrderPromiseError(code, status);
};
const dbFor = (scope: any) =>
  scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
export const REVIEW_CART_FIELDS = [
  "id",
  "email",
  "customer_id",
  "currency_code",
  "completed_at",
  "metadata",
  "total",
  "item_total",
  "shipping_total",
  "tax_total",
  "discount_total",
  "shipping_address.*",
  "billing_address.*",
  "shipping_methods.*",
  "items.*",
];

export async function reviewCart(scope: any, cartId: string) {
  const { data } = await scope
    .resolve(ContainerRegistrationKeys.QUERY)
    .graph({
      entity: "cart",
      fields: REVIEW_CART_FIELDS,
      filters: { id: cartId },
    });
  if (!data?.[0]) fail("order_review_cart_unavailable", 403);
  return data[0];
}

/** The cart ID is the same lock key used by native cart mutation/completion.
 * Never call a cart workflow inside this callback: native completion acquires
 * this lock itself after acceptance, then checks the exact copied cart again. */
export function withReviewCartLock<T>(
  scope: any,
  cartId: string,
  job: () => Promise<T>
): Promise<T> {
  return scope.resolve(Modules.LOCKING).execute(cartId, job, { timeout: 120 });
}

export async function assertReviewOwner(req: MedusaRequest, cart: any) {
  const proof = (req as any).gp_staff_cart;
  const actorId = (req as any).auth_context?.actor_id;
  const staff = Boolean(proof && req.headers[STAFF_AUTHORIZATION_HEADER]);
  if (
    !cart.customer_id ||
    (staff
      ? proof.customer_id !== cart.customer_id
      : actorId !== cart.customer_id)
  )
    fail("order_review_cart_unavailable", 403);
  // gp_staff_cart is supplied only by enforceStaffCartAuthority, which checks
  // signature, current capability/session, customer and cart. Never body data.
  if (staff && proof.cart_id !== cart.id)
    fail("order_review_cart_unavailable", 403);
  return { staff, customerId: cart.customer_id };
}

function address(value: any) {
  const a = record(value);
  return Object.fromEntries(
    [
      "first_name",
      "last_name",
      "company",
      "address_1",
      "address_2",
      "city",
      "province",
      "postal_code",
      "country_code",
    ].map((k) => [k, String(a[k] ?? "").trim()])
  );
}

function experimentAssignments(
  items: any[]
): OrderPromise["attribution"]["experiment_assignments"] {
  const assignments = new Map<string, any>(),
    conflicted = new Set<string>();
  for (const item of items) {
    let context = item.metadata?.experiment_context;
    try {
      if (typeof context === "string") context = JSON.parse(context);
    } catch {
      continue;
    }
    for (const [experiment_id, value] of Object.entries(record(context))) {
      const v = record(value);
      if (
        ![experiment_id, v.variant_key, v.assignment_id].every(
          (x) => typeof x === "string" && x.trim() && x.length <= 500
        )
      )
        continue;
      const candidate = {
        experiment_id,
        variant: v.variant_key,
        assignment_id: v.assignment_id,
        version:
          typeof v.version === "string" &&
          v.version.trim() &&
          v.version.length <= 500
            ? v.version
            : null,
      };
      if (
        assignments.has(experiment_id) &&
        JSON.stringify(assignments.get(experiment_id)) !==
          JSON.stringify(candidate)
      )
        conflicted.add(experiment_id);
      assignments.set(experiment_id, candidate);
    }
  }
  // An ambiguous or absent measurement must not block commerce or be presented
  // as a verified experiment version. #335/#336 own assignment reconciliation.
  return [...assignments.values()]
    .filter((a) => !conflicted.has(a.experiment_id))
    .slice(0, 100);
}

/** Derive every price/catalog/contact/terms field on the server. loadedCart is
 * the native workflow's exact copy source when invoked by its validation hook. */
export async function trustedOrderPromise(
  scope: any,
  loadedCart: any,
  mode: ReviewPaymentMode,
  analyticsConsent: boolean | null
): Promise<OrderPromise> {
  const cart = loadedCart,
    m = record(cart.metadata),
    customerId = cart.customer_id || cart.customer?.id;
  if (!customerId || !cart.items?.length) fail("order_review_incomplete", 422);
  const query = scope.resolve(ContainerRegistrationKeys.QUERY);
  const customer = await scope
    .resolve(Modules.CUSTOMER)
    .retrieveCustomer(customerId, { select: ["id", "metadata"] });
  if (cartHasStaffMarkers(cart)) {
    const proof = verifiedStaffCartAuthority(cart, staffCartSigningSecret(scope));
    if (!proof) return fail("order_review_cart_unavailable", 403);
    const actor = await scope.resolve(Modules.CUSTOMER).retrieveCustomer(proof.actor_id, { select: ["id", "metadata"] });
    if (!staffCapabilities(actor).has("customers.write") || !staffSessionIsCurrent(actor, { iat: proof.session_iat })
      || Number(actor.metadata?.staff_access_version || 0) !== proof.access_version) fail("order_review_cart_unavailable", 403);
  }
  const terms = await publishedSaleTerms();
  const receipt = await dbFor(scope)("gp_receipt_snapshot")
    .where({
      id: m[RECEIPT_SNAPSHOT_KEY],
      cart_id: cart.id,
      customer_id: customerId,
    })
    .first();
  if (!receipt) fail("order_review_contact_unavailable");
  const calendar = record(m[CALENDAR_ACCEPTED_KEY]);
  const { acceptedAt: _acceptedAt, ...selection } = calendar;
  if (selection.cartId !== cart.id || !selection.choice || !selection.request)
    fail();
  const ids = [...new Set(cart.items.map((line: any) => line.variant_id))];
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: [
      "id",
      "title",
      "sku",
      "metadata",
      "product.id",
      "product.title",
      "product.metadata",
    ],
    filters: { id: ids },
  });
  if (
    !Array.isArray(variants) ||
    variants.length !== ids.length ||
    new Set(variants.map((v) => v.id)).size !== ids.length
  )
    fail("order_review_catalog_unavailable", 422);
  const byId = new Map(variants.map((v) => [v.id, v]));
  const lines = cart.items.map((line: any) => {
    const variant: any = byId.get(line.variant_id);
    if (
      !variant?.product?.id ||
      line.product_id !== variant.product.id ||
      /^RM-/i.test(variant.sku || "")
    )
      fail("order_review_catalog_unavailable", 422);
    // Public line metadata is not a source for accounting identity, food
    // weight, price-per-pound or a customer-facing product name.
    const safeLine = {
      ...line,
      metadata: {},
      variant,
      product: variant.product,
    };
    const basis = buildFinalizationLineSnapshot(
      { id: cart.id },
      safeLine,
      "review"
    );
    const { captured_at: _captured, ...weight } = record(
      line.metadata?.[SHIPPING_WEIGHT_SNAPSHOT_KEY]
    );
    return {
      cart_line_id: line.id,
      variant_id: variant.id,
      product_id: variant.product.id,
      qbd_list_id: basis.qbd_list_id,
      customer_title: basis.customer_title,
      quantity: Number(line.quantity),
      pricing_mode: basis.pricing_mode,
      estimated_unit_price: priceCents(line.unit_price) / 100,
      estimated_line_total: priceCents(line.total) / 100,
      estimated_line_subtotal: priceCents(line.subtotal) / 100,
      estimated_line_tax: priceCents(line.tax_total) / 100,
      rate_per_lb: basis.pricing_mode === "per_lb" ? basis.unit_price : null,
      estimated_weight_lb:
        basis.pricing_mode === "per_lb" ? basis.estimated_weight_total : null,
      weight_snapshot: Object.keys(weight).length ? weight : null,
    };
  });
  const invoiceTerms =
    mode === "invoice"
      ? String(customer.metadata?.gp_payment_terms ?? "").trim()
      : null;
  if (
    mode === "invoice" &&
    (!isOfflinePaymentApproved(customer.metadata) || !invoiceTerms)
  )
    fail("order_review_invoice_terms_unavailable", 422);
  if (mode === "card_at_placement") {
    const proof = cartHasStaffMarkers(cart)
      ? verifiedStaffCartAuthority(cart, staffCartSigningSecret(scope))
      : null;
    if (lines.some((line) => line.pricing_mode === "per_lb"))
      fail("order_review_staff_catch_weight_requires_checkout", 422);
    if (
      proof?.payment_mode !== "collect_card_now" ||
      m.staff_payment_consent !== true
    )
      fail("order_review_payment_mode_unavailable", 403);
  }
  const shipping =
    selection.request.mode === "ups_shipping"
      ? readAcceptedShippingPrice({ ...cart, cart_id: cart.id })
      : null;
  let pickupLocation: string | null = null;
  if (selection.request.mode === "southeast_pickup") {
    const source = await loadCalendarSource();
    const route = source.policy.southeast.find(route => route.id === selection.request.routeId);
    if (!route) return fail("order_review_changed_refresh_required");
    pickupLocation = `${route.city}, ${route.state}`;
  }
  const stripeKey = process.env.STRIPE_API_KEY ?? "";
  return normalizedOrderPromise({
    schema_version: 1,
    cart_id: cart.id,
    customer_id: customerId,
    currency: String(cart.currency_code).toLowerCase(),
    amount_unit: "major",
    amount_basis: "accepted_placement_estimate_v1",
    placement_total: priceCents(cart.total) / 100,
    item_total: priceCents(cart.item_total) / 100,
    shipping_total: priceCents(cart.shipping_total) / 100,
    tax_total: priceCents(cart.tax_total) / 100,
    discount_total: priceCents(cart.discount_total) / 100,
    shipping_address: address(cart.shipping_address),
    billing_address: address(cart.billing_address),
    contact: {
      checkout_email: cart.email,
      receipt_email: receipt.email,
      receipt_snapshot_id: receipt.id,
      phone: String(cart.shipping_address?.phone || "").trim(),
    },
    lines,
    fulfillment: {
      mode: selection.request.mode,
      arrival_date: selection.choice.arrivalDate,
      window_label: selection.choice.window?.label ?? "",
      timezone: m.fulfillmentCalendarTimezone,
      service_code: selection.request.service,
      service_label: cart.shipping_methods?.length === 1 ? cart.shipping_methods[0].name : null,
      pickup_location: pickupLocation,
      calendar_revision: selection.calendarRevision,
      calendar_selection: selection,
      packing_plan: shipping ? m[SHIPPING_PACKING_PLAN_KEY] : null,
      accepted_shipping_price: shipping,
    },
    terms: {
      review_version: "checkout-review-2026-09-20",
      sale_terms_revision: terms.revision,
      sale_terms_document: terms.document,
      payment_mode: mode,
      payment_consent_version:
        mode === "invoice"
          ? null
          : mode === "card"
          ? FINAL_CHARGE_CONSENT_VERSION
          : STAFF_CARD_CONSENT_VERSION,
      payment_consent_text:
        mode === "invoice"
          ? null
          : mode === "card"
          ? FINAL_CHARGE_CONSENT_TEXT
          : STAFF_CARD_CONSENT_TEXT,
      invoice_terms: invoiceTerms,
    },
    attribution: {
      experiment_assignments: experimentAssignments(cart.items),
      analytics_consent: analyticsConsent,
      test_order: /^sk_test_/.test(stripeKey)
        ? true
        : /^sk_live_/.test(stripeKey)
        ? false
        : null,
    },
  });
}

async function prepare(scope: any, cartId: string) {
  await prepareCalendarAcceptance(scope, cartId);
  await prepareShippingAcceptance(scope, cartId);
  await prepareReceiptSnapshot(scope, cartId);
  const cart = await reviewCart(scope, cartId);
  if (!cart.completed_at)
    await scope
      .resolve(Modules.CART)
      .updateLineItems(
        cart.items.map((line: any) => ({
          id: line.id,
          metadata: {
            ...line.metadata,
            gp_order_promise_cart_line_id: line.id,
          },
        }))
      );
  return reviewCart(scope, cartId);
}

async function stampReviewedLines(
  scope: any,
  cart: any,
  promise: OrderPromise
) {
  await scope.resolve(Modules.CART).updateLineItems(
    promise.lines.map((line) => ({
      id: line.cart_line_id,
      metadata: {
        ...cart.items.find((item: any) => item.id === line.cart_line_id)
          ?.metadata,
        gp_order_promise_cart_line_id: line.cart_line_id,
        qbd_list_id: line.qbd_list_id,
        customer_title: line.customer_title,
        pricing_mode: line.pricing_mode,
        price_per_lb: line.rate_per_lb,
        estimated_weight_each:
          line.estimated_weight_lb === null
            ? null
            : line.estimated_weight_lb / line.quantity,
      },
    }))
  );
}

export function publicOrderReview(row: any) {
  const p = normalizedOrderPromise(row.promise);
  return {
    id: row.id,
    expires_at: new Date(row.expires_at).toISOString(),
    cart_id: p.cart_id,
    currency: p.currency,
    placement_total: p.placement_total,
    item_total: p.item_total,
    shipping_total: p.shipping_total,
    tax_total: p.tax_total,
    discount_total: p.discount_total,
    shipping_address: p.shipping_address,
    billing_address: p.billing_address,
    contact: {
      checkout_email: p.contact.checkout_email,
      receipt_email: p.contact.receipt_email,
      phone: p.contact.phone,
    },
    lines: p.lines.map(
      ({
        cart_line_id,
        customer_title,
        quantity,
        pricing_mode,
        estimated_unit_price,
        estimated_line_total,
        rate_per_lb,
        estimated_weight_lb,
      }) => ({
        id: cart_line_id,
        title: customer_title,
        quantity,
        pricing_mode,
        estimated_unit_price,
        estimated_line_total,
        rate_per_lb,
        estimated_weight_lb,
      })
    ),
    fulfillment: {
      mode: p.fulfillment.mode,
      arrival_date: p.fulfillment.arrival_date,
      window_label: p.fulfillment.window_label,
      timezone: p.fulfillment.timezone,
      service_code: p.fulfillment.service_code,
      service_label: p.fulfillment.service_label,
      pickup_location: p.fulfillment.pickup_location,
    },
    shipping_policy: p.fulfillment.accepted_shipping_price
      ? "The reviewed shipping charge is retained when the final food weight is charged."
      : null,
    terms: {
      payment_mode: p.terms.payment_mode,
      consent_version: p.terms.payment_consent_version,
      consent_text: p.terms.payment_consent_text,
      invoice_terms: p.terms.invoice_terms,
      sale_terms_revision: p.terms.sale_terms_revision,
    },
  };
}

export async function issueCheckoutReview(
  scope: any,
  cartId: string,
  customerId: string,
  mode: ReviewPaymentMode,
  analyticsConsent: boolean | null,
  requestId: string
) {
  return withReviewCartLock(scope, cartId, async () => {
    if ((await reviewCart(scope, cartId)).customer_id !== customerId)
      fail("order_review_cart_unavailable", 403);
    const cart = await prepare(scope, cartId);
    const promise = await trustedOrderPromise(
      scope,
      cart,
      mode,
      analyticsConsent
    );
    await stampReviewedLines(scope, cart, promise);
    const c = promise.fulfillment.calendar_selection as any;
    const expiries = [
      Date.now() + 15 * 60_000,
      Date.parse(c.expiresAt),
      Date.parse(c.choice.cutoffAt),
    ];
    if (promise.fulfillment.accepted_shipping_price) {
      expiries.push(
        shippingPriceTokenExpiry(
          cart.shipping_methods[0].data?.[SHIPPING_PRICE_TOKEN_KEY]
        )
      );
      expiries.push(
        Date.parse(
          (promise.fulfillment.accepted_shipping_price as any).quote.policy
            .effectiveThrough
        )
      );
    }
    return publicOrderReview(
      await createOrderPromiseReview(dbFor(scope), {
        promise,
        requestId,
        expiresAt: new Date(Math.min(...expiries)),
      })
    );
  });
}

export async function acceptCheckoutReview(
  scope: any,
  cartId: string,
  customerId: string,
  acceptance: ReviewAcceptance,
  mode: ReviewPaymentMode
) {
  return withReviewCartLock(scope, cartId, async () => {
    const cart = await reviewCart(scope, cartId);
    if (cart.customer_id !== customerId)
      fail("order_review_cart_unavailable", 403);
    if (cart.completed_at) {
      const link = await dbFor(scope)("order_cart")
        .where({ cart_id: cart.id })
        .whereNull("deleted_at")
        .first();
      const order =
        link &&
        (await dbFor(scope)("order")
          .where({ id: link.order_id, customer_id: customerId })
          .whereNull("deleted_at")
          .first());
      if (
        !order ||
        order.metadata?.[ORDER_PROMISE_KEY] !==
          cart.metadata?.[ORDER_PROMISE_KEY]
      )
        fail("order_review_completion_recovery_required", 503);
      const row = await dbFor(scope)("gp_order_promise_snapshot")
        .where({
          id: cart.metadata?.[ORDER_PROMISE_KEY],
          cart_id: cart.id,
          customer_id: cart.customer_id,
          review_id: acceptance.reviewId,
          request_id: acceptance.requestId,
        })
        .first();
      if (
        !row ||
        normalizedOrderPromise(row.promise).terms.payment_mode !== mode
      )
        fail("order_review_completion_recovery_required");
      return { snapshot: row, completed: true };
    }
    const fresh = await prepare(scope, cartId);
    const promise = await trustedOrderPromise(
      scope,
      fresh,
      mode,
      acceptance.analyticsConsent
    );
    await stampReviewedLines(scope, fresh, promise);
    const snapshot = await acceptOrderPromiseReview(dbFor(scope), {
      currentPromise: promise,
      reviewId: acceptance.reviewId,
      requestId: acceptance.requestId,
    });
    return { snapshot, completed: false };
  });
}

/** Compose inside the existing single native validate hook. */
export async function validateCheckoutReview(scope: any, cart: any) {
  if (!requiresOrderReview(cart)) return;
  const db = dbFor(scope),
    snapshotId = cart.metadata?.[ORDER_PROMISE_KEY];
  const customerId = cart.customer_id || cart.customer?.id;
  if (typeof snapshotId !== "string" || !customerId)
    fail("order_review_required");
  const row = await db("gp_order_promise_snapshot")
    .where({ id: snapshotId, cart_id: cart.id, customer_id: customerId })
    .first();
  if (!row) fail("order_review_required");
  const original = normalizedOrderPromise(row.promise);
  if (cart.completed_at) {
    const link = await db("order_cart")
      .where({ cart_id: cart.id })
      .whereNull("deleted_at")
      .first();
    const order =
      link &&
      (await db("order")
        .where({ id: link.order_id, customer_id: customerId })
        .whereNull("deleted_at")
        .first());
    if (!order || order.metadata?.[ORDER_PROMISE_KEY] !== snapshotId)
      fail("order_review_completion_recovery_required");
    return; // Recover the original native completion; never rebuild from today.
  }
  const mode = original.terms.payment_mode;
  const m = record(cart.metadata);
  for (const line of original.lines) {
    const item = cart.items?.find((i: any) => i.id === line.cart_line_id);
    if (
      item?.metadata?.gp_order_promise_cart_line_id !== line.cart_line_id ||
      item?.metadata?.qbd_list_id !== line.qbd_list_id ||
      item?.metadata?.pricing_mode !== line.pricing_mode ||
      item?.metadata?.customer_title !== line.customer_title ||
      item?.metadata?.price_per_lb !== line.rate_per_lb ||
      item?.metadata?.estimated_weight_each !==
        (line.estimated_weight_lb === null
          ? null
          : line.estimated_weight_lb / line.quantity)
    )
      fail("order_acceptance_changed");
  }
  if (
    (mode === "card" &&
      (m.payment_workflow !== PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE ||
        m.final_charge_consent_version !==
          original.terms.payment_consent_version ||
        m.final_charge_consent_text !== original.terms.payment_consent_text)) ||
    (mode === "invoice" &&
      (m.payment_workflow !== PAYMENT_WORKFLOW_INVOICE_AR ||
        m.gp_payment_terms !== original.terms.invoice_terms))
  )
    fail("order_review_payment_mode_changed");
  await validateOrderPromiseSnapshot(db, {
    snapshotId,
    reviewId: row.review_id,
    promise: await trustedOrderPromise(
      scope,
      cart,
      mode,
      original.attribution.analytics_consent
    ),
  });
}

export function reviewErrorResponse(res: any, error: unknown) {
  const known = error instanceof OrderPromiseError;
  const code = known ? error.code : "order_review_unavailable";
  const messages: Record<string, string> = {
    order_review_cart_unavailable:
      "Sign in with this cart's customer account or current authorized staff session.",
    order_review_staff_catch_weight_requires_checkout:
      "This order includes food priced by packed weight. Use the customer's saved-card checkout or send a checkout link so the final total can be charged after packing.",
    order_review_terms_unavailable:
      "The terms of sale could not be loaded. Try reviewing the order again.",
    order_review_invoice_terms_unavailable:
      "This account needs approved invoice terms. Please contact the office or choose a card.",
    order_review_completion_recovery_required:
      "An order may already exist. Keep this cart and contact the office before taking another payment.",
    order_review_catalog_unavailable:
      "An item needs a pricing or catalog review. Please contact the office before placing this order.",
  };
  return res
    .status(known ? error.status : 503)
    .json({
      type: "order_review_required",
      code,
      message:
        messages[code] ??
        "The order details changed or the review expired. Review the current order before placing it.",
    });
}
