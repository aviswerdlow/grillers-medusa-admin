import type { MedusaRequest } from "@medusajs/framework/http"
import { emitOpsAlert } from "./ops-alert"

/** Observe existing authenticated traffic first. Invalid explicit settings stay strict. */
export function staffBoundaryMode(): "log" | "enforce" {
  const value = String(process.env.GP_STAFF_BOUNDARY_MODE || "").trim().toLowerCase()
  return !value || value === "log" ? "log" : "enforce"
}

export function reportStaffBoundaryDenial(req: MedusaRequest, boundary: string, reason: string) {
  // No URL parameters, request bodies, emails, tokens or raw error messages.
  const context = { boundary, reason, mode: staffBoundaryMode(), method: req.method,
    transport_type: String((req as any).auth_context?.actor_type || "unknown"),
    transport_id: String((req as any).auth_context?.actor_id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100) }
  let logger: any
  try { logger = req.scope.resolve("logger"); logger?.warn?.(`[staff-boundary] ${JSON.stringify(context)}`) } catch {}
  void emitOpsAlert({ alertKind: "staff_boundary_would_deny", severity: "warn", title: "Staff boundary requires rollout review",
    path: "src/api/middlewares/staff-capabilities.ts", source: "medusa-server", meta: context, logger,
    fingerprint: `staff-boundary:${boundary}:${reason}` }).catch(() => {})
}
