import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { fetchOrderForEmail } from "../lib/emails/order-fetch"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"
import { buildOrderPlacedEmail } from "../lib/emails/templates/order-placed"
import { sendTrackedEmail } from "../lib/communications/core"

export default async function orderPlacedEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    const order = await fetchOrderForEmail(container, data.id)

    if (!order) {
      logger.warn(`[order-placed-email] order not found for id=${data.id}`)
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-placed",
        reason: "order_not_found",
        path: "src/subscribers/order-placed-email.ts",
        eventName: "order.placed",
        eventId: data.id,
        orderId: data.id,
      })
      return
    }
    if (!order.email) {
      logger.warn(`[order-placed-email] order ${order.id} has no email`)
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-placed",
        reason: "order_missing_email",
        path: "src/subscribers/order-placed-email.ts",
        eventName: "order.placed",
        eventId: data.id,
        orderId: order.id,
        displayId: order.display_id,
      })
      return
    }

    const { subject, html, text } = buildOrderPlacedEmail(order)

    logger.info(
      `[order-placed-email] sending confirmation to=${order.email} order=${order.id}`
    )

    await sendTrackedEmail(container, {
      to: order.email,
      medusa_customer_id: order.customer_id,
      stream: "transactional",
      purpose: "transactional",
      template_key: "order-placed",
      subject,
      html,
      text,
      topic: "order_updates",
      idempotency_key: `order-placed:${order.id}`,
      order_id: order.id,
      metadata: {
        order_id: order.id,
        display_id: order.display_id,
        email: order.email,
        total: order.total,
      },
    })
  } catch (err) {
    logger.error(
      `[order-placed-email] failed for order ${data.id}: ${err instanceof Error ? err.message : String(err)}`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "order-placed",
      path: "src/subscribers/order-placed-email.ts",
      eventName: "order.placed",
      eventId: data.id,
      orderId: data.id,
      error: err,
    })
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
