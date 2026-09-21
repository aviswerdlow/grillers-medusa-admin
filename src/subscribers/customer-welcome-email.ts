import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

/** Retired: customer.created precedes outer account/auth-link completion and
 * cannot supply original recipient or lane. Successful registration capture and
 * the saved worker own welcome. Do not restore the mutable-read fallback. */
export default async function customerWelcomeEmailHandler(
  _args: SubscriberArgs<{ id: string }>
) {}
export const config: SubscriberConfig = { event: "customer.created" }
