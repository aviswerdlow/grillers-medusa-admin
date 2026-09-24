import type { MedusaRequest } from "@medusajs/framework/http"
import { emitOpsAlert } from "./ops-alert"

/** Observe existing authenticated traffic first. Invalid explicit settings stay strict. */
export function staffBoundaryMode(): "log" | "enforce" {
  const value = String(process.env.GP_STAFF_BOUNDARY_MODE || "").trim().toLowerCase()
  return !value || value === "log" ? "log" : "enforce"
}

const OBSERVATION_WINDOW_MS = 5 * 60 * 1000
const MAX_OBSERVATION_KEYS = 128
const observations = new Map<string, { sentAt: number; suppressed: number }>()

export function reportStaffBoundaryDenial(req: MedusaRequest, boundary: string, reason: string) {
  // Group by the finite server-defined reason, never actor, path or query.
  // This bounds hot-path logs/POSTs per process without requiring Redis.
  const mode = staffBoundaryMode(), now = Date.now(), key = JSON.stringify([mode, boundary, reason])
  const previous = observations.get(key)
  if (previous && now >= previous.sentAt && now - previous.sentAt < OBSERVATION_WINDOW_MS) {
    previous.suppressed = Math.min(previous.suppressed + 1, Number.MAX_SAFE_INTEGER)
    return
  }
  if (!previous && observations.size >= MAX_OBSERVATION_KEYS) {
    const oldest = observations.keys().next().value
    if (oldest !== undefined) observations.delete(oldest)
  }
  observations.set(key, { sentAt: now, suppressed: 0 })
  // No URL parameters, request bodies, emails, tokens or raw error messages.
  const context = { boundary, reason, mode, method: req.method,
    suppressed_since_previous: previous?.suppressed || 0,
    transport_type: String((req as any).auth_context?.actor_type || "unknown"),
    transport_id: String((req as any).auth_context?.actor_id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100) }
  let logger: any
  try { logger = req.scope.resolve("logger"); logger?.warn?.(`[staff-boundary] ${JSON.stringify(context)}`) } catch {}
  void emitOpsAlert({ alertKind: "staff_boundary_would_deny", severity: "warn", title: "Staff boundary requires rollout review",
    path: "src/api/middlewares/staff-capabilities.ts", source: "medusa-server", meta: context, logger,
    fingerprint: `staff-boundary:${boundary}:${reason}` }).catch(() => {})
}
