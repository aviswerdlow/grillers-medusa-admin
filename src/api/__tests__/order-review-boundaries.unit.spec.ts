import { POST as nativeComplete } from "@medusajs/medusa/api/store/carts/[id]/complete/route";
import { OrderPromiseError } from "../../lib/order-promise";
import {
  GET as capability,
  POST as review,
} from "../store/carts/[id]/order-review/route";
import { POST as complete } from "../store/carts/[id]/complete/route";
import { enforceStaffCapabilities } from "../middlewares/staff-capabilities";
import {
  acceptCheckoutReview,
  assertReviewOwner,
  issueCheckoutReview,
  reviewCart,
} from "../../lib/order-review-checkout";
import { completeReviewedCart } from "../../lib/order-review-completion";
import { resolveStaffPrincipal } from "../../lib/staff-principal";

jest.mock("../../lib/order-review-checkout", () => ({
  ...jest.requireActual("../../lib/order-review-checkout"),
  acceptCheckoutReview: jest.fn(),
  assertReviewOwner: jest.fn(),
  issueCheckoutReview: jest.fn(),
  reviewCart: jest.fn(),
}));
jest.mock("../../lib/order-review-completion", () => ({
  completeReviewedCart: jest.fn(),
}));
jest.mock("../../lib/staff-principal", () => ({
  ...jest.requireActual("../../lib/staff-principal"),
  resolveStaffPrincipal: jest.fn(),
}));

jest.mock("@medusajs/medusa/api/store/carts/[id]/complete/route", () => ({
  POST: jest.fn(),
}));
const priorMode = process.env.GP_ORDER_REVIEW_ENFORCEMENT;
afterEach(() => {
  if (priorMode === undefined) delete process.env.GP_ORDER_REVIEW_ENFORCEMENT;
  else process.env.GP_ORDER_REVIEW_ENFORCEMENT = priorMode;
});
const requestId = "a132a101-8f66-499f-89ca-aaff039fb523";
function fixture() {
  const req: any = {
    body: {
      action: "review",
      payment_mode: "card",
      request_id: requestId,
      analytics_consent: true,
    },
    headers: {},
    params: { id: "cart_fixture" },
    scope: {},
  };
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res };
}
beforeEach(() => {
  jest.resetAllMocks();
  process.env.GP_ORDER_REVIEW_ENFORCEMENT = "required";
  (reviewCart as jest.Mock).mockResolvedValue({
    id: "cart_fixture",
    customer_id: "customer_fixture",
    completed_at: null,
  });
  (assertReviewOwner as jest.Mock).mockResolvedValue({
    customerId: "customer_fixture",
    staff: false,
  });
  (issueCheckoutReview as jest.Mock).mockResolvedValue({
    id: "review_fixture",
  });
});

