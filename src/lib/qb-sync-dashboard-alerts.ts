import type { MedusaRequest } from "@medusajs/framework/http"

import { emitOpsAlert, type OpsAlertSeverity } from "./ops-alert"

type QbSyncDashboardOperation = "status" | "requeue"

type QbSyncDashboardAlertInput = {
  req: MedusaRequest
  operation: QbSyncDashboardOperation
  reason: "upstream_error" | "unreachable" | "invalid_response"
  baseUrl: string
  status?: number | null
  syncQueueId?: string | null
  error?: unknown
  logger?: {
    warn?: (message: string) => void
    error?: (message: string) => void
  }
}

function syncHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host
  } catch {
    return ""
  }
}

function redactedMessage(error: unknown) {
  if (error === undefined || error === null) return ""
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  } else {
    try {
      message = JSON.stringify(error)
    } catch {
      message = String(error)
    }
  }
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:order|cart|pi|seti|cus|pm)_[A-Za-z0-9_]+/g, "[redacted-id]")
    .slice(0, 300)
}

function severityForOperation(
  operation: QbSyncDashboardOperation,
  reason: QbSyncDashboardAlertInput["reason"],
  status: number | null
): OpsAlertSeverity {
  if (operation !== "requeue") return "warn"
  if (reason === "unreachable") return "page"
  if (status === 401 || status === 403 || (status !== null && status >= 500)) {
    return "page"
  }
  return "warn"
}

export async function emitQbSyncDashboardFailureAlert(
  input: QbSyncDashboardAlertInput
) {
  const authContext = (input.req as any).auth_context || {}
  const status = input.status ?? null
  const severity = severityForOperation(input.operation, input.reason, status)

  return emitOpsAlert({
    alertKind: "qbd_sync_dashboard_failed",
    severity,
    path: "src/api/admin/grillers/quickbooks-sync",
    title:
      input.operation === "requeue"
        ? "QuickBooks sync requeue failed"
        : "QuickBooks sync status check failed",
    fingerprint: `qbd_sync_dashboard:${input.operation}:${input.reason}:${
      status ?? "network"
    }`,
    meta: {
      operation: input.operation,
      reason: input.reason,
      status,
      sync_queue_id: input.syncQueueId || null,
      sync_host: syncHost(input.baseUrl),
      staff_actor_id: authContext.actor_id || null,
      error_message: redactedMessage(input.error),
    },
    logger: input.logger as any,
  })
}
