import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { CATCH_WEIGHT_ORDER_FIELDS } from "../../../../../../lib/catch-weight-finalization"
import { verifiedStaffActorId, verifiedStaffAuditFields } from "../../../../../../lib/staff-principal"
import { emitOpsAlert } from "../../../../../../lib/ops-alert"

export function jsonError(
  res: MedusaResponse,
  status: number,
  message: string,
  extra?: Record<string, any>
) {
  res.status(status).json({ message, ...(extra || {}) })
}

export async function retrieveFinalizationOrder(
  req: MedusaRequest,
  orderId: string
) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: CATCH_WEIGHT_ORDER_FIELDS,
    filters: { id: orderId },
  })
  return data?.[0] || null
}

export async function loadFinalizationOrderForRoute(
  req: MedusaRequest,
  res: MedusaResponse,
  input: {
    action: string
    path: string
    failureMessage?: string
  }
) {
  try {
    const order = await retrieveFinalizationOrder(req, req.params.id)

    if (!order) {
      jsonError(res, 404, "Order was not found.")
      return null
    }

    return order
  } catch (error) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: input.action,
      error,
      orderId: req.params.id,
      path: input.path,
      status: 500,
    })
    jsonError(
      res,
      500,
      input.failureMessage || "Could not load finalization order."
    )
    return null
  }
}

export function actorId(req: MedusaRequest) {
  return verifiedStaffActorId(req)
}

export function staffAuditFields(req: MedusaRequest, _body?: Record<string, any> | null) {
  return verifiedStaffAuditFields(req)
}

export function staffAuditActorId(fields: Record<string, any>) {
  return fields.staff_actor_customer_id || fields.staff_actor_id || null
}

function routeErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error || "Unknown error")

  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(
      /\b(?:order|cart|pi|pm|py|pay|refund|re|fin|attempt|prod|variant)_[A-Za-z0-9_]+/g,
      "[redacted-id]"
    )
}

export async function emitFinalizationRouteFailureAlert(input: {
  req: MedusaRequest
  action: string
  error: unknown
  order?: Record<string, any> | null
  orderId?: string | null
  path: string
  status: number
}) {
  const logger = input.req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const message = routeErrorMessage(input.error)

  return emitOpsAlert({
    alertKind: "catch_weight_finalization_route_failed",
    title: `Catch-weight finalization route failed: ${input.action}`,
    path: input.path,
    source: "medusa-server",
    severity: "page",
    logger,
    meta: {
      action: input.action,
      order_id: input.order?.id || input.orderId || null,
      route_status: input.status,
      error_message: message.slice(0, 500),
    },
  })
}
