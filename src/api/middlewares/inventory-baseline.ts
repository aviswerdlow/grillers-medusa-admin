import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { checkInventoryAvailability, requestedFulfillmentDateFromMetadata } from "../../lib/inventory-allocation"
import { emitOpsAlert } from "../../lib/ops-alert"

function inventoryGuard(paymentSession: boolean) {
  return async (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
    try {
      const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
      let cartId = req.params.id || (req.body as any)?.cart_id
      if (paymentSession) {
        const { data } = await query.graph({ entity: "cart_payment_collection", fields: ["cart_id"],
          filters: { payment_collection_id: req.params.id } })
        if (data?.length !== 1) throw new Error("Cart payment relationship unavailable")
        cartId = data[0].cart_id
      }
      if (typeof cartId !== "string" || !cartId) throw new Error("Cart identity unavailable")
      const { data } = await query.graph({ entity: "cart", fields: ["id", "metadata", "items.id", "items.variant_id", "items.quantity"],
        filters: { id: cartId } })
      const cart = data?.[0]
      if (data?.length !== 1 || !Array.isArray(cart?.items) || !cart.items.length) throw new Error("Cart inventory unavailable")
      if (cart.items.some((line: any) => !line.variant_id || !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) <= 0)) {
        throw new Error("Cart quantity unavailable")
      }
      const availability = await checkInventoryAvailability({
        db: req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION), query,
        lines: cart.items.map((line: any) => ({ variant_id: line.variant_id, quantity: Number(line.quantity) })),
        requested_fulfillment_date: requestedFulfillmentDateFromMetadata(cart.metadata), cart_id: cartId,
        include_internal: false, record_snapshots: false,
      })
      if (availability.length !== cart.items.length || availability.some(line => !["available", "future_allowed"].includes(line.decision))) {
        res.status(409).json({ type: "inventory_unavailable", message: "Some items cannot be reserved. Please review your cart or contact us before paying." })
        return
      }
      return next()
    } catch {
      let logger: any
      try { logger = req.scope.resolve("logger") } catch {}
      void emitOpsAlert({ alertKind: "inventory_checkout_guard_unavailable", severity: "warn", source: "medusa",
        title: "Checkout inventory could not be verified", path: "src/api/middlewares/inventory-baseline.ts", logger,
        meta: { reason: "inventory_lookup_unavailable" } }).catch(() => {})
      res.status(503).json({ type: "inventory_unavailable", message: "Stock could not be verified. Please try again before paying." })
    }
  }
}

// Custom place-order already runs the same availability check before its payment
// workflows. Cover native endpoints as well so direct clients cannot bypass it.
export const guardNativeCartInventory = inventoryGuard(false)
export const guardNativePaymentInventory = inventoryGuard(true)
