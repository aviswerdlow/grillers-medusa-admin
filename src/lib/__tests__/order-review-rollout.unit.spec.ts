import {
  orderReviewEnforcementMode,
  requiresOrderReview,
} from "../order-review-rollout";
import { validateCheckoutReview } from "../order-review-checkout";
const prior = process.env.GP_ORDER_REVIEW_ENFORCEMENT;
afterEach(() => {
  if (prior === undefined) delete process.env.GP_ORDER_REVIEW_ENFORCEMENT;
  else process.env.GP_ORDER_REVIEW_ENFORCEMENT = prior;
});
test.each([undefined, "", "off", " OFF "])(
  "mode %s preserves old checkout without accessing the new ledger",
  async (mode) => {
    if (mode === undefined) delete process.env.GP_ORDER_REVIEW_ENFORCEMENT;
    else process.env.GP_ORDER_REVIEW_ENFORCEMENT = mode;
    const resolve = jest.fn(() => {
      throw new Error("No review database should be needed");
    });
    expect(orderReviewEnforcementMode()).toBe("off");
    await expect(
      validateCheckoutReview({ resolve }, { id: "cart_fixture", metadata: {} })
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  }
);
test.each(["required", "typo"])(
  "mode %s refuses unreviewed native completion",
  async (mode) => {
    process.env.GP_ORDER_REVIEW_ENFORCEMENT = mode;
    expect(orderReviewEnforcementMode()).toBe("required");
    await expect(
      validateCheckoutReview(
        { resolve: () => jest.fn() },
        { id: "cart_fixture", customer_id: "customer_fixture" }
      )
    ).rejects.toMatchObject({ code: "order_review_required" });
  }
);
test.each(["gpos_fixture", "", 7])(
  "an accepted or malformed pointer cannot be downgraded: %s",
  (value) => {
    process.env.GP_ORDER_REVIEW_ENFORCEMENT = "off";
    expect(
      requiresOrderReview({ metadata: { gp_order_promise_snapshot_id: value } })
    ).toBe(true);
  }
);
