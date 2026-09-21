import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  refundConfiguration,
  refundReadClient,
} from "../lib/stripe-refund-evidence";
import { reconcileRefunds } from "../lib/refund-provider";
import { emitOpsAlert } from "../lib/ops-alert";

export default async function gpRefundReconciliation(
  container: MedusaContainer
) {
  if (process.env.GP_REFUND_RECONCILIATION_ENABLED !== "true") return;
  const logger = container.resolve("logger");
  try {
    const { key, scope } = refundConfiguration(process.env);
    const summary = await reconcileRefunds(
      container.resolve(ContainerRegistrationKeys.PG_CONNECTION),
      scope,
      refundReadClient(key)
    );
    if (
      summary.observed ||
      summary.held ||
      summary.attention ||
      summary.readFailures
    )
      logger.info(`[refund-reconciliation] ${JSON.stringify(summary)}`);
    if (summary.held || summary.attention || summary.readFailures)
      await emitOpsAlert({
        alertKind: "refund_reconciliation_pending",
        severity: "warn",
        title: "Refund outcome or order linkage needs reconciliation",
        source: "medusa-server",
        path: "src/jobs/gp-refund-reconciliation.ts",
        logger,
        meta: summary,
      });
  } catch {
    await emitOpsAlert({
      alertKind: "refund_reconciliation_unavailable",
      severity: "warn",
      title: "Refund reconciliation unavailable; evidence retained",
      source: "medusa-server",
      path: "src/jobs/gp-refund-reconciliation.ts",
      logger,
    }).catch(() => undefined);
    throw new Error("refund_reconciliation_unavailable");
  }
}
export const config = {
  name: "gp-refund-reconciliation",
  schedule: "* * * * *",
};
