import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { requestOrderPublication } from "../../lib/order-publication";
import { emitOpsAlert } from "../../lib/ops-alert";

/** Native events can precede successful completion binding. Persist intent;
 * the independent publisher waits for original evidence and retries sinks. */
export default async function orderPlacedHandler({
  event: { name, data },
  container,
}: SubscriberArgs<{
  id: string;
  order_id?: string;
  finalization_id?: string;
}>) {
  const logger = container.resolve("logger");
  try {
    const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    await requestOrderPublication(
      db,
      name === "order.final_charge_succeeded" ? "finalized" : "placed",
      data.order_id || data.id,
      data.finalization_id
    );
  } catch {
    logger.error(
      "Order publication intent was not recorded; subscriber retry required"
    );
    await emitOpsAlert({
      alertKind: "order_publication_intent_failed",
      severity: "warn",
      title: "Order publication intent was not recorded",
      path: "src/subscribers/analytics/order-placed.ts",
      source: "medusa-server",
      logger,
    }).catch(() => undefined);
    // Event delivery retry is independent of checkout. The bound-order scan is
    // an additional recovery path if the native event retry is exhausted.
    throw new Error("order_publication_intent_not_recorded");
  }
}
export const config: SubscriberConfig = {
  event: ["order.placed", "order.final_charge_succeeded"],
};
