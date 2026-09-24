import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createAllocationsForOrder } from "../lib/inventory-allocation"
import { staffCartSigningSecret } from "../lib/staff-cart-authority"
import { emitOpsAlert } from "../lib/ops-alert"
import { emitInventoryAllocationSubscriberFailureAlert } from "../lib/inventory-allocation-subscriber-alerts"

export default async function inventoryAllocationOrderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  let analytics: any = null
  try {
    analytics = container.resolve("analytics")
  } catch {
    analytics = null
  }

  try {
    // Ordinary allocation must continue if staff signing is unconfigured.
    // Without a verified receipt no staff attribution or override is accepted.
    let staffAuthoritySecret: string | undefined
    try { staffAuthoritySecret = staffCartSigningSecret(container) } catch {}
    const result = await createAllocationsForOrder({
      db,
      query,
      orderId: data.id,
      staffAuthoritySecret,
    })

    logger.info(
      `[inventory-allocation] order=${data.id} created=${result.created} skipped=${result.skipped} blocked=${result.blocked}`
    )

    if (result.blocked > 0) {
      // Oversell guard tripped on one or more lines: the order placed but some
      // lines could not be cleanly allocated (blocked). Degradation/integrity
      // warning, not customer-blocking → warn (30-min digest).
      await emitOpsAlert({
        alertKind: "inventory_allocation_blocked",
        title: `Inventory allocation blocked ${result.blocked} line(s) for order ${data.id}`,
        path: "src/subscribers/inventory-allocation-order-placed.ts",
        source: "medusa",
        severity: "warn",
        logger,
        meta: {
          order_id: data.id,
          blocked_count: result.blocked,
          created_count: result.created,
          skipped_count: result.skipped,
        },
      })
    }

    if (analytics?.track) {
      await analytics.track({
        event: "inventory_allocation_created",
        properties: {
          order_id: data.id,
          created_count: result.created,
          skipped_count: result.skipped,
          blocked_count: result.blocked,
        },
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(
      `[inventory-allocation] failed to allocate order=${data.id}: ${message}`
    )
    await emitInventoryAllocationSubscriberFailureAlert({
      action: "order_allocate",
      orderId: data.id,
      error: err,
      logger,
    })
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
