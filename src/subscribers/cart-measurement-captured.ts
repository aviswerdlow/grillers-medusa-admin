import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  CART_MEASUREMENT_EVENT,
  saveCartMeasurement,
  type CartMeasurement,
} from "../lib/cart-measurement"

export default async function cartMeasurementCaptured({
  event: { data },
  container,
}: SubscriberArgs<CartMeasurement>) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  // Persistence failures propagate to the native bus retry mechanism; the cart
  // mutation already succeeded. Accepted notifications outlive the capture flag.
  await db.transaction((trx: any) => saveCartMeasurement(trx, data))
}
export const config: SubscriberConfig = { event: CART_MEASUREMENT_EVENT }
