import { completeCartWorkflow } from "@medusajs/core-flows";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { bindOrderPromise, OrderPromiseError } from "./order-promise";
import { ensureFinalizationForOrder } from "./catch-weight-finalization";

/** Keep the native return object intact: order IDs alone are not completion
 * evidence. If binding fails, replay this same cart; never create a replacement. */
export async function completeReviewedCart(scope: any, cartId: string) {
  const completion = await completeCartWorkflow(scope).run({
    input: { id: cartId },
    context: { transactionId: cartId },
    throwOnError: false,
  });
  if (!completion.errors?.length) {
    try {
      await bindOrderPromise(
        scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        cartId,
        completion
      );
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
      await ensureFinalizationForOrder(
        scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        data[0]
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
