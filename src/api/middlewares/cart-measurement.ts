import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import {
  MEASUREMENT_HEADER,
  requestMeasurementContext,
} from "../../lib/analytics/customer-measurement-context"
import {
  captureCartResponse,
  cartServerLane,
  CART_MEASUREMENT_EVENT,
} from "../../lib/cart-measurement"

export function captureCartMeasurementResponse(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (
    process.env.GP_CART_MEASUREMENT_ENABLED !== "true" ||
    !["POST", "DELETE"].includes(req.method) ||
    (req as any).gp_staff_cart
  )
    return next()
  const context = requestMeasurementContext(
    req.headers[MEASUREMENT_HEADER],
    Date.now(),
    true
  )
  const lane =
    req.headers[MEASUREMENT_HEADER] !== undefined && !context
      ? "unavailable"
      : cartServerLane()
  const json = res.json.bind(res)
  let captured = false
  res.json = ((body: any) => {
    if (
      !captured &&
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      !body?.error
    ) {
      captured = true
      const cart = body?.cart || (body?.deleted === true ? body.parent : null)
      if (!req.params?.id || req.params.id === cart?.id) {
        const snapshot = captureCartResponse(cart, context, lane)
        if (snapshot) {
          // Preserve the observed response now. Neither a later query nor a
          // transport error may alter the successful cart action/response.
          try {
            void Promise.resolve(
              req.scope.resolve(Modules.EVENT_BUS).emit({
                name: CART_MEASUREMENT_EVENT,
                data: snapshot,
              })
            ).catch(() =>
              req.scope
                .resolve("logger")
                .warn("[cart-measurement] source notification unavailable")
            )
          } catch {
            req.scope
              .resolve("logger")
              .warn("[cart-measurement] source notification unavailable")
          }
        }
      }
    }
    return json(body)
  }) as typeof res.json
  return next()
}
