import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { metadataObject } from "../lib/catch-weight-finalization"
import { sendTrackedEmail } from "../lib/communications/core"
import { fetchOrderForEmail } from "../lib/emails/order-fetch"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"
import { buildOrderFinalChargeEmail } from "../lib/emails/templates/order-final-charge"

type FinalChargeEvent = {
  id: string
  order_id?: string
  amount?: number | string
}

export default async function orderFinalChargeEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<FinalChargeEvent>) {
  const logger = container.resolve("logger")
  const orderModule = container.resolve(Modules.ORDER)
  const orderId = data.order_id || data.id

  try {
    const order = await fetchOrderForEmail(container, orderId)

    if (!order) {
      logger.warn(`[order-final-charge-email] order/email missing id=${orderId}`)
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-final-charge",
        reason: "order_not_found",
        path: "src/subscribers/order-final-charge-email.ts",
        eventName: "order.final_charge_succeeded",
        eventId: data.id,
        orderId,
      })
      return
    }

    if (!order.email) {
      logger.warn(`[order-final-charge-email] order/email missing id=${orderId}`)
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-final-charge",
        reason: "order_missing_email",
        path: "src/subscribers/order-final-charge-email.ts",
        eventName: "order.final_charge_succeeded",
        eventId: data.id,
        orderId: order.id,
        displayId: order.display_id,
      })
      return
    }

    const metadata = metadataObject(order.metadata)
    if (metadata.final_charge_email_sent_at) {
      return
    }

    const estimatedTotal = Number(metadata.estimated_total || order.total || 0)
    const finalTotal = Number(
      data.amount || metadata.final_total || metadata.final_order_total || order.total || 0
    )
    const { subject, html, text } = buildOrderFinalChargeEmail({
      order,
      estimatedTotal,
      finalTotal,
    })

    await sendTrackedEmail(container, {
      to: order.email,
      medusa_customer_id: order.customer_id,
      stream: "transactional",
      purpose: "transactional",
      template_key: "order-final-charge",
      subject,
      html,
      text,
      topic: "order_updates",
      idempotency_key: `order-final-charge:${order.id}`,
      order_id: order.id,
      metadata: {
        order_id: order.id,
        display_id: order.display_id,
        estimated_total: estimatedTotal,
        final_total: finalTotal,
      },
    })

    await orderModule.updateOrders(order.id, {
      metadata: {
        ...metadata,
        final_charge_email_sent_at: new Date().toISOString(),
      },
    })
  } catch (err) {
    logger.error(
      `[order-final-charge-email] failed for order ${orderId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "order-final-charge",
      path: "src/subscribers/order-final-charge-email.ts",
      eventName: "order.final_charge_succeeded",
      eventId: data.id,
      orderId,
      error: err,
    })
  }
}

export const config: SubscriberConfig = {
  event: "order.final_charge_succeeded",
}
