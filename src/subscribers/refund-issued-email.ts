import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { fetchOrderForEmail } from "../lib/emails/order-fetch"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"
import { buildRefundIssuedEmail } from "../lib/emails/templates/refund-issued"
import { sendTrackedEmail } from "../lib/communications/core"

type RefundEventData = {
  id: string
  payment_id?: string
  refund_id?: string
  order_id?: string
  amount?: number | string
  reason?: string
  note?: string
}

const amountFromRefund = (
  refund: Record<string, any>
): number | string | undefined => {
  const raw = refund.raw_amount
  if (raw && typeof raw === "object" && "value" in raw) {
    return raw.value
  }

  return raw ?? refund.amount
}

export default async function refundIssuedEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<RefundEventData>) {
  const logger = container.resolve("logger")
  const query = container.resolve("query")

  try {
    let paymentId = data.payment_id || data.id
    let refundId = data.refund_id
    let orderId = data.order_id
    let resolvedRefundAmount = data.amount
    let reason = data.reason || data.note

    if (!orderId || resolvedRefundAmount === undefined || !refundId) {
      const { data: payments } = await query.graph({
        entity: "payment",
        fields: [
          "id",
          "payment_collection_id",
          "refunds.id",
          "refunds.amount",
          "refunds.raw_amount",
          "refunds.note",
        ],
        filters: { id: paymentId },
      })
      const payment = payments?.[0] as any
      if (payment) {
        const refunds = Array.isArray(payment.refunds) ? payment.refunds : []
        const refund =
          (refundId && refunds.find((candidate: any) => candidate.id === refundId)) ||
          refunds[refunds.length - 1]

        refundId = refundId || refund?.id
        resolvedRefundAmount =
          resolvedRefundAmount ?? (refund ? amountFromRefund(refund) : undefined)
        reason = reason || refund?.note

        if (payment.payment_collection_id && !orderId) {
          const { data: orderPCs } = await query.graph({
            entity: "order_payment_collection",
            fields: ["order_id"],
            filters: { payment_collection_id: payment.payment_collection_id },
          })
          orderId = orderPCs?.[0]?.order_id
        }
      }
    }

    if ((!orderId || resolvedRefundAmount === undefined) && refundId) {
      const { data: refunds } = await query.graph({
        entity: "refund",
        fields: [
          "id",
          "amount",
          "raw_amount",
          "note",
          "payment.id",
          "payment.payment_collection_id",
          "payment.payment_collection.cart_id",
        ],
        filters: { id: refundId },
      })
      const refund = refunds?.[0] as any
      if (refund) {
        paymentId = paymentId || refund.payment?.id
        resolvedRefundAmount = resolvedRefundAmount ?? amountFromRefund(refund)
        reason = reason || refund.note
        const paymentCollectionId = refund.payment?.payment_collection_id
        if (paymentCollectionId && !orderId) {
          const { data: orderPCs } = await query.graph({
            entity: "order_payment_collection",
            fields: ["order_id"],
            filters: { payment_collection_id: paymentCollectionId },
          })
          orderId = orderPCs?.[0]?.order_id
        }
      }
    }

    if (!orderId) {
      logger.warn(
        `[refund-issued-email] could not resolve order_id for payment=${paymentId} refund=${refundId || "unknown"}`
      )
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "refund-issued",
        reason: "order_id_not_resolved",
        path: "src/subscribers/refund-issued-email.ts",
        eventName: "payment.refunded",
        eventId: data.id,
        paymentId,
        refundId,
      })
      return
    }

    const order = await fetchOrderForEmail(container, orderId)
    if (!order) {
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "refund-issued",
        reason: "order_not_found",
        path: "src/subscribers/refund-issued-email.ts",
        eventName: "payment.refunded",
        eventId: data.id,
        orderId,
        paymentId,
        refundId,
      })
      return
    }
    if (!order.email) {
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "refund-issued",
        reason: "order_missing_email",
        path: "src/subscribers/refund-issued-email.ts",
        eventName: "payment.refunded",
        eventId: data.id,
        orderId: order.id,
        displayId: order.display_id,
        paymentId,
        refundId,
      })
      return
    }

    const { subject, html, text } = buildRefundIssuedEmail({
      order,
      refundAmount: resolvedRefundAmount ?? 0,
      reason,
    })

    logger.info(
      `[refund-issued-email] sending to=${order.email} order=${order.id} amount=${resolvedRefundAmount}`
    )

    await sendTrackedEmail(container, {
      to: order.email,
      medusa_customer_id: order.customer_id,
      stream: "transactional",
      purpose: "transactional",
      template_key: "refund-issued",
      subject,
      html,
      text,
      topic: "order_updates",
      idempotency_key: `refund-issued:${refundId || paymentId}:${order.id}`,
      order_id: order.id,
      metadata: {
        order_id: order.id,
        display_id: order.display_id,
        refund_amount: resolvedRefundAmount,
      },
    })
  } catch (err) {
    logger.error(
      `[refund-issued-email] failed: ${err instanceof Error ? err.message : String(err)}`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "refund-issued",
      path: "src/subscribers/refund-issued-email.ts",
      eventName: "payment.refunded",
      eventId: data.id,
      orderId: data.order_id,
      paymentId: data.payment_id || data.id,
      refundId: data.refund_id,
      error: err,
    })
  }
}

export const config: SubscriberConfig = {
  event: "payment.refunded",
}
