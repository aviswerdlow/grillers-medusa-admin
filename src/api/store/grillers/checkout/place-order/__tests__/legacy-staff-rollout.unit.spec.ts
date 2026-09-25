import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { completeCartWorkflow, createPaymentSessionsWorkflow } from "@medusajs/core-flows";
import { acceptCheckoutReview } from "../../../../../../lib/order-review-checkout";
import { bindOrderPromise, ORDER_PROMISE_KEY } from "../../../../../../lib/order-promise";
import { checkInventoryAvailability } from "../../../../../../lib/inventory-allocation";
import { ensurePaymentSetup, SYSTEM_PAYMENT_PROVIDER_ID } from "../../../../../../lib/catch-weight-finalization";
import { assertPaymentMethodBelongsToCustomer } from "../../../../payment-methods/utils";
import { STAFF_CART_AUTHORITY } from "../../../../../../lib/staff-cart-authority";
import { POST } from "../route";

// Real payment-context authentication, cart ownership and locking adapter. Only
// provider/workflow/database side effects are synthetic; no live payment occurs.
jest.mock("@medusajs/core-flows", () => ({
  completeCartWorkflow: jest.fn(),
  createPaymentCollectionForCartWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}));
jest.mock("../../../../../../lib/ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../../../../payment-methods/utils", () => ({
  ...jest.requireActual("../../../../payment-methods/utils"),
  assertPaymentMethodBelongsToCustomer: jest.fn(async () => true),
}));
jest.mock("../../../../../../lib/inventory-allocation", () => ({
  ...jest.requireActual("../../../../../../lib/inventory-allocation"),
  checkInventoryAvailability: jest.fn(),
}));
jest.mock("../../../../../../lib/catch-weight-finalization", () => ({
  ...jest.requireActual("../../../../../../lib/catch-weight-finalization"),
  ensureFinalizationForOrder: jest.fn(async () => ({ finalization: { id: "fin_fixture", status: "pending_pack", estimated_order_total: 30 } })),
  ensurePaymentSetup: jest.fn(),
}));
jest.mock("../../../../../../lib/order-promise", () => ({
  ...jest.requireActual("../../../../../../lib/order-promise"),
  bindOrderPromise: jest.fn(),
}));
jest.mock("../../../../../../lib/order-review-checkout", () => ({
  ...jest.requireActual("../../../../../../lib/order-review-checkout"),
  acceptCheckoutReview: jest.fn(),
}));

const clone = (value: any) => JSON.parse(JSON.stringify(value));
const prior = { review: process.env.GP_ORDER_REVIEW_ENFORCEMENT, staff: process.env.GP_STAFF_BOUNDARY_MODE, institutional: process.env.GP_INSTITUTIONAL_TERMS_ENABLED };
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GP_ORDER_REVIEW_ENFORCEMENT;
  delete process.env.GP_STAFF_BOUNDARY_MODE;
  // These tests exercise the pre-existing invoice path and staff/cart guards.
  // The separate #370 route test proves invoice denial with this flag unset.
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true";
  (assertPaymentMethodBelongsToCustomer as jest.Mock).mockResolvedValue(true);
  (checkInventoryAvailability as jest.Mock).mockResolvedValue([{ variant_id: "variant_fixture", decision: "available" }]);
  (acceptCheckoutReview as jest.Mock).mockResolvedValue({ completed: false, snapshot: { promise: { terms: {
    payment_consent_version: "accepted-v1", payment_consent_text: "Accepted catch-weight terms", invoice_terms: "Net 10",
  } } } });
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("Unexpected external request in isolated checkout test"));
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [name, value] of [["GP_ORDER_REVIEW_ENFORCEMENT", prior.review], ["GP_STAFF_BOUNDARY_MODE", prior.staff], ["GP_INSTITUTIONAL_TERMS_ENABLED", prior.institutional]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
});

