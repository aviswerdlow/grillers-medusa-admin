import {
  classifyMeasurement,
  measurementKeyConfigured,
} from "../_shared/measurement-ingress"
import { setCorsHeaders } from "../_shared/cors"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  recordCommunicationEvent,
  verifyServiceApiKey,
} from "../../../lib/communications/core"
import {
  communicationsApiLogger,
  emitCommunicationsApiDroppedEventsAlert,
  emitCommunicationsApiFailureAlert,
} from "../_shared/alerts"

function headerMap(req: MedusaRequest): Record<string, string> {
  const headers = req.headers as any
  return {
    authorization:
      headers.authorization || headers.get?.("authorization") || "",
    "x-api-key": headers["x-api-key"] || headers.get?.("x-api-key") || "",
  }
}

function sampleEventKeys(body: unknown) {
  return body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body as Record<string, any>).slice(0, 20)
    : []
}

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!setCorsHeaders(req, res)) {
    res.status(403).send("")
    return
  }

  res.status(204).send("")
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!setCorsHeaders(req, res)) {
    res.status(403).json({ ok: false, error: "origin_not_allowed" })
    return
  }

  if (!measurementKeyConfigured() || !verifyServiceApiKey(headerMap(req))) {
    res.status(401).json({ ok: false, error: "unauthorized" })
    return
  }

  const body = (req.body || {}) as Record<string, any>
  const decision = classifyMeasurement(body)
  const logger = communicationsApiLogger(req)
  if (decision.status === "ignored") {
    res.status(202).json({ ok: true, accepted: 0, ignored: decision.reason })
    return
  }
  if (decision.status === "rejected") {
    if (decision.reason === "missing_event_name") {
      await emitCommunicationsApiDroppedEventsAlert({
        operation: "track",
        path: "src/api/api/track/route.ts",
        eventCount: 1,
        acceptedCount: 0,
        droppedCount: 1,
        reason: decision.reason,
        sampleEventKeys: sampleEventKeys(body),
        logger,
      })
    }
    res
      .status(decision.httpStatus)
      .json({
        ok: false,
        error:
          decision.reason === "missing_event_name"
            ? "event is required"
            : decision.reason,
      })
    return
  }
  const event = decision.event

  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const row = await recordCommunicationEvent(db, event)
    res.status(202).json({ ok: true, event_id: row.event_id })
  } catch (error) {
    await emitCommunicationsApiFailureAlert({
      operation: "track",
      path: "src/api/api/track/route.ts",
      eventName: event.event_name,
      hasEmail: Boolean(event.email),
      error,
      logger,
    })
    res.status(500).json({ ok: false, error: "event_record_failed" })
  }
}
