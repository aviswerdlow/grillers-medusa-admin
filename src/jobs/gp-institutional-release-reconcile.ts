import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../lib/ops-alert"
import { reconcileInstitutionalReleaseIntent } from "../lib/gp-institutional-release-intent"
import { reconcileInstitutionalPostingHandoff } from "../lib/gp-institutional-posting-handoff"
import { quarantineStaleInstitutionalReservations } from "../lib/gp-institutional-stale-reservations"

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

  // The release intent supplies the order/commitment identity. Once the
  // accounting callback says posted, bind that commitment to the exact QBD
  // invoice only after the protected bridge has read it back. Oldest checked
  // commitments rotate to the back so an unpaid invoice cannot starve newer
  // postings. No work is scheduled while the institutional flag is off.
  const due = await db.raw(`
    select f.order_id, c.id as commitment_id
    from gp_order_finalization f
    join gp_institutional_credit_commitment c
      on c.order_id = (f.metadata->'gp_institutional_release_intent'->>'commitmentId')
    where f.deleted_at is null and c.deleted_at is null
      and f.status = 'released_to_fulfillment'
      and (f.metadata->'gp_institutional_release_intent'->>'status') = 'applied'
      and c.state in ('accepted', 'posting', 'posted')
    order by c.updated_at asc, f.order_id asc
    limit 25
  `)
  if (!Array.isArray(due?.rows)) {
    throw new Error("Institutional posting handoff scan did not return rows")
  }
  for (const row of due.rows) {
    try {
      const order = await orderModule.retrieveOrder(row.order_id, {
        select: ["id", "cart_id", "customer_id", "metadata"],
      })
      const result = await reconcileInstitutionalPostingHandoff({ db, order })
      if (result.status === "quarantined") {
        await emitOpsAlert({
          alertKind: "institutional_posting_handoff_quarantined",
          severity: "page",
          path: "src/jobs/gp-institutional-release-reconcile.ts",
          title: "Institutional invoice posting needs reconciliation",
          fingerprint: `institutional_posting_handoff:${result.reason}`,
          meta: { order_id: row.order_id, reason: result.reason },
          logger,
        })
      }
    } catch {
      logger.error(`[institutional-posting] reconciliation failed for order=${row.order_id}`)
      await emitOpsAlert({
        alertKind: "institutional_posting_handoff_failed",
        severity: "page",
        path: "src/jobs/gp-institutional-release-reconcile.ts",
        title: "Institutional posting handoff failed",
        meta: { order_id: row.order_id },
        logger,
      })
    } finally {
      await db("gp_institutional_credit_commitment")
        .where({ id: row.commitment_id }).update({ updated_at: new Date() })
    }
  }

  try {
    const quarantinedCount = await quarantineStaleInstitutionalReservations(db)
    if (quarantinedCount === 0) return
    await emitOpsAlert({
      alertKind: "institutional_checkout_reservation_quarantined",
      severity: "page",
      path: "src/jobs/gp-institutional-release-reconcile.ts",
      title: "Stale institutional checkout reservations need review",
      fingerprint: "institutional_checkout_reservation_quarantined",
      meta: { quarantined_count: quarantinedCount },
      logger,
    })
  } catch {
    logger.error("[institutional-reservation] stale reservation reconciliation failed")
    await emitOpsAlert({
      alertKind: "institutional_checkout_reservation_reconciliation_failed",
      severity: "page",
      path: "src/jobs/gp-institutional-release-reconcile.ts",
      title: "Institutional checkout reservation reconciliation failed",
      logger,
    })
  }
}

export const config = {
  name: "gp-institutional-release-reconcile",
  schedule: "*/5 * * * *",
}
