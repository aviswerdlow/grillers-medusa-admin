import { verifiedStaffActorId } from "../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../../../../../lib/ops-alert"

const redactedErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error || "Unknown error"))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:gpcamp|gpmsg|gpprof|seg|flow)_[A-Za-z0-9_]+/g, "[redacted-id]")
    .slice(0, 500)

export async function emitAdminCommunicationsRouteFailureAlert(input: {
  req: MedusaRequest
  action: string
  error: unknown
  status?: number
  meta?: Record<string, unknown>
}) {
  let logger: any
  try {
    logger = input.req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  } catch {
    logger = undefined
  }

  return emitOpsAlert({
    alertKind: "admin_communications_route_failed",
    title: `Admin communications route failed: ${input.action}`,
    path: "src/api/admin/grillers/communications",
    source: "medusa-server",
    severity: "page",
    logger,
    meta: {
      action: input.action,
      actor_id: verifiedStaffActorId(input.req) || null,
      route_status: input.status || 500,
      error_message: redactedErrorMessage(input.error),
      ...(input.meta || {}),
    },
  })
}

export async function respondAdminCommunicationsRouteFailure(input: {
  req: MedusaRequest
  res: MedusaResponse
  action: string
  error: unknown
  errorCode: string
  status?: number
  meta?: Record<string, unknown>
}) {
  const status = input.status || 500
  await emitAdminCommunicationsRouteFailureAlert({
    req: input.req,
    action: input.action,
    error: input.error,
    status,
    meta: input.meta,
  })
  input.res.status(status).json({ ok: false, error: input.errorCode })
}
