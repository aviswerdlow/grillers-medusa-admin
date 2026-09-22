import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { sendTrackedEmail } from "../lib/communications/core"
import { fetchOrderForEmail } from "../lib/emails/order-fetch"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"
import { buildOrderFinalChargeDeclinedEmail } from "../lib/emails/templates/order-final-charge-declined"

type DeclineEvent = {
  id: string
  order_id: string
  finalization_id: string
  charge_attempt_id: string
}

export default async function orderFinalChargeDeclinedEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<DeclineEvent>) {
  if (process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED !== "true") return
  const logger = container.resolve("logger")
  const orderId = data.order_id || data.id

  try {
    if (!orderId || !data.finalization_id || !data.charge_attempt_id) return
    // The shared order-email reader resolves the immutable accepted receipt
    // snapshot; it never substitutes the customer's current account address.
    const order = await fetchOrderForEmail(container, orderId)
    if (!order?.email) {
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-final-charge-declined",
        reason: order ? "order_missing_email" : "order_not_found",
        path: "src/subscribers/order-final-charge-declined-email.ts",
        eventName: "order.final_charge_declined",
        eventId: data.id,
        orderId,
      })
      return
    }

    const { subject, html, text } = buildOrderFinalChargeDeclinedEmail(order)
    const result = await sendTrackedEmail(container, {
      to: order.email,
      medusa_customer_id: order.customer_id,
      stream: "transactional",
      purpose: "transactional",
      template_key: "order-final-charge-declined",
      subject,
      html,
      text,
      topic: "order_updates",
      idempotency_key: `order-final-charge-declined:${orderId}:${data.finalization_id}:${data.charge_attempt_id}`,
      order_id: orderId,
      metadata: {
        order_id: orderId,
        finalization_id: data.finalization_id,
        charge_attempt_id: data.charge_attempt_id,
      },
    })
    if (!result.ok) {
      throw new Error(result.error || "Decline notice receipt unconfirmed")
    }
  } catch (error) {
    logger.error(
      `[order-final-charge-declined-email] failed for order ${orderId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "order-final-charge-declined",
      path: "src/subscribers/order-final-charge-declined-email.ts",
      eventName: "order.final_charge_declined",
      eventId: data.id,
      orderId,
      error,
    })
  }
}

export const config: SubscriberConfig = {
  event: "order.final_charge_declined",
}
