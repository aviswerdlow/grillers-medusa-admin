import { randomUUID } from "node:crypto"
import { asValue } from "awilix"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http"
import {
  MEASUREMENT_HEADER,
  requestMeasurementContext,
} from "../../lib/analytics/customer-measurement-context"
import {
  ACCOUNT_WELCOME_CONTEXT,
  ACCOUNT_WELCOME_EVENT,
  welcomeFromResponse,
  welcomeServerLane,
  type WelcomeHolder,
} from "../../lib/account-welcome"

export function captureAccountWelcomeResponse(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (req.method !== "POST") return next()
  const raw = req.headers[MEASUREMENT_HEADER],
    context = requestMeasurementContext(raw, Date.now(), true)
  const holder: WelcomeHolder = {
    request_id: randomUUID(),
    lane: raw !== undefined && !context ? "unavailable" : welcomeServerLane(),
    context,
    customers: [],
  }
  req.scope.register({ [ACCOUNT_WELCOME_CONTEXT]: asValue(holder) })
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
      const source = welcomeFromResponse(holder, body)
      if (source) {
        try {
          void Promise.resolve(
            req.scope
              .resolve(Modules.EVENT_BUS)
              .emit({ name: ACCOUNT_WELCOME_EVENT, data: source })
          ).catch(() =>
            req.scope
              .resolve("logger")
              .warn("[account-welcome] source notification unavailable")
          )
        } catch {
          req.scope
            .resolve("logger")
            .warn("[account-welcome] source notification unavailable")
        }
      }
    }
    return json(body)
  }) as typeof res.json
  return next()
}