test("review input cannot supply amounts or the private promise", async () => {
  const { req, res } = fixture();
  req.body.promise = { placement_total: 0 };
  await review(req, res);
  expect(res.status).toHaveBeenCalledWith(422);
  expect(reviewCart).not.toHaveBeenCalled();
});
test("customer requests cannot choose staff immediate collection", async () => {
  const { req, res } = fixture();
  req.body.payment_mode = "card_at_placement";
  await review(req, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(issueCheckoutReview).not.toHaveBeenCalled();
});
test("staff browser analytics consent is not attributed to the customer", async () => {
  const { req, res } = fixture();
  (assertReviewOwner as jest.Mock).mockResolvedValue({
    customerId: "customer_fixture",
    staff: true,
  });
  await review(req, res);
  expect(issueCheckoutReview).toHaveBeenCalledWith(
    req.scope,
    "cart_fixture",
    "customer_fixture",
    "card",
    null,
    requestId
  );
});
test("recovery cannot create an order from an uncompleted cart", async () => {
  const { req, res } = fixture();
  req.body = { ...req.body, action: "recover", review_id: "review_fixture" };
  await review(req, res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(acceptCheckoutReview).not.toHaveBeenCalled();
  expect(completeReviewedCart).not.toHaveBeenCalled();
});
test("completed recovery still validates the original receipt before native replay", async () => {
  const { req, res } = fixture();
  req.body = { ...req.body, action: "recover", review_id: "review_fixture" };
  (reviewCart as jest.Mock).mockResolvedValue({
    id: "cart_fixture",
    completed_at: new Date(),
  });
  (completeReviewedCart as jest.Mock).mockResolvedValue({
    result: { id: "order_fixture" },
    errors: [],
  });
  await review(req, res);
  expect(
    (acceptCheckoutReview as jest.Mock).mock.invocationCallOrder[0]
  ).toBeLessThan(
    (completeReviewedCart as jest.Mock).mock.invocationCallOrder[0]
  );
  expect(res.json).toHaveBeenCalledWith({ order_id: "order_fixture" });
});
test("native customer completion cannot bypass reviewed saved-card or invoice checkout", async () => {
  const { req, res } = fixture();
  await complete(req, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(completeReviewedCart).not.toHaveBeenCalled();
});
test("staff native completion needs the accepted review identifiers", async () => {
  const { req, res } = fixture();
  (assertReviewOwner as jest.Mock).mockResolvedValue({
    customerId: "customer_fixture",
    staff: true,
  });
  req.gp_staff_cart = { payment_mode: "collect_card_now" };
  await complete(req, res);
  expect(res.status).toHaveBeenCalledWith(422);
  expect(completeReviewedCart).not.toHaveBeenCalled();
});
test.each([
  "/admin/orders",
  "/admin/draft-orders",
  "/admin/draft-orders/draft_fixture/convert-to-order",
])(
  "even operator access cannot create an unreviewed order through %s",
  async (path) => {
    const { req, res } = fixture();
    req.path = path;
    req.method = "POST";
    const next = jest.fn();
    (resolveStaffPrincipal as jest.Mock).mockResolvedValue({
      kind: "operator",
    });
    await enforceStaffCapabilities(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  }
);

test("default-off review reports 404 only after owner verification, with an explicit capability", async () => {
  delete process.env.GP_ORDER_REVIEW_ENFORCEMENT;
  const { req, res } = fixture();
  await review(req, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(assertReviewOwner).toHaveBeenCalled();
  expect(issueCheckoutReview).not.toHaveBeenCalled();
  await capability(req, res);
  expect(res.json).toHaveBeenCalledWith({ enforcement: "off" });
});
test("owner rejection never becomes the fallback 404", async () => {
  process.env.GP_ORDER_REVIEW_ENFORCEMENT = "off";
  (assertReviewOwner as jest.Mock).mockRejectedValue(
    new OrderPromiseError("order_review_cart_unavailable", 403)
  );
  const { req, res } = fixture();
  await review(req, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(issueCheckoutReview).not.toHaveBeenCalled();
});
test("default-off native completion preserves the original handler and envelope", async () => {
  delete process.env.GP_ORDER_REVIEW_ENFORCEMENT;
  const { req, res } = fixture();
  (nativeComplete as jest.Mock).mockResolvedValue("native-fixture-response");
  expect(await complete(req, res)).toBe("native-fixture-response");
  expect(nativeComplete).toHaveBeenCalledWith(req, res);
  expect(completeReviewedCart).not.toHaveBeenCalled();
});
test("rolling back cannot downgrade an accepted promise or an explicit review request", async () => {
  process.env.GP_ORDER_REVIEW_ENFORCEMENT = "off";
  const { req, res } = fixture();
  (reviewCart as jest.Mock).mockResolvedValue({
    id: "cart_fixture",
    metadata: { gp_order_promise_snapshot_id: "accepted_fixture" },
  });
  await capability(req, res);
  expect(res.json).toHaveBeenCalledWith({ enforcement: "required" });
  await complete(req, res);
  expect(nativeComplete).not.toHaveBeenCalled();
  (reviewCart as jest.Mock).mockResolvedValue({
    id: "cart_fixture",
    metadata: {},
  });
  req.headers["x-gp-order-review-id"] = "review_fixture";
  await complete(req, res);
  expect(nativeComplete).not.toHaveBeenCalled();
});
test("off mode leaves native admin creation to the existing staff permission check", async () => {
  process.env.GP_ORDER_REVIEW_ENFORCEMENT = "off";
  const { req, res } = fixture();
  req.path = "/admin/draft-orders";
  req.method = "POST";
  (resolveStaffPrincipal as jest.Mock).mockResolvedValue({ kind: "operator" });
  const next = jest.fn();
  await enforceStaffCapabilities(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
});
