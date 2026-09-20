import { POST as review } from "../store/carts/[id]/order-review/route";
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
jest.mock("../../lib/order-review-completion", () => ({ completeReviewedCart: jest.fn() }));
jest.mock("../../lib/staff-principal", () => ({
  ...jest.requireActual("../../lib/staff-principal"),
  resolveStaffPrincipal: jest.fn(),
}));

const requestId = "a132a101-8f66-499f-89ca-aaff039fb523";
function fixture() {
  const req: any = {
    body: { action: "review", payment_mode: "card", request_id: requestId, analytics_consent: true },
    headers: {}, params: { id: "cart_fixture" }, scope: {},
  };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return { req, res };
}
beforeEach(() => {
  jest.resetAllMocks();
  (reviewCart as jest.Mock).mockResolvedValue({ id: "cart_fixture", customer_id: "customer_fixture", completed_at: null });
  (assertReviewOwner as jest.Mock).mockResolvedValue({ customerId: "customer_fixture", staff: false });
  (issueCheckoutReview as jest.Mock).mockResolvedValue({ id: "review_fixture" });
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
  (assertReviewOwner as jest.Mock).mockResolvedValue({ customerId: "customer_fixture", staff: true });
  await review(req, res);
  expect(issueCheckoutReview).toHaveBeenCalledWith(req.scope, "cart_fixture", "customer_fixture", "card", null, requestId);
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
  (reviewCart as jest.Mock).mockResolvedValue({ id: "cart_fixture", completed_at: new Date() });
  (completeReviewedCart as jest.Mock).mockResolvedValue({ result: { id: "order_fixture" }, errors: [] });
  await review(req, res);
  expect((acceptCheckoutReview as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((completeReviewedCart as jest.Mock).mock.invocationCallOrder[0]);
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
  (assertReviewOwner as jest.Mock).mockResolvedValue({ customerId: "customer_fixture", staff: true });
  req.gp_staff_cart = { payment_mode: "collect_card_now" };
  await complete(req, res);
  expect(res.status).toHaveBeenCalledWith(422);
  expect(completeReviewedCart).not.toHaveBeenCalled();
});
test.each(["/admin/orders", "/admin/draft-orders", "/admin/draft-orders/draft_fixture/convert-to-order"])("even operator access cannot create an unreviewed order through %s", async path => {
  const { req, res } = fixture();
  req.path = path; req.method = "POST";
  const next = jest.fn();
  (resolveStaffPrincipal as jest.Mock).mockResolvedValue({ kind: "operator" });
  await enforceStaffCapabilities(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
