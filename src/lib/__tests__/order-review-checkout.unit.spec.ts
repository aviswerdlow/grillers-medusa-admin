import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  assertReviewOwner,
  publicOrderReview,
  trustedOrderPromise,
  validateCheckoutReview,
  withReviewCartLock,
} from "../order-review-checkout";
import {
  OrderPromiseError,
  ORDER_PROMISE_KEY,
  orderPromiseHash,
} from "../order-promise";
import { CALENDAR_ACCEPTED_KEY } from "../fulfillment-calendar";
import { RECEIPT_SNAPSHOT_KEY } from "../receipt-email-orders";
import { promiseFixture } from "./fixtures/order-promise";
import experimentFixture from "./fixtures/experiment-evidence.json";
import {
  publishedSaleTerms,
  FINAL_CHARGE_CONSENT_TEXT,
  FINAL_CHARGE_CONSENT_VERSION,
} from "../order-review-terms";
import { originalFinalizationItems } from "../order-promise-finalization";
import { signStaffCartValue, STAFF_CART_AUTHORITY } from "../staff-cart-authority";
import {
  buildFinalizationLineSnapshot,
  PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE,
} from "../catch-weight-finalization";

jest.mock("../order-review-terms", () => ({
  ...jest.requireActual("../order-review-terms"),
  publishedSaleTerms: jest.fn(),
}));
const clone = (v: any) => JSON.parse(JSON.stringify(v));
function fixture() {
  const p = promiseFixture();
  const customer: any = { id: p.customer_id, metadata: {} };
  const actor: any = { id: "staff_fixture", metadata: { gp_staff_role: "office", staff_access_version: 1 } };
  const variant: any = {
    id: "variant_fixture",
    sku: "fixture-sku",
    title: "Fixture roast",
    metadata: {
      qbd_list_id: "8000-FIXTURE",
      pricing_mode: "per_lb",
      price_per_lb: 10,
      estimated_weight_each: 3,
    },
    product: { id: "prod_fixture", title: "Synthetic roast", metadata: {} },
  };
  const cart: any = {
    id: p.cart_id,
    customer_id: p.customer_id,
    email: p.contact.checkout_email,
    currency_code: "usd",
    completed_at: null,
    shipping_methods: [{ id: "sm_fixture", name: "Plant pickup" }],
    total: 91.25,
    item_total: 66.25,
    shipping_total: 25,
    tax_total: 6.25,
    discount_total: 0,
    shipping_address: { ...p.shipping_address, phone: p.contact.phone },
    billing_address: p.billing_address,
    items: [
      {
        id: "line_fixture",
        product_id: "prod_fixture",
        variant_id: "variant_fixture",
        quantity: 2,
        unit_price: 30,
        total: 66.25,
        subtotal: 60,
        tax_total: 6.25,
        metadata: {
          qbd_list_id: "FORGED",
          price_per_lb: 0.01,
          estimated_weight_each: 900,
          customer_title: "Injected title",
        },
      },
    ],
    metadata: {
      [RECEIPT_SNAPSHOT_KEY]: "gprs_fixture",
      fulfillmentCalendarTimezone: "America/New_York",
      [CALENDAR_ACCEPTED_KEY]: {
        cartId: p.cart_id,
        calendarRevision: "calendar-fixture",
        acceptedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        request: { mode: "plant_pickup", service: "PLANT_PICKUP" },
        choice: {
          arrivalDate: "2026-09-24",
          cutoffAt: new Date(Date.now() + 600000).toISOString(),
          window: { label: "10 am–noon" },
        },
      },
    },
  };
  let snapshot: any = null;
  const db = jest.fn((table: string) => {
    const builder: any = {};
    for (const name of ["where", "whereNull", "join", "select"])
      builder[name] = jest.fn(() => builder);
    builder.first = jest.fn(async () =>
      table === "gp_receipt_snapshot"
        ? { id: "gprs_fixture", email: p.contact.receipt_email }
        : snapshot
    );
    return builder;
  });
  const locking = { execute: jest.fn(async (_key, fn) => fn()) };
  const query = { graph: jest.fn(async () => ({ data: [clone(variant)] })) };
  const scope: any = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db;
      if (key === ContainerRegistrationKeys.QUERY) return query;
      if (key === Modules.CUSTOMER)
        return { retrieveCustomer: async (id: string) => clone(id === actor.id ? actor : customer) };
      if (key === ContainerRegistrationKeys.CONFIG_MODULE)
        return { projectConfig: { http: { jwtSecret: "synthetic-review-signing-secret" } } };
      if (key === Modules.LOCKING) return locking;
      throw new Error(`Unexpected ${key}`);
    },
  };
  return {
    p,
    cart,
    customer,
    actor,
    variant,
    scope,
    query,
    locking,
    setSnapshot: (s: any) => {
      snapshot = s;
    },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  (publishedSaleTerms as jest.Mock).mockResolvedValue({
    revision: "published-terms-v1",
    document: { Title: "Terms of Sale", Content: "Synthetic published terms" },
  });
});

