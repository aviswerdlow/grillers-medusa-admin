import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  smsConsentFromCustomerMetadata,
  upsertCustomerProfile,
} from "../lib/communications/core"
import { emitOpsAlert } from "../lib/ops-alert"

type EventData = {
  id: string
  customer_id?: string
  cart_id?: string
  email?: string
}
const ALERT_PATH = "src/subscribers/communications-commerce-events.ts"

/** Operational profile truth remains independent of analytics consent. Native
 * measurement is captured separately at the original workflow mutation. */
export default async function communicationsCommerceEvents({
  event: { name, data },
  container,
}: SubscriberArgs<EventData>) {
  if (name !== "customer.created" && name !== "customer.updated") return
  const logger = container.resolve("logger")
  try {
    const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const { data: customers } = await container.resolve("query").graph({
      entity: "customer",
      fields: ["id", "email", "first_name", "last_name", "phone", "metadata"],
      filters: { id: data.id },
    })
    const customer = customers?.[0]
    if (!customer) return
    await upsertCustomerProfile(db, {
      medusa_customer_id: customer.id,
      email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone,
      ...smsConsentFromCustomerMetadata(customer.metadata),
    })
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err || ""))
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .slice(0, 300)
    logger.warn(
      `[communications] failed to record commerce event ${name}: ${error}`
    )
    void emitOpsAlert({
      alertKind: "communications_commerce_event_record_failed",
      severity: "warn",
      title: `Communications commerce event failed for ${name}`,
      path: ALERT_PATH,
      source: "medusa-server",
      logger,
      meta: {
        medusa_event_name: name,
        source_event_id: data.id,
        order_id: null,
        cart_id: data.cart_id || null,
        medusa_customer_id: data.customer_id || null,
        has_email: Boolean(data.email),
        error,
      },
    }).catch(() => undefined)
  }
}
export const config: SubscriberConfig = {
  event: ["customer.created", "customer.updated"],
}
