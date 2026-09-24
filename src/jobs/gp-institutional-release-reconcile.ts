import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../lib/ops-alert"
import { reconcileInstitutionalReleaseIntent } from "../lib/gp-institutional-release-intent"

/** Read canonical order state before retrying an uncertain release. The job is
 * dormant until the institutional flag is explicitly enabled.
 */
export default async function gpInstitutionalReleaseReconcile(container: MedusaContainer) {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") return
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = container.resolve(Modules.ORDER)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const rows = await db("gp_order_finalization")
    .select("order_id")
    .whereNull("deleted_at")
    .whereRaw("metadata->'gp_institutional_release_intent'->>'status' = 'prepared'")
    .orderBy("updated_at", "asc")
    .limit(25)
  for (const row of rows) {
    try {
      const result = await reconcileInstitutionalReleaseIntent({
        db, orderModule, orderId: row.order_id,
      })
      if (result.status !== "applied") {
        await emitOpsAlert({
          alertKind: "institutional_release_reconciliation_hold",
          severity: "page",
          path: "src/jobs/gp-institutional-release-reconcile.ts",
          title: "Institutional invoice release needs reconciliation",
          fingerprint: `institutional_release:${result.status}:${result.reason}`,
          meta: { order_id: row.order_id, status: result.status, reason: result.reason },
          logger,
        })
      }
    } catch (error) {
      logger.error(`[institutional-release] reconciliation failed for order=${row.order_id}`)
      await emitOpsAlert({
        alertKind: "institutional_release_reconciliation_failed",
        severity: "page",
        path: "src/jobs/gp-institutional-release-reconcile.ts",
        title: "Institutional invoice release reconciliation failed",
        meta: { order_id: row.order_id },
        logger,
      })
    }
  }
}

export const config = {
  name: "gp-institutional-release-reconcile",
  schedule: "*/5 * * * *",
}
