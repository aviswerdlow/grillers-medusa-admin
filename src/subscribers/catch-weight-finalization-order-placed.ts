import { ORDER_PROMISE_KEY } from "../lib/order-promise"
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  CATCH_WEIGHT_ORDER_FIELDS,
  ensureFinalizationForOrder,
  orderPlacedFinalizationMetadata,
} from "../lib/catch-weight-finalization"
import { emitOpsAlert } from "../lib/ops-alert"

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error || "Unknown error")
}

function emitCatchWeightFinalizationSubscriberAlert(input: {
  alertKind:
    | "catch_weight_finalization_skipped"
    | "catch_weight_finalization_failed"
  title: string
  orderId?: string | null
  error?: unknown
  logger: Parameters<typeof emitOpsAlert>[0]["logger"]
}) {
  return emitOpsAlert({
    alertKind: input.alertKind,
    title: input.title,
    path: "src/subscribers/catch-weight-finalization-order-placed.ts",
    source: "medusa-server",
    severity: "page",
    logger: input.logger,
    meta: {
      action: "order_placed_finalization_init",
      source_event: "order.placed",
      order_id: input.orderId || null,
      error_message: input.error
        ? errorMessage(input.error).slice(0, 500)
        : null,
    },
  })
}

export default async function catchWeightFinalizationOrderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string; order_id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = data.order_id || data.id

  if (!orderId) {
    await emitCatchWeightFinalizationSubscriberAlert({
      alertKind: "catch_weight_finalization_skipped",
      title:
        "Catch-weight finalization initialization skipped because order id is missing",
      orderId: null,
      logger,
    })
    return
  }

  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const orderModule = container.resolve(Modules.ORDER)
    const { data: orders } = await query.graph({
      entity: "order",
      fields: CATCH_WEIGHT_ORDER_FIELDS,
      filters: { id: orderId },
    })
    const order = orders?.[0] as Record<string, any> | undefined

    if (!order) {
      logger.warn(`[catch-weight-finalization] order not found id=${orderId}`)
      await emitCatchWeightFinalizationSubscriberAlert({
        alertKind: "catch_weight_finalization_skipped",
        title:
          "Catch-weight finalization initialization skipped because order was not found",
        orderId,
        logger,
      })
      return
    }

    // Reviewed checkout initializes packing only after its successful native
    // return is bound. An order.placed callback may arrive before that return.
    // The completion wrapper owns initialization/recovery for this case.
    if (
      order.metadata?.[ORDER_PROMISE_KEY] &&
      !(await db("gp_order_promise_binding")
        .where({ order_id: order.id })
        .first())
    )
      return
    const { finalization, lines } = await ensureFinalizationForOrder(db, order)
    const metadata = orderPlacedFinalizationMetadata(order, finalization)

    await orderModule.updateOrders(order.id, { metadata })

    logger.info(
      `[catch-weight-finalization] order=${order.id} finalization=${finalization.id} lines=${lines.length} status=${finalization.status}`
    )
  } catch (err) {
    const message = errorMessage(err)
    logger.error(
      `[catch-weight-finalization] failed to initialize order=${orderId}: ${message}`
    )
    await emitCatchWeightFinalizationSubscriberAlert({
      alertKind: "catch_weight_finalization_failed",
      title: "Catch-weight finalization initialization failed",
      orderId,
      error: err,
      logger,
    })
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
