import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  ACCOUNT_WELCOME_EVENT,
  saveAccountWelcome,
  type WelcomeSource,
} from "../lib/account-welcome"

export default async function accountWelcomeCaptured({
  event: { data },
  container,
}: SubscriberArgs<WelcomeSource>) {
  // Propagate persistence failure so the accepted event can retry unchanged.
  await saveAccountWelcome(
    container.resolve(ContainerRegistrationKeys.PG_CONNECTION),
    data
  )
}
export const config: SubscriberConfig = { event: ACCOUNT_WELCOME_EVENT }
