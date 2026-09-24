import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { fetchOrderForEmail } from "../lib/emails/order-fetch"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"
import { buildOrderCanceledEmail } from "../lib/emails/templates/order-canceled"
import { sendTrackedEmail } from "../lib/communications/core"

export default async function orderCanceledEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string; reason?: string }>) {
  const logger = container.resolve("logger")

  try {
    const order = await fetchOrderForEmail(container, data.id)
    if (!order) {
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-canceled",
        reason: "order_not_found",
        path: "src/subscribers/order-canceled-email.ts",
        eventName: "order.canceled",
        eventId: data.id,
        orderId: data.id,
      })
      return
    }
    if (!order.email) {
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-canceled",
        reason: "order_missing_email",
        path: "src/subscribers/order-canceled-email.ts",
        eventName: "order.canceled",
        eventId: data.id,
        orderId: order.id,
        displayId: order.display_id,
      })
      return
    }

    const { subject, html, text } = buildOrderCanceledEmail({
      order,
      reason: data.reason,
    })

    logger.info(
      `[order-canceled-email] sending to=${order.email} order=${order.id}`
    )

    await sendTrackedEmail(container, {
      to: order.email,
      medusa_customer_id: order.customer_id,
      stream: "transactional",
      purpose: "transactional",
      template_key: "order-canceled",
      subject,
      html,
      text,
      topic: "order_updates",
      idempotency_key: `order-canceled:${order.id}`,
      order_id: order.id,
      metadata: {
        order_id: order.id,
        display_id: order.display_id,
        reason: data.reason,
      },
    })
  } catch (err) {
    logger.error(
      `[order-canceled-email] failed for order ${data.id}: ${err instanceof Error ? err.message : String(err)}`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "order-canceled",
      path: "src/subscribers/order-canceled-email.ts",
      eventName: "order.canceled",
      eventId: data.id,
      orderId: data.id,
      error: err,
    })
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