test("catalog authority overrides injected line price, food weight, title and accounting identity", async () => {
  const f = fixture();
  const p = await trustedOrderPromise(f.scope, f.cart, "card", null);
  expect(p.lines[0]).toMatchObject({
    qbd_list_id: "8000-FIXTURE",
    customer_title: "Synthetic roast",
    rate_per_lb: 10,
    estimated_weight_lb: 6,
    estimated_unit_price: 30,
    estimated_line_total: 66.25,
  });
  expect(p.contact.receipt_email).toBe("receipt@example.invalid");
  expect(p.attribution.analytics_consent).toBeNull();
});
test.each(["role", "session", "version"])("native review rechecks current staff %s even after the request guard", async (change) => {
  const f = fixture();
  const now = Date.now(), sessionIat = Math.floor(now / 1000);
  f.cart.metadata[STAFF_CART_AUTHORITY] = signStaffCartValue({
    version: 1, cart_id: f.cart.id, source: "staff_impersonation", actor_id: f.actor.id,
    actor_email: null, actor_name: "Fixture", access_version: 1, session_iat: sessionIat,
    customer_id: f.customer.id, email: f.cart.email, payment_mode: "staff_impersonation",
    issued_at: now - 1000, expires_at: now + 600000,
  }, "synthetic-review-signing-secret");
  await expect(trustedOrderPromise(f.scope, f.cart, "card", null)).resolves.toBeDefined();
  if (change === "role") f.actor.metadata.staff_access_revoked = true;
  if (change === "session") f.actor.metadata.staff_access_valid_after = sessionIat;
  if (change === "version") f.actor.metadata.staff_access_version = 2;
  await expect(trustedOrderPromise(f.scope, f.cart, "card", null)).rejects.toMatchObject({ code: "order_review_cart_unavailable", status: 403 });
});
test("explicit zero totals survive finalization rather than falling back to a subtotal", async () => {
  const f = fixture();
  f.cart.items[0].total = 0;
  f.cart.total = 0;
  const p = await trustedOrderPromise(f.scope, f.cart, "card", false);
  const nativeOrder = {
    items: [
      {
        id: "orderline",
        variant_id: "variant_fixture",
        product_id: "prod_fixture",
        quantity: 2,
        metadata: { gp_order_promise_cart_line_id: "line_fixture" },
      },
    ],
  };
  const item = originalFinalizationItems(nativeOrder, p)[0];
  expect(
    buildFinalizationLineSnapshot({ id: "order_fixture" }, item, "fin")
      .estimated_line_total
  ).toBe(0);
  expect(p.placement_total).toBe(0);
});
test.each([undefined, null, NaN])(
  "missing or invalid copied cart totals cannot become zero: %s",
  async (value) => {
    const f = fixture();
    f.cart.total = value;
    await expect(
      trustedOrderPromise(f.scope, f.cart, "card", false)
    ).rejects.toThrow();
  }
);
test("a new timestamp does not invalidate the same calendar promise", async () => {
  const f = fixture(),
    before = await trustedOrderPromise(f.scope, f.cart, "card", false);
  f.cart.metadata[CALENDAR_ACCEPTED_KEY].acceptedAt = "2030-01-01T00:00:00Z";
  expect(
    orderPromiseHash(await trustedOrderPromise(f.scope, f.cart, "card", false))
  ).toBe(orderPromiseHash(before));
});
test("the completion hook rejects a mutation of the exact copied cart even if catalog queries are unchanged", async () => {
  const f = fixture(),
    promise = await trustedOrderPromise(f.scope, f.cart, "card", false),
    line = promise.lines[0];
  Object.assign(f.cart.items[0].metadata, {
    gp_order_promise_cart_line_id: line.cart_line_id,
    qbd_list_id: line.qbd_list_id,
    customer_title: line.customer_title,
    pricing_mode: line.pricing_mode,
    price_per_lb: line.rate_per_lb,
    estimated_weight_each: 3,
  });
  Object.assign(f.cart.metadata, {
    [ORDER_PROMISE_KEY]: "gpos_fixture",
    payment_workflow: PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE,
    final_charge_consent_version: FINAL_CHARGE_CONSENT_VERSION,
    final_charge_consent_text: FINAL_CHARGE_CONSENT_TEXT,
  });
  f.setSnapshot({
    id: "gpos_fixture",
    review_id: "gpor_fixture",
    promise,
    content_hash: orderPromiseHash(promise),
    expires_at: new Date(Date.now() + 600000),
    cart_metadata: f.cart.metadata,
  });
  await expect(
    validateCheckoutReview(f.scope, clone(f.cart))
  ).resolves.toBeUndefined();
  const stale = clone(f.cart);
  stale.shipping_address.address_1 = "2 Changed Road";
  await expect(validateCheckoutReview(f.scope, stale)).rejects.toThrow(
    "order_acceptance_changed"
  );
  stale.shipping_address = f.cart.shipping_address;
  stale.items[0].metadata.qbd_list_id = "FORGED";
  await expect(validateCheckoutReview(f.scope, stale)).rejects.toThrow(
    "order_acceptance_changed"
  );
});
test("an invoice approval without actual account terms does not get Net 10", async () => {
  const f = fixture();
  f.customer.metadata.gp_offline_payment_approved = true;
  await expect(
    trustedOrderPromise(f.scope, f.cart, "invoice", null)
  ).rejects.toMatchObject({ code: "order_review_invoice_terms_unavailable" });
});
test("unknown experiment versions stay unknown and do not acquire PII", async () => {
  const f = fixture();
  f.cart.items[0].metadata.experiment_context = {
    home: {
      variant_key: "b",
      assignment_id: "assignment-1",
      user_id: "private-person",
    },
  };
  const p = await trustedOrderPromise(f.scope, f.cart, "card", null);
  expect(p.attribution.experiment_assignments).toEqual([
    {
      experiment_id: "home",
      variant: "b",
      assignment_id: "assignment-1",
      version: null,
      evaluation_version: null,
    },
  ]);
  expect(p.attribution.experiment_context_status).toBe("unverified");
});
test("missing or changed published terms stop review", async () => {
  const f = fixture();
  (publishedSaleTerms as jest.Mock).mockRejectedValue(
    new OrderPromiseError("order_review_terms_unavailable", 503)
  );
  await expect(
    trustedOrderPromise(f.scope, f.cart, "card", false)
  ).rejects.toMatchObject({ code: "order_review_terms_unavailable" });
});
test("trusted checkout snapshots issued experiment evidence without changing money or consent", async () => {
  const priorKeys = process.env.GP_EXPERIMENT_EVIDENCE_KEYS;
  try {
    process.env.GP_EXPERIMENT_EVIDENCE_KEYS = JSON.stringify({ "fixture-key": experimentFixture.secret });
    const f = fixture();
    Object.assign(f.cart.items[0].metadata, clone(experimentFixture.metadata));
    const known = await trustedOrderPromise(f.scope, f.cart, "card", true);
    expect(known.attribution).toMatchObject({ analytics_consent: true, experiment_context_status: "complete", experiment_assignments: [{ version: experimentFixture.issued.version }] });
    f.cart.items[0].metadata.experiment_context.synthetic_launch.version_signature = "tampered";
    const unknown = await trustedOrderPromise(f.scope, f.cart, "card", false);
    expect(unknown.attribution).toMatchObject({ analytics_consent: false, experiment_context_status: "unverified", experiment_assignments: [{ version: null }] });
    expect(unknown.placement_total).toBe(known.placement_total);
    expect(unknown.lines).toEqual(known.lines);
    expect(unknown.fulfillment).toEqual(known.fulfillment);
  } finally {
    if (priorKeys === undefined) delete process.env.GP_EXPERIMENT_EVIDENCE_KEYS; else process.env.GP_EXPERIMENT_EVIDENCE_KEYS = priorKeys;
  }
});
test("public review contains customer details but no internal evidence/costs/identities", () => {
  const view = publicOrderReview({
    id: "gpor_fixture",
    expires_at: new Date(),
    promise: promiseFixture(),
  });
  expect(view.lines[0].title).toBe("Synthetic roast");
  for (const privateValue of [
    "8000-FIXTURE",
    "gprs_fixture",
    "synthetic-packing-plan",
    "synthetic-calendar-quote",
    "sale_terms_document",
    "assignment_id",
  ])
    expect(JSON.stringify(view)).not.toContain(privateValue);
});
test("only the owned customer or middleware-verified staff cart can view a review", async () => {
  const f = fixture();
  await expect(
    assertReviewOwner(
      { auth_context: { actor_id: "other" }, headers: {} } as any,
      f.cart
    )
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    assertReviewOwner(
      { auth_context: { actor_id: f.cart.customer_id }, headers: {} } as any,
      f.cart
    )
  ).resolves.toMatchObject({ staff: false });
  await expect(
    assertReviewOwner(
      {
        auth_context: { actor_id: "staff" },
        headers: { "x-gp-staff-authorization": "signed-by-middleware" },
        gp_staff_cart: { customer_id: f.cart.customer_id, cart_id: f.cart.id },
      } as any,
      f.cart
    )
  ).resolves.toMatchObject({ staff: true });
});
test("review preparation uses the native cart lock key", async () => {
  const f = fixture(),
    job = jest.fn(async () => "result");
  expect(await withReviewCartLock(f.scope, f.cart.id, job)).toBe("result");
  expect(f.locking.execute).toHaveBeenCalledWith(f.cart.id, job, {
    timeout: 120,
  });
});
test("later catalog metadata cannot rewrite accepted finalization identities or prices", () => {
  const p = promiseFixture();
  const order = {
    items: [
      {
        id: "orderline",
        variant_id: "variant_fixture",
        product_id: "prod_fixture",
        quantity: 2,
        metadata: {
          gp_order_promise_cart_line_id: "line_fixture",
          price_per_lb: 999,
          qbd_list_id: "NEW",
        },
      },
    ],
  };
  const line = buildFinalizationLineSnapshot(
    { id: "order_fixture" },
    originalFinalizationItems(order, p)[0],
    "fin"
  );
  expect(line).toMatchObject({
    qbd_list_id: "8000-FIXTURE",
    unit_price: 10,
    ordered_quantity: 2,
    estimated_line_total: 60,
  });
  order.items[0].quantity = 3;
  expect(() => originalFinalizationItems(order, p)).toThrow(
    "order_promise_amendment_required"
  );
});
