import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  recordCommunicationEvent,
  smsConsentFromCustomerMetadata,
  upsertCustomerProfile,
} from "../lib/communications/core"
import { metadataObject } from "../lib/catch-weight-finalization"
import { emitOpsAlert } from "../lib/ops-alert"

const ALERT_PATH = "src/subscribers/communications-commerce-events.ts"

type EventData = {
  id: string
  order_id?: string
  cart_id?: string
  customer_id?: string
  email?: string
  amount?: number | string
  reason?: string
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "")
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 300)
}

function orderIdFromEvent(name: string | undefined, data: EventData) {
  if (data.order_id) return data.order_id
  if (name === "order.placed" || name === "order.canceled") return data.id
  if (name === "order.final_charge_succeeded") return data.order_id || data.id
  return null
}

function emitCommerceEventRecordFailureAlert(input: {
  logger: Parameters<typeof emitOpsAlert>[0]["logger"]
  name?: string
  data: EventData
  error: unknown
}) {
  void emitOpsAlert({
    alertKind: "communications_commerce_event_record_failed",
    severity: "warn",
    title: `Communications commerce event failed for ${input.name || "unknown"}`,
    path: ALERT_PATH,
    source: "medusa-server",
    logger: input.logger,
    meta: {
      medusa_event_name: input.name || null,
      source_event_id: input.data.id || null,
      order_id: orderIdFromEvent(input.name, input.data),
      cart_id: input.data.cart_id || null,
      medusa_customer_id: input.data.customer_id || null,
      has_email: Boolean(input.data.email),
      error: redactedErrorMessage(input.error),
    },
  })
}

async function fetchOrderContext(container: any, orderId?: string) {
  if (!orderId) return null
  const query = container.resolve("query")
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "cart_id",
      "email",
      "customer_id",
      "currency_code",
      "total",
      "metadata",
      "items.id",
      "items.title",
      "items.quantity",
      "shipping_address.postal_code",
    ],
    filters: { id: orderId },
  })
  return orders?.[0] || null
}

async function fetchCustomerContext(container: any, customerId?: string) {
  if (!customerId) return null
  const query = container.resolve("query")
  const { data: customers } = await query.graph({
    entity: "customer",
    fields: [
      "id",
      "email",
      "first_name",
      "last_name",
      "phone",
      "metadata",
    ],
    filters: { id: customerId },
  })
  return customers?.[0] || null
}

export default async function communicationsCommerceEvents({
  event: { name, data },
  container,
}: SubscriberArgs<EventData>) {
  // One owner for purchase/finalization: the durable order publication journal.
  // Also guard direct/in-flight invocations from an older subscriber registry.
  if (name === "order.placed" || name === "order.final_charge_succeeded") return
  const logger = container.resolve("logger")
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  try {
    const eventName = String(name || "").replace(/\./g, "_")
    let order = null as any
    let customer = null as any
    let customerRecord = null as any
    let email = data.email
    let medusaCustomerId = data.customer_id
    let orderId = data.order_id

    if (name === "order.canceled") orderId = data.id

    if (orderId) {
      order = await fetchOrderContext(container, orderId)
      email = email || order?.email
      medusaCustomerId = medusaCustomerId || order?.customer_id
    }

    if (
      (name === "customer.created" || name === "customer.updated") &&
      data.id
    ) {
      customerRecord = await fetchCustomerContext(container, data.id)
      if (customerRecord) {
        email = email || customerRecord.email
        medusaCustomerId = medusaCustomerId || customerRecord.id
      }
    }

    if (medusaCustomerId || email) {
      customer = await upsertCustomerProfile(db, {
        medusa_customer_id: medusaCustomerId,
        email,
        first_name: customerRecord?.first_name,
        last_name: customerRecord?.last_name,
        phone: customerRecord?.phone,
        ...smsConsentFromCustomerMetadata(customerRecord?.metadata),
        customer_type:
          order?.metadata?.customer_type ||
          order?.metadata?.account_type ||
          undefined,
        route_market:
          order?.metadata?.route_market ||
          order?.metadata?.fulfillmentMarket ||
          undefined,
      })
    }

    const orderMetadata = metadataObject(order?.metadata)
    await recordCommunicationEvent(db, {
      event_name: name === "payment.refunded" ? "order_refunded" : eventName,
      event_id: `${name}:${data.id}:${data.order_id || ""}:${data.amount || ""}`,
      source: "medusa-server",
      profile_id: customer?.id || null,
      medusa_customer_id: medusaCustomerId || null,
      email: email || null,
      order_id: orderId || null,
      cart_id: order?.cart_id || data.cart_id || null,
      customer_type: customer?.customer_type || "unknown",
      route_market: customer?.route_market || "unknown",
      properties: {
        ...data,
        display_id: order?.display_id,
        cart_id: order?.cart_id,
        total:
          data.amount ??
          orderMetadata.final_total ??
          orderMetadata.final_order_total ??
          order?.total,
        item_count: Array.isArray(order?.items) ? order.items.length : undefined,
        currency_code: order?.currency_code,
      },
    })
  } catch (err) {
    logger.warn(
      `[communications] failed to record commerce event ${name}: ${
        redactedErrorMessage(err)
      }`
    )
    emitCommerceEventRecordFailureAlert({
      logger,
      name,
      data,
      error: err,
    })
  }
}

export const config: SubscriberConfig = {
  event: [
    "order.canceled",
    "order.fulfilled",
    "shipment.created",
    "delivery.created",
    "payment.refunded",
    "customer.created",
    "customer.updated",
  ],
}
