import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import GpAnalyticsProviderService from "../modules/gp-analytics/service"
import { deliverCustomerMeasurements } from "../lib/customer-measurement"
import { evaluateFlowsForEvent } from "../lib/communications/flows"
import { pinRehearsalRoute } from "../lib/order-publication-rehearsal"
import { emitOpsAlert } from "../lib/ops-alert"

export default async function gpCustomerMeasurement(
  container: MedusaContainer
) {
  if (process.env.GP_CUSTOMER_MEASUREMENT_ENABLED !== "true") return
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = container.resolve("logger")
  const analytics = new GpAnalyticsProviderService(
    { logger },
    {
      jitsuHost: process.env.JITSU_HOST || "",
      jitsuServerSecret: process.env.JITSU_SERVER_SECRET || "",
      gpAnalyticsEndpoint: process.env.GP_ANALYTICS_ENDPOINT,
      gpAnalyticsServerKey: process.env.GP_ANALYTICS_SERVER_KEY,
      gpAnalyticsDualRun: process.env.GP_ANALYTICS_DUAL_RUN !== "false",
      rehearsal:
        process.env.GP_ORDER_REHEARSAL_ENABLED === "true"
          ? {
              id: process.env.GP_REHEARSAL_ID,
              jitsuHost: process.env.GP_REHEARSAL_JITSU_HOST,
              jitsuServerSecret: process.env.GP_REHEARSAL_JITSU_SERVER_SECRET,
              gpAnalyticsEndpoint: process.env.GP_REHEARSAL_ANALYTICS_ENDPOINT,
              gpAnalyticsServerKey:
                process.env.GP_REHEARSAL_ANALYTICS_SERVER_KEY,
            }
          : undefined,
    }
  )
  const summary = await deliverCustomerMeasurements(
    db,
    async (target, snapshot, row, trx) => {
      const c = snapshot.context
      if (target === "native_customer_automation") {
        if (c.test_order)
          return { status: "excluded", reason: "test_customer_event" }
        await evaluateFlowsForEvent(trx, row)
        return { status: "accepted" }
      }
      const transport =
        target === "native_customer_jitsu" ? "jitsu" : "gp_analytics"
      if (c.test_order) {
        const route = analytics.publicationRehearsalRoute(
          `${transport}_rehearsal`
        )
        if (!route || route.id !== c.rehearsal_id)
          return {
            status: "held",
            reason: "original_rehearsal_route_unavailable",
          }
        if (
          !(await pinRehearsalRoute(trx, `${transport}_rehearsal`, route.hash))
        )
          return { status: "held", reason: "rehearsal_route_changed" }
      }
      return analytics.deliverCustomerMeasurement(
        c.test_order ? `${transport}_rehearsal` : transport,
        {
          event: snapshot.event_name,
          actor_id: snapshot.customer_id,
          properties: {
            ...c,
            customer_id: snapshot.customer_id,
            test_event: c.test_order,
            source: "medusa-server",
            idempotency_key: snapshot.event_id,
            event_timestamp_ms: Date.parse(snapshot.occurred_at),
          },
        }
      )
    }
  )
  if (summary.held || summary.retry) {
    logger.warn(`[customer-measurement] ${JSON.stringify(summary)}`)
    // Rehearsal failures must not wake the production alert pipeline.
    if (
      summary.production_pending &&
      (process.env.STRIPE_API_KEY || "").startsWith("sk_live_")
    )
      await emitOpsAlert({
        alertKind: "customer_measurement_pending",
        severity: "warn",
        title: "Customer measurement has pending delivery",
        path: "src/jobs/gp-customer-measurement.ts",
        source: "medusa-server",
        logger,
        meta: summary,
      })
  }
}
export const config = {
  name: "gp-customer-measurement",
  schedule: "*/1 * * * *",
}
