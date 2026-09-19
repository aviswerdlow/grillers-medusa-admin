import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { deliverQbdOutbox } from "../lib/qbd-outbox-delivery"
import { emitOpsAlert } from "../lib/ops-alert"
import { legacyQbdListIdFallbacksForOrder, normalizeOrderForQbSync, postOrderToQbSync } from "../subscribers/qb-sync-order-import"

export default async function qbdPostingOutbox(container: MedusaContainer) {
  const logger = container.resolve("logger")
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const endpoint = process.env.QB_SYNC_ORDER_IMPORT_URL
  const token = process.env.QB_SYNC_ORDER_IMPORT_TOKEN
  if (!endpoint || !token) {
    logger.warn("[qbd-posting-outbox] Delivery is not configured; pending actions remain durable.")
    return
  }
  try {
    const result = await deliverQbdOutbox({
      db,
      normalize: async (order) => normalizeOrderForQbSync(order, await legacyQbdListIdFallbacksForOrder(db, order)),
      post: (order, envelope) => postOrderToQbSync(endpoint, token, order, fetch,
        process.env.QB_SYNC_ORDER_IMPORT_SIGNING_SECRET || token, envelope),
    })
    if (result.delivered || result.retried || result.blocked) logger.info(`[qbd-posting-outbox] ${JSON.stringify(result)}`)
    if (result.retried || result.blocked) {
      await emitOpsAlert({ logger, alertKind: "qbd_outbox_delivery_incomplete", severity: "warn",
        title: "QuickBooks has pending accounting delivery work", source: "medusa-server",
        path: "src/jobs/qbd-posting-outbox.ts", meta: result })
    }
  } catch (error) {
    await emitOpsAlert({ logger, alertKind: "qbd_outbox_worker_failed", severity: "page",
      title: "QuickBooks accounting delivery worker failed", source: "medusa-server",
      path: "src/jobs/qbd-posting-outbox.ts", meta: { error_type: error instanceof Error ? error.name : "Unknown" } })
    throw error
  }
}

export const config = { name: "qbd-posting-outbox", schedule: "* * * * *" }
