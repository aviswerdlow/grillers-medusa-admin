import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { timingSafeEqual } from "node:crypto"
import { emitOpsAlert } from "../../../../../../lib/ops-alert"
import { acknowledgeQbdPosting, QbdPostingConflict, type QbdPostingReceipt } from "../../../../../../lib/qbd-posting-outbox"

type MetadataBody = {
  metadata?: Record<string, unknown>
  posting_receipt?: QbdPostingReceipt
}

const ALERT_PATH = "src/api/api/qb-sync/orders/[id]/metadata/route.ts"
const QBD_POSTING_METADATA_KEYS = [
  "qbd_posting_required",
  "qbd_posting_status",
  "qbd_posting_action",
  "qbd_posting_amount",
  "qbd_posting_request_key",
  "qbd_posting_requested_at",
  "qbd_posted_at",
  "qbd_write_job_id",
  "qbd_txn_id",
  "qbd_ref_number",
  "qbd_error",
]

const header = (req: MedusaRequest, name: string): string => {
  const headers = req.headers as any
  return headers[name.toLowerCase()] || headers.get?.(name) || ""
}

const metadataObject = (value: unknown): Record<string, unknown> => {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {}
    } catch {
      return {}
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) }
  }
  return {}
}

const secureCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

const authorized = (req: MedusaRequest): boolean => {
  // Trim both sides. A stray trailing newline in the stored secret (e.g. from
  // `echo … | railway variable set`) would otherwise never match the caller's
  // token: HTTP strips trailing whitespace from header values, and secureCompare
  // requires an exact byte-length match, so 65-byte-env vs 64-byte-header => 401
  // on every callback. See ops runbook 2026-07-03 (silent writeback failure).
  const token = (process.env.QB_SYNC_ORDER_IMPORT_TOKEN || "").trim()
  if (!token) return false

  const provided = (
    header(req, "x-qb-sync-token") ||
    header(req, "authorization").replace(/^Bearer\s+/i, "")
  ).trim()

  return provided ? secureCompare(provided, token) : false
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "")
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:order|cart|pi|seti|cus|pm)_[A-Za-z0-9_]+/g, "[redacted-id]")
    .slice(0, 500)
}

function routeLogger(req: MedusaRequest) {
  try {
    return req.scope.resolve("logger")
  } catch {
    return undefined
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function postingRequestKey(metadata: Record<string, unknown>): string {
  return textValue(metadata.qbd_posting_request_key)
}

function touchesQbdPosting(metadata: Record<string, unknown>): boolean {
  return QBD_POSTING_METADATA_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(metadata, key)
  )
}

async function emitQbMetadataRouteFailureAlert(input: {
  req: MedusaRequest
  orderId?: string | null
  reason: "configuration" | "metadata_persist" | "request_key_mismatch"
  error?: unknown
  meta?: Record<string, unknown>
}) {
  await emitOpsAlert({
    alertKind: "qbd_order_metadata_update_failed",
    // A stale-key rejection is the guard WORKING (it protected manually
    // cleared orders from being clobbered) — warn-digest material, not a
    // page. Real callback failures (configuration/persist) still page.
    severity: input.reason === "request_key_mismatch" ? "warn" : "page",
    title:
      input.reason === "configuration"
        ? "QuickBooks metadata callback is not configured"
        : input.reason === "request_key_mismatch"
          ? "QuickBooks metadata callback rejected a stale request key"
        : "QuickBooks metadata callback failed",
    path: ALERT_PATH,
    source: "medusa-server",
    fingerprint: `qbd_order_metadata_update:${input.reason}`,
    logger: routeLogger(input.req) as any,
    meta: {
      reason: input.reason,
      has_order_id: Boolean(input.orderId),
      order_id: input.orderId || null,
      error_message: input.error ? redactedErrorMessage(input.error) : null,
      ...(input.meta || {}),
    },
  })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  // Check the TRIMMED value so a blank-after-trim secret (e.g. env set to just
  // "\n") surfaces as a loud 503 + configuration page-alert here, rather than
  // trimming to "" inside authorized() and silently 401-ing every callback.
  if (!(process.env.QB_SYNC_ORDER_IMPORT_TOKEN || "").trim()) {
    await emitQbMetadataRouteFailureAlert({
      req,
      orderId: String(req.params?.id || ""),
      reason: "configuration",
      error: new Error("QB_SYNC_ORDER_IMPORT_TOKEN is not configured"),
    })
    res.status(503).json({ error: "QuickBooks metadata callback is not configured" })
    return
  }

  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }

  const orderId = req.params.id
  const body = (req.body ?? {}) as MetadataBody
  if (body.posting_receipt) {
    try {
      const result = await acknowledgeQbdPosting(req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION), orderId, body.posting_receipt)
      return res.status(200).json({ ok: true, request_key: body.posting_receipt.request_key, replayed: result.replayed })
    } catch (error) {
      if (error instanceof QbdPostingConflict) return res.status(409).json({ error: error.message })
      await emitQbMetadataRouteFailureAlert({ req, orderId, reason: "metadata_persist", error })
      return res.status(503).json({ error: "Accounting receipt could not be stored; retry the same receipt." })
    }
  }
  const incomingMetadata = metadataObject(body.metadata)

  if (!orderId || Object.keys(incomingMetadata).length === 0) {
    res.status(422).json({ error: "Missing order id or metadata" })
    return
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER)
    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "metadata"],
    })

    const existingMetadata = metadataObject(order?.metadata)
    if (existingMetadata.qbd_posting_outbox_version === 1 && touchesQbdPosting(incomingMetadata)) {
      return res.status(409).json({ error: "Managed accounting actions require an exact posting_receipt; the display metadata cannot acknowledge them." })
    }
    const existingRequestKey = postingRequestKey(existingMetadata)
    const incomingRequestKey = postingRequestKey(incomingMetadata)

    if (
      touchesQbdPosting(incomingMetadata) &&
      existingRequestKey &&
      incomingRequestKey !== existingRequestKey
    ) {
      await emitQbMetadataRouteFailureAlert({
        req,
        orderId,
        reason: "request_key_mismatch",
        meta: {
          has_existing_request_key: true,
          has_incoming_request_key: Boolean(incomingRequestKey),
          existing_posting_status:
            textValue(existingMetadata.qbd_posting_status) || null,
          incoming_posting_status:
            textValue(incomingMetadata.qbd_posting_status) || null,
        },
      })
      res.status(409).json({
        error: "QuickBooks metadata request key mismatch",
      })
      return
    }

    const metadata = {
      ...existingMetadata,
      ...incomingMetadata,
    }

    await orderModule.updateOrders(orderId, { metadata })
  } catch (error) {
    await emitQbMetadataRouteFailureAlert({
      req,
      orderId,
      reason: "metadata_persist",
      error,
    })
    res.status(500).json({ error: "QuickBooks metadata update failed" })
    return
  }

  res.status(200).json({ ok: true, order_id: orderId })
}
