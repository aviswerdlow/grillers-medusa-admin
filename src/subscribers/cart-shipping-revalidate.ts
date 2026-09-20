// src/subscribers/cart-shipping-revalidate.ts
//
// LAYER 2 (self-heal): when a cart is updated, drop any selected shipping
// method whose service area no longer covers the cart's ship-to address.
//
// Why: a customer can pick a zip/city-restricted method (Metro Atlanta Delivery
// / Scheduled Delivery) and THEN change their address to one outside that
// method's service area. The stale method would otherwise fail pricing on every
// subsequent cart operation. We proactively remove it so the cart stays usable
// and the customer is nudged to re-pick a serviceable option.
//
// Loop safety: the raw cartModuleService.deleteShippingMethods() module call
// does NOT re-emit cart.updated (only core-flows workflows emit events), so the
// removal does not retrigger this handler. Even if some other path did re-emit
// cart.updated, the `invalidMethodIds.length > 0` guard makes this handler
// idempotent — a pass that finds no invalid method is a no-op — so it is safe
// to re-run regardless.

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import {
  isDestinationServiceable,
  resolveServiceCodeFromMethod,
  ZIP_RESTRICTED_SERVICE_CODES,
} from "../modules/fulfillment/serviceability"
import { emitOpsAlert } from "../lib/ops-alert"

const ALERT_PATH = "src/subscribers/cart-shipping-revalidate.ts"

export default async function cartShippingRevalidateHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    await container.resolve(Modules.LOCKING).execute(
      data.id,
      async () => {
        const query = container.resolve("query")

        const { data: carts } = await query.graph({
          entity: "cart",
          fields: [
            "id",
            "completed_at",
            "shipping_address.postal_code",
            "shipping_address.city",
            "shipping_address.province",
            "shipping_methods.id",
            "shipping_methods.name",
            "shipping_methods.shipping_option_id",
            "shipping_methods.data",
            "shipping_methods.shipping_option.id",
            "shipping_methods.shipping_option.name",
            "shipping_methods.shipping_option.data",
          ],
          filters: { id: data.id },
        })

        const cart = carts?.[0] as any
        if (!cart || cart.completed_at) return

        const shippingAddress = cart.shipping_address || null
        const methods: any[] = Array.isArray(cart.shipping_methods)
          ? cart.shipping_methods
          : []
        if (methods.length === 0) return

        const invalidMethodIds: string[] = []
        for (const method of methods) {
          const serviceCode = resolveServiceCodeFromMethod(method)
          // Fast path: only restricted services can be unserviceable, so skip the
          // Strapi round-trip for everything else.
          if (!ZIP_RESTRICTED_SERVICE_CODES.has(serviceCode)) continue

          const serviceable = await isDestinationServiceable(
            serviceCode,
            shippingAddress
          )
          if (!serviceable && method?.id) {
            invalidMethodIds.push(method.id)
          }
        }

        // Only act when there is something to remove — this is what makes the
        // cart.updated -> delete -> cart.updated cycle terminate.
        if (invalidMethodIds.length === 0) return

        const cartModuleService = container.resolve(Modules.CART)
        await cartModuleService.deleteShippingMethods(invalidMethodIds)

        logger.info(
          `[cart-shipping-revalidate] removed ${
            invalidMethodIds.length
          } unserviceable shipping method(s) from cart ${
            cart.id
          }: ${invalidMethodIds.join(", ")}`
        )
      },
      { timeout: 30 }
    )
  } catch (err) {
    // A failure here must never break the cart.
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(
      `[cart-shipping-revalidate] failed to revalidate shipping methods for cart ${data.id}: ${message}`
    )
    void emitOpsAlert({
      alertKind: "cart_shipping_revalidate_failed",
      severity: "warn",
      title: "cart.updated shipping revalidation failed",
      path: ALERT_PATH,
      logger,
      meta: {
        cart_id: data.id,
        error_message: message.slice(0, 300),
      },
    })
  }
}

export const config: SubscriberConfig = {
  event: "cart.updated",
}
