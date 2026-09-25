import { hasOrderPromise } from "./order-review-rollout";
import { completeCartWorkflow } from "@medusajs/core-flows";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { bindOrderPromise, OrderPromiseError } from "./order-promise";
import { ensureFinalizationForOrder } from "./catch-weight-finalization";
import { withInstitutionalFinalizationWrite } from "./gp-institutional-finalization-lock";

/** Keep the native return object intact: order IDs alone are not completion
 * evidence. If binding fails, replay this same cart; never create a replacement. */
export async function completeReviewedCart(
  scope: any,
  cartId: string,
  options: { requireReview?: boolean } = {}
) {
  const completion = await completeCartWorkflow(scope).run({
    input: { id: cartId },
    context: { transactionId: cartId },
    throwOnError: false,
  });
  if (!completion.errors?.length) {
    try {
      const { data } = await scope
        .resolve(ContainerRegistrationKeys.QUERY)
        .graph({
          entity: "order",
          fields: [
            "id",
            "display_id",
            "customer_id",
            "email",
            "currency_code",
            "metadata",
            "items.*",
          ],
          filters: { id: completion.result.id },
        });
      if (!data?.[0]) throw new Error("Completed order unavailable");
      // A legacy request cannot bypass a promise accepted concurrently. Native
      // completion validates the exact cart again before any order is created.
      if (options.requireReview !== false || hasOrderPromise(data[0])) {
        await bindOrderPromise(
          scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
          cartId,
          completion
        );
      }
      await withInstitutionalFinalizationWrite(
        scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        data[0],
        (db) => ensureFinalizationForOrder(db, data[0]),
        { readReleased: true }
      );
    } catch {
      throw new OrderPromiseError(
        "order_review_completion_recovery_required",
        503
      );
    }
  }
  return completion;
}
