import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import GpAnalyticsProviderService from "../modules/gp-analytics/service"
import {
  deliverCartMeasurements,
  cartMeasurementProperties,
} from "../lib/cart-measurement"
import {
  projectNativeCartActivity,
  cartRecoveryAllowed,
} from "../lib/communications/cart-lifecycle"
import { evaluateFlowsForEvent } from "../lib/communications/flows"
import { pinRehearsalRoute } from "../lib/order-publication-rehearsal"
import { emitOpsAlert } from "../lib/ops-alert"

export default async function gpCartMeasurement(container: MedusaContainer) {
  if (process.env.GP_CART_MEASUREMENT_ENABLED !== "true") return
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
  const summary = await deliverCartMeasurements(
    db,
    async (target, snapshot, row, trx) => {
      const c = snapshot.context
      if (target === "native_cart_automation") {
        if (snapshot.lane !== "production")
          return { status: "excluded", reason: "nonproduction_cart_source" }
        if (snapshot.kind === "activity")
          return projectNativeCartActivity(trx, snapshot, row)
        if (!(await cartRecoveryAllowed(trx, row)))
          return { status: "excluded", reason: "cart_recovery_not_permitted" }
        await evaluateFlowsForEvent(trx, row)
        return { status: "accepted" }
      }
      if (!c?.analytics_consent)
        return {
          status: "excluded",
          reason: "original_analytics_permission_unavailable",
        }
      const transport =
        target === "native_cart_jitsu" ? "jitsu" : "gp_analytics"
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
      return analytics.deliverCartMeasurement(
        c.test_order ? `${transport}_rehearsal` : transport,
        {
          event: snapshot.event_name,
          actor_id: snapshot.cart.customer_id || undefined,
          properties: {
            ...cartMeasurementProperties(snapshot),
            customer_id: snapshot.cart.customer_id,
            cart_id: snapshot.cart.id,
            test_event: c.test_order,
            source: "medusa-server",
            idempotency_key: snapshot.event_id,
            event_timestamp_ms: Date.parse(snapshot.occurred_at),
            native_cart_updated_at: snapshot.cart.native_updated_at,
            observation_type:
              snapshot.kind === "activity"
                ? "successful_native_response"
                : "derived_cart_lifecycle",
            item_count: snapshot.cart.item_count,
            value: snapshot.cart.value,
            currency: snapshot.cart.currency,
          },
        }
      )
    },
    new Date(),
    20
  )
  if (summary.held || summary.retry) {
    logger.warn(`[cart-measurement] ${JSON.stringify(summary)}`)
    if (
      summary.production_pending &&
      (process.env.STRIPE_API_KEY || "").startsWith("sk_live_")
    )
      await emitOpsAlert({
        alertKind: "cart_measurement_pending",
        severity: "warn",
        title: "Cart measurement has pending delivery",
        path: "src/jobs/gp-cart-measurement.ts",
        source: "medusa-server",
        logger,
        meta: summary,
      })
  }
}
export const config = { name: "gp-cart-measurement", schedule: "*/1 * * * *" }
