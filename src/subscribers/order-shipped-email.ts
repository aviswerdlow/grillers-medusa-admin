import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { fetchOrderForEmail } from "../lib/emails/order-fetch"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"
import { buildOrderShippedEmail } from "../lib/emails/templates/order-shipped"
import { sendTrackedEmail } from "../lib/communications/core"
import { sendOrderShippedSms } from "../lib/communications/transactional-sms"

type ShipmentEventData = {
  id: string
  order_id?: string
  no_notification?: boolean
  tracking_numbers?: Array<{ tracking_number?: string; url?: string } | string>
  data?: { tracking_url?: string }
  metadata?: Record<string, any>
}

export function shipmentTrackingDetails(
  data: ShipmentEventData,
  shipment?: Record<string, any> | null
) {
  const firstEventTracking = Array.isArray(data.tracking_numbers)
    ? data.tracking_numbers[0]
    : undefined
  const firstLabel = Array.isArray(shipment?.labels)
    ? shipment.labels[0]
    : undefined
  const trackingNumber =
    (typeof firstEventTracking === "string"
      ? firstEventTracking
      : firstEventTracking?.tracking_number) || firstLabel?.tracking_number
  const trackingUrl =
    (typeof firstEventTracking === "object"
      ? firstEventTracking?.url
      : undefined) ||
    data.data?.tracking_url ||
    firstLabel?.tracking_url ||
    firstLabel?.url
  const carrier =
    (data.metadata?.carrier as string | undefined) ||
    (shipment?.metadata?.carrier as string | undefined)
  return { carrier, trackingNumber, trackingUrl }
}

export default async function orderShippedEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<ShipmentEventData>) {
  const logger = container.resolve("logger")
  const query = container.resolve("query")

  if (data.no_notification === true) {
    logger.info(
      `[order-shipped-notifications] skipped no_notification fulfillment=${data.id}`
    )
    return
  }

  let orderId = data.order_id
  let shipment: Record<string, any> | null = null
  let order: any

  try {
    try {
      const { data: shipments } = await query.graph({
        entity: "fulfillment",
        fields: [
          "id",
          "shipped_at",
          "labels.tracking_number",
          "labels.tracking_url",
          "labels.url",
          "metadata",
        ],
        filters: { id: data.id },
      })
      shipment = (shipments?.[0] as Record<string, any> | undefined) || null
      if (!shipment && !orderId) {
        logger.warn(`[order-shipped-email] no fulfillment found for ${data.id}`)
        void emitTransactionalEmailPreconditionAlert({
          logger,
          templateKey: "order-shipped",
          reason: "fulfillment_not_found",
          path: "src/subscribers/order-shipped-email.ts",
          eventName: "shipment.created",
          eventId: data.id,
          fulfillmentId: data.id,
        })
        return
      }
    } catch (shipmentError) {
      if (!orderId) throw shipmentError
      logger.warn(
        `[order-shipped-notifications] could not enrich fulfillment ${data.id}: ${
          shipmentError instanceof Error
            ? shipmentError.message
            : String(shipmentError)
        }`
      )
    }

    if (!orderId) {
      const { data: orderFulfillments } = await query.graph({
        entity: "order_fulfillment",
        fields: ["order_id", "fulfillment_id"],
        filters: { fulfillment_id: data.id },
      })
      orderId = orderFulfillments?.[0]?.order_id
    }

    if (!orderId) {
      logger.warn(
        `[order-shipped-email] could not resolve order_id for fulfillment ${data.id}`
      )
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-shipped",
        reason: "order_id_not_resolved",
        path: "src/subscribers/order-shipped-email.ts",
        eventName: "shipment.created",
        eventId: data.id,
        fulfillmentId: data.id,
      })
      return
    }

    order = await fetchOrderForEmail(container, orderId)
    if (!order) {
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "order-shipped",
        reason: "order_not_found",
        path: "src/subscribers/order-shipped-email.ts",
        eventName: "shipment.created",
        eventId: data.id,
        orderId,
        fulfillmentId: data.id,
      })
      return
    }
  } catch (error) {
    logger.error(
      `[order-shipped-notifications] resolution failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "order-shipped",
      path: "src/subscribers/order-shipped-email.ts",
      eventName: "shipment.created",
      eventId: data.id,
      orderId,
      fulfillmentId: data.id,
      error,
    })
    return
  }

  const { carrier, trackingNumber, trackingUrl } = shipmentTrackingDetails(
    data,
    shipment
  )

  // Email and SMS are independent delivery lanes. A Postmark failure must not
  // suppress a consented SMS, and an SMS failure must not retry the email.
  if (!order.email) {
    void emitTransactionalEmailPreconditionAlert({
      logger,
      templateKey: "order-shipped",
      reason: "order_missing_email",
      path: "src/subscribers/order-shipped-email.ts",
      eventName: "shipment.created",
      eventId: data.id,
      orderId: order.id,
      displayId: order.display_id,
      fulfillmentId: data.id,
    })
  } else {
    try {
      const { subject, html, text } = buildOrderShippedEmail({
        order,
        trackingNumber,
        trackingUrl,
        carrier,
      })
      logger.info(
        `[order-shipped-email] sending to=${order.email} order=${order.id} tracking=${trackingNumber || "n/a"}`
      )
      await sendTrackedEmail(container, {
        to: order.email,
      medusa_customer_id: order.customer_id,
        stream: "transactional",
        purpose: "transactional",
        template_key: "order-shipped",
        subject,
        html,
        text,
        topic: "order_updates",
        idempotency_key: `order-shipped:${order.id}:${trackingNumber || data.id}`,
        order_id: order.id,
        metadata: {
          order_id: order.id,
          display_id: order.display_id,
          tracking_number: trackingNumber,
        },
      })
    } catch (emailError) {
      logger.error(
        `[order-shipped-email] failed: ${
          emailError instanceof Error ? emailError.message : String(emailError)
        }`
      )
      void emitTransactionalEmailHandlerFailureAlert({
        logger,
        templateKey: "order-shipped",
        path: "src/subscribers/order-shipped-email.ts",
        eventName: "shipment.created",
        eventId: data.id,
        orderId: order.id,
        fulfillmentId: data.id,
        error: emailError,
      })
    }
  }

  try {
    const smsResult = await sendOrderShippedSms(container, {
      order,
      fulfillmentId: data.id,
      trackingNumber,
    })
    logger.info(
      `[order-shipped-sms] order=${order.id} queued=${
        smsResult.ok && !smsResult.skipped
      } skipped=${Boolean(smsResult.skipped)}`
    )
  } catch (smsError) {
    logger.error(
      `[order-shipped-sms] failed order=${order.id}: ${
        smsError instanceof Error ? smsError.message : String(smsError)
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: "shipment.created",
}
