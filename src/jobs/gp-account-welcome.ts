import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  accountWelcomeEnabled,
  deliverAccountWelcomes,
  welcomeKey,
  welcomeServerLane,
} from "../lib/account-welcome"
import { sendTrackedEmail } from "../lib/communications/core"
import { buildWelcomeEmail } from "../lib/emails/templates/welcome"
import { emitOpsAlert } from "../lib/ops-alert"

export default async function gpAccountWelcome(container: MedusaContainer) {
  if (!accountWelcomeEnabled()) return
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION),
    logger = container.resolve("logger")
  const summary = await deliverAccountWelcomes(db, async (s) => {
    if (s.lane === "rehearsal")
      return { status: "excluded", reason: "test_account_welcome" }
    if (s.lane !== "production" || welcomeServerLane() !== "production")
      return { status: "held", reason: "original_account_lane_unavailable" }
    const input = {
      to: s.customer.email,
      stream: "transactional" as const,
      purpose: "service" as const,
      template_key: "customer-welcome",
      topic: "account",
      idempotency_key: welcomeKey(s.customer.id),
      medusa_customer_id: s.customer.id,
      metadata: { account_welcome_source_id: s.event_id },
      ...buildWelcomeEmail({
        email: s.customer.email,
        firstName: s.customer.first_name,
      }),
    }
    const result = await sendTrackedEmail(container, input)
    if (!result.ok)
      return {
        status:
          result.error === "account_welcome_recipient_changed"
            ? "excluded"
            : "held",
        reason:
          result.error === "account_welcome_recipient_changed"
            ? result.error
            : "account_welcome_send_unconfirmed",
      }
    return result.skipped && !result.messageId
      ? { status: "excluded", reason: "account_welcome_suppressed" }
      : { status: "accepted" }
  })
  if (summary.held || summary.retry) {
    logger.warn(`[account-welcome] ${JSON.stringify(summary)}`)
    if (summary.production_pending && welcomeServerLane() === "production")
      await emitOpsAlert({
        alertKind: "account_welcome_pending",
        severity: "warn",
        title: "Account welcome needs delivery review",
        path: "src/jobs/gp-account-welcome.ts",
        source: "medusa-server",
        logger,
        meta: summary,
      })
  }
}
export const config = { name: "gp-account-welcome", schedule: "*/1 * * * *" }
