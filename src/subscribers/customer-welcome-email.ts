import { accountWelcomeEnabled } from "../lib/account-welcome"
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { buildWelcomeEmail } from "../lib/emails/templates/welcome"
import {
  sendTrackedEmail,
  smsConsentFromCustomerMetadata,
  upsertCustomerProfile,
} from "../lib/communications/core"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  emitTransactionalEmailHandlerFailureAlert,
  emitTransactionalEmailPreconditionAlert,
} from "../lib/emails/ops-alerts"

type CustomerCreatedEvent = {
  id: string
}

export default async function customerWelcomeEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<CustomerCreatedEvent>) {
  // Preserve the existing subscriber until the replacement is explicitly live.
  if (accountWelcomeEnabled()) return
  const logger = container.resolve("logger")
  const query = container.resolve("query")
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  try {
    const { data: customers } = await query.graph({
      entity: "customer",
      fields: ["id", "email", "first_name", "phone", "has_account", "metadata"],
      filters: { id: data.id },
    })
    const customer = customers?.[0]
    if (!customer) {
      logger.warn(`[customer-welcome-email] customer not found id=${data.id}`)
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "customer-welcome",
        reason: "customer_not_found",
        path: "src/subscribers/customer-welcome-email.ts",
        eventName: "customer.created",
        eventId: data.id,
        customerId: data.id,
      })
      return
    }

    if (!customer.email) {
      logger.warn(`[customer-welcome-email] customer ${customer.id} has no email`)
      void emitTransactionalEmailPreconditionAlert({
        logger,
        templateKey: "customer-welcome",
        reason: "customer_missing_email",
        path: "src/subscribers/customer-welcome-email.ts",
        eventName: "customer.created",
        eventId: data.id,
        customerId: customer.id,
      })
      return
    }

    if (!customer.has_account) {
      logger.info(
        `[customer-welcome-email] skipping guest customer ${customer.id}`
      )
      return
    }

    const { subject, html, text } = buildWelcomeEmail({
      email: customer.email,
      firstName: customer.first_name,
    })
    const profile = await upsertCustomerProfile(db, {
      medusa_customer_id: customer.id,
      email: customer.email,
      phone: customer.phone,
      first_name: customer.first_name,
      ...smsConsentFromCustomerMetadata(customer.metadata),
    })

    logger.info(
      `[customer-welcome-email] sending welcome to=${customer.email} id=${customer.id}`
    )

    await sendTrackedEmail(container, {
      to: customer.email,
      stream: "transactional",
      purpose: "service",
      template_key: "customer-welcome",
      subject,
      html,
      text,
      topic: "account",
      idempotency_key: `customer-welcome:${customer.id}`,
      profile_id: profile?.id,
      medusa_customer_id: customer.id,
      metadata: { customer_id: customer.id, email: customer.email },
    })
  } catch (err) {
    logger.error(
      `[customer-welcome-email] failed for customer ${data.id}: ${err instanceof Error ? err.message : String(err)}`
    )
    void emitTransactionalEmailHandlerFailureAlert({
      logger,
      templateKey: "customer-welcome",
      path: "src/subscribers/customer-welcome-email.ts",
      eventName: "customer.created",
      eventId: data.id,
      customerId: data.id,
      error: err,
    })
  }
}

export const config: SubscriberConfig = {
  event: "customer.created",
}
