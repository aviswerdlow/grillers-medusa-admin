import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { QBD_OUTBOX_TABLE, untrackedQbdPostings } from "../lib/qbd-posting-outbox"
import { STAFF_REFUND_REQUEST_TABLE } from "../lib/staff-refund-request"

// Read-only. Keep the resulting IDs in the private cutover evidence, not customer-facing logs.
export default async function reportQbdPostingOutbox({ container }: ExecArgs) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const statuses = await db(QBD_OUTBOX_TABLE).select("status").count("* as count").groupBy("status")
  const legacy = await untrackedQbdPostings(db, 100)
  const refunds = await db(STAFF_REFUND_REQUEST_TABLE).select("id", "order_id", "payment_id", "request_key", "status", "provider_refund_id", "created_at")
    .whereNot({ status: "succeeded" }).orderBy("created_at").limit(100)
  console.log(JSON.stringify({ statuses, untracked_legacy: legacy, limit: 100, may_be_truncated: legacy.length === 100,
    unresolved_refund_attempts: refunds, refunds_may_be_truncated: refunds.length === 100,
    action: "Review each legacy request against bridge jobs and QBD transactions; this command never replays work." }, null, 2))
}
