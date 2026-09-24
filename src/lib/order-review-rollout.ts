import { ORDER_PROMISE_KEY } from "./order-promise";

/** Backend-first releases preserve current checkout until coordinated activation.
 * A configured typo fails closed. Accepted promises remain immutable on rollback. */
export function orderReviewEnforcementMode(
  env = process.env
): "off" | "required" {
  const mode = env.GP_ORDER_REVIEW_ENFORCEMENT?.trim().toLowerCase();
  return !mode || mode === "off" ? "off" : "required";
}

export function hasOrderPromise(cart: any): boolean {
  return cart?.metadata?.[ORDER_PROMISE_KEY] != null;
}

export function requiresOrderReview(
  cart: any,
  request?: { review_id?: unknown; request_id?: unknown },
  env = process.env
): boolean {
  return (
    orderReviewEnforcementMode(env) === "required" ||
    hasOrderPromise(cart) ||
    request?.review_id != null ||
    request?.request_id != null
  );
}