function fixture(lane: "card" | "invoice" = "card") {
  const staff: any = { id: "cus_office", email: "office@example.invalid", metadata: { gp_staff_role: "office" } };
  const customer: any = { id: "cus_buyer", email: "buyer@example.invalid", metadata: {
    gp_offline_payment_approved: true, gp_payment_terms: "Net 10", gp_credit_limit: 1000,
  }, account_holders: [{ id: "holder_buyer", provider_id: "pp_stripe_stripe", external_id: "cus_stripe_buyer" }] };
  const cart: any = { id: "cart_fixture", customer_id: staff.id, email: customer.email, total: 30, currency_code: "usd", completed_at: null,
    metadata: { source: "staff_impersonation", staff_target_customer_id: customer.id, staff_selected_customer_id: customer.id },
    items: [{ id: "line_fixture", variant_id: "variant_fixture", product_id: "prod_fixture", variant_sku: "retail-fixture", quantity: 1, metadata: { qbd_list_id: "8000-FIXTURE" } }],
  };
  const cartModule = {
    retrieveCart: jest.fn(async () => clone(cart)),
    updateCarts: jest.fn(async (_id, patch) => { Object.assign(cart, clone(patch)); return clone(cart); }),
  };
  const orderModule = { updateOrders: jest.fn(async () => undefined) };
  const query = { graph: jest.fn(async (input) => {
    if (input.entity === "customer") return { data: [clone(input.filters.id === staff.id ? staff : customer)] };
    if (input.entity === "cart") return { data: [clone(cart)] };
    if (input.entity === "order") return { data: input.filters.customer_id ? [] : [{ ...clone(cart), id: "order_fixture", cart_id: cart.id }] };
    throw new Error(`Unexpected graph entity ${input.entity}`);
  }) };
  let beforeLock: (() => void) | undefined;
  const locking = { execute: jest.fn(async (_key, fn) => { beforeLock?.(); return fn(); }) };
  const sessions = jest.fn(async (_input: any) => ({ result: {} }));
  const complete = jest.fn(async () => ({ errors: [], result: { id: "order_fixture" } }));
  (createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({ run: sessions });
  (completeCartWorkflow as unknown as jest.Mock).mockReturnValue({ run: complete });
  const req: any = {
    body: { cart_id: cart.id, ...(lane === "invoice" ? { payment_method: "invoice" } : { payment_method_id: "pm_buyer", consent_version: "legacy-v1", consent_text: "Legacy catch-weight consent" }) },
    headers: { "x-gp-staff-target-customer-id": customer.id },
    auth_context: { actor_type: "customer", actor_id: staff.id, iat: Math.floor(Date.now() / 1000) },
    scope: { resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.QUERY) return query;
      if (key === Modules.CART) return cartModule;
      if (key === Modules.ORDER) return orderModule;
      if (key === Modules.LOCKING) return locking;
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return {};
      if (key === ContainerRegistrationKeys.REMOTE_QUERY) return async () => [{ payment_collection: { id: "paycol_fixture" } }];
      if (key === ContainerRegistrationKeys.LOGGER) return { error: jest.fn(), warn: jest.fn() };
      throw new Error(`Unexpected service ${key}`);
    } },
  };
  const res: any = { status: jest.fn(function () { return this; }), json: jest.fn() };
  return { req, res, staff, customer, cart, cartModule, query, sessions, complete, locking, beforeLock: (fn: () => void) => { beforeLock = fn; } };
}
function noOrderEffects(f: ReturnType<typeof fixture>) {
  expect(f.cartModule.updateCarts).not.toHaveBeenCalled();
  expect(f.sessions).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
  expect(ensurePaymentSetup).not.toHaveBeenCalled();
}

