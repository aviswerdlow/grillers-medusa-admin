import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import GpAnalyticsProviderService from "../modules/gp-analytics/service";
import {
  deliverOrderPublications,
  materializeOrderPublications,
  publicationEpoch,
  reconcileOrderPublications,
} from "../lib/order-publication";
import { deliverPublicationToCommunications } from "../lib/order-publication-communications";
import { emitOpsAlert } from "../lib/ops-alert";

export default async function gpOrderPublication(container: MedusaContainer) {
  if (process.env.GP_ORDER_PUBLICATION_ENABLED !== "true") return;
  const logger = container.resolve("logger");
  try {
    const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const starts = await publicationEpoch(
      db,
      process.env.GP_ORDER_PUBLICATION_START_AT
    );
    await reconcileOrderPublications(db, starts);
    const evidence = await materializeOrderPublications(db, starts);
    const analytics = new GpAnalyticsProviderService(
      { logger },
      {
        jitsuHost: process.env.JITSU_HOST || "",
        jitsuServerSecret: process.env.JITSU_SERVER_SECRET || "",
        gpAnalyticsEndpoint: process.env.GP_ANALYTICS_ENDPOINT,
        gpAnalyticsServerKey: process.env.GP_ANALYTICS_SERVER_KEY,
        gpAnalyticsDualRun: process.env.GP_ANALYTICS_DUAL_RUN !== "false",
      }
    );
    const delivery = await deliverOrderPublications(
      db,
      async (claim) => {
        if (
          claim.target === "communications" ||
          claim.target === "communications_automation"
        )
          return deliverPublicationToCommunications(db, claim);
        return analytics.deliverOrderPublication(claim.target, {
          event:
            claim.kind === "placed" ? "order_completed" : "order_finalized",
          actor_id: claim.actor_id,
          properties: claim.properties,
        });
      },
      new Date(),
      10
    );
    const summary = { ...evidence, ...delivery };
    if (Object.values(summary).some(Boolean))
      logger.info(`[order-publication] ${JSON.stringify(summary)}`);
    if (summary.waiting || summary.held || summary.retry)
      await emitOpsAlert({
        alertKind: "order_publication_pending",
        severity: "warn",
        title: "Order publication has unresolved evidence or delivery",
        path: "src/jobs/gp-order-publication.ts",
        source: "medusa-server",
        logger,
        meta: summary,
      });
  } catch {
    logger.error(
      "Order publication worker unavailable; durable intents and receipts retained"
    );
    await emitOpsAlert({
      alertKind: "order_publication_worker_failed",
      severity: "warn",
      title: "Order publication worker unavailable",
      path: "src/jobs/gp-order-publication.ts",
      source: "medusa-server",
      logger,
    }).catch(() => undefined);
    throw new Error("order_publication_worker_unavailable");
  }
}
export const config = { name: "gp-order-publication", schedule: "* * * * *" };