it.each(["card", "invoice"] as const)("default-off completes legacy staff %s orders for the selected buyer", async (lane) => {
  const f = fixture(lane);
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(200);
  expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ type: "order", order: expect.objectContaining({ customer_id: f.customer.id, email: f.customer.email }) }));
  expect(f.cartModule.updateCarts).toHaveBeenCalledWith(f.cart.id, expect.objectContaining({ customer_id: f.customer.id, email: f.customer.email }));
  expect(f.locking.execute).toHaveBeenCalledWith(f.cart.id, expect.any(Function), { timeout: 120 });
  expect(checkInventoryAvailability).toHaveBeenCalledWith(expect.objectContaining({ customer_id: f.customer.id }));
  expect(f.sessions).toHaveBeenCalledWith({ input: expect.objectContaining({ customer_id: f.customer.id, provider_id: SYSTEM_PAYMENT_PROVIDER_ID }) });
  expect(f.sessions.mock.calls[0][0].input).not.toHaveProperty("amount");
  expect(acceptCheckoutReview).not.toHaveBeenCalled();
  expect(bindOrderPromise).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  if (lane === "card") {
    expect(assertPaymentMethodBelongsToCustomer).toHaveBeenCalledWith(f.req, expect.objectContaining({ id: f.customer.id }), "pm_buyer");
    expect(ensurePaymentSetup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: f.customer.id, customerEmail: f.customer.email, consentVersion: "legacy-v1", consentText: "Legacy catch-weight consent" }));
  } else {
    expect(ensurePaymentSetup).not.toHaveBeenCalled();
    expect(f.cart.metadata.payment_workflow).toBe("invoice_ar");
  }
});
it.each(["card", "invoice"] as const)("explicit off preserves a %s retry already transferred to the buyer", async (lane) => {
  process.env.GP_ORDER_REVIEW_ENFORCEMENT = "off";
  process.env.GP_STAFF_BOUNDARY_MODE = "log";
  const f = fixture(lane); f.cart.customer_id = f.customer.id;
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(200);
  expect(f.complete).toHaveBeenCalledTimes(1);
});
it("still requires the selected customer's invoice approval", async () => {
  const f = fixture("invoice"); f.customer.metadata.gp_offline_payment_approved = false;
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(403); noOrderEffects(f);
});
it("still requires a saved card belonging to the selected customer", async () => {
  const f = fixture(); (assertPaymentMethodBelongsToCustomer as jest.Mock).mockResolvedValueOnce(false);
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(400); noOrderEffects(f);
});
it("keeps ordinary customer checkout in the existing owned-cart path", async () => {
  const f = fixture(); f.req.headers = {}; f.req.auth_context.actor_id = f.customer.id;
  f.cart.customer_id = f.customer.id; f.cart.metadata = {};
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(200);
  expect(f.cartModule.updateCarts.mock.calls[0][1]).not.toHaveProperty("customer_id");
});
it.each([
  ["GP_ORDER_REVIEW_ENFORCEMENT", "required"], ["GP_ORDER_REVIEW_ENFORCEMENT", "typo"],
  ["GP_STAFF_BOUNDARY_MODE", "enforce"], ["GP_STAFF_BOUNDARY_MODE", "typo"],
])("%s=%s does not open the unsigned compatibility lane", async (key, value) => {
  process.env[key] = value; const f = fixture();
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(403); noOrderEffects(f);
});
it.each(["signed", "promise", "review_id", "request_id"])("%s cannot downgrade an office-owned cart to legacy checkout", async (kind) => {
  const f = fixture();
  if (kind === "signed") f.cart.metadata[STAFF_CART_AUTHORITY] = "invalid-signature";
  if (kind === "promise") f.cart.metadata[ORDER_PROMISE_KEY] = "gpos_existing";
  if (kind === "review_id") f.req.body.review_id = "gpor_existing";
  if (kind === "request_id") f.req.body.request_id = "48ed808a-c830-4c8f-979b-efb442eaf003";
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(403); noOrderEffects(f);
});
it.each(["third_party_owner", "staff_target_customer_id", "staff_selected_customer_id"])("rejects %s mismatch before payment work", async (kind) => {
  const f = fixture();
  if (kind === "third_party_owner") f.cart.customer_id = "cus_unrelated";
  else f.cart.metadata[kind] = "cus_unrelated";
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(403);
  expect(assertPaymentMethodBelongsToCustomer).not.toHaveBeenCalled(); noOrderEffects(f);
});
it.each(["revoked", "picker", "stale_session"])("%s staff cannot gain checkout authority from the target header", async (change) => {
  const f = fixture();
  if (change === "revoked") f.staff.metadata.staff_access_revoked = true;
  if (change === "picker") f.staff.metadata.gp_staff_role = "picker";
  if (change === "stale_session") f.staff.metadata.staff_access_valid_after = f.req.auth_context.iat;
  await POST(f.req, f.res);
  expect(f.res.status).not.toHaveBeenCalledWith(200);
  expect(assertPaymentMethodBelongsToCustomer).not.toHaveBeenCalled(); noOrderEffects(f);
});
for (const lane of ["card", "invoice"] as const) {
  it.each(["owner", "target", "signed", "promise", "completed", "review_mode", "staff_mode"])(`${lane} lock rejects concurrent %s changes before creating a payment session`, async (change) => {
    const f = fixture(lane);
    f.beforeLock(() => {
      if (change === "owner") f.cart.customer_id = "cus_unrelated";
      if (change === "target") f.cart.metadata.staff_selected_customer_id = "cus_unrelated";
      if (change === "signed") f.cart.metadata[STAFF_CART_AUTHORITY] = "new-signed-authority";
      if (change === "promise") f.cart.metadata[ORDER_PROMISE_KEY] = "gpos_new";
      if (change === "completed") f.cart.completed_at = new Date().toISOString();
      if (change === "review_mode") process.env.GP_ORDER_REVIEW_ENFORCEMENT = "required";
      if (change === "staff_mode") process.env.GP_STAFF_BOUNDARY_MODE = "enforce";
    });
    await POST(f.req, f.res);
    expect(f.res.status).toHaveBeenCalledWith(409); noOrderEffects(f);
  });
}
it("middleware-verified reviewed staff checkout keeps its accepted customer and email", async () => {
  const f = fixture(); process.env.GP_ORDER_REVIEW_ENFORCEMENT = "required";
  f.cart.customer_id = f.customer.id; f.cart.email = "accepted@example.invalid";
  f.cart.metadata[STAFF_CART_AUTHORITY] = "middleware-verified-token";
  f.req.headers["x-gp-staff-authorization"] = "middleware-verified-session";
  f.req.gp_staff_cart = { cart_id: f.cart.id, customer_id: f.customer.id };
  Object.assign(f.req.body, { review_id: "gpor_fixture", request_id: "48ed808a-c830-4c8f-979b-efb442eaf003", analytics_consent: true });
  await POST(f.req, f.res);
  expect(f.res.status).toHaveBeenCalledWith(200);
  expect(acceptCheckoutReview).toHaveBeenCalledWith(f.req.scope, f.cart.id, f.customer.id, expect.objectContaining({ analyticsConsent: null }), "card");
  expect(f.cartModule.updateCarts.mock.calls[0][1]).not.toHaveProperty("customer_id");
  expect(f.cartModule.updateCarts.mock.calls[0][1]).not.toHaveProperty("email");
  expect(f.cart.email).toBe("accepted@example.invalid");
  expect(bindOrderPromise).toHaveBeenCalledTimes(1);
});
