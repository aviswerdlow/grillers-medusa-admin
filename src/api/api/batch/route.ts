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
  const events = Array.isArray(body.events) ? body.events : []
  if (!events.length || events.length > 50) {
    res.status(400).json({ ok: false, error: "events must contain 1-50 items" })
    return
  }

  const decisions = events.map((event: unknown) =>
    classifyMeasurement(event, undefined, body)
  )
  // Refuse the entire mixed request before writes if any member violates the
  // measurement boundary. A missing event name retains the old counted-drop behavior.
  for (const decision of decisions) {
    if (
      decision.status === "rejected" &&
      decision.reason !== "missing_event_name"
    ) {
      res
        .status(decision.httpStatus)
        .json({ ok: false, error: decision.reason })
      return
    }
  }
  const ignoredCount = decisions.filter(
    (decision: any) => decision.status === "ignored"
  ).length
  const logger = communicationsApiLogger(req)
  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const rows: Array<Record<string, any>> = []
    let droppedCount = 0
    let sampleEventKeys: string[] = []

    for (const [index, decision] of decisions.entries()) {
      const raw = events[index]
      if (decision.status === "ignored") continue
      if (decision.status === "rejected") {
        droppedCount += 1
        if (sampleEventKeys.length === 0 && raw && typeof raw === "object") {
          sampleEventKeys = Object.keys(raw).slice(0, 20)
        }
        continue
      }
      rows.push(await recordCommunicationEvent(db, decision.event))
    }
    if (droppedCount > 0) {
      await emitCommunicationsApiDroppedEventsAlert({
        operation: "batch",
        path: "src/api/api/batch/route.ts",
        eventCount: events.length,
        acceptedCount: rows.length,
        droppedCount,
        reason: "missing_event_name",
        sampleEventKeys,
        logger,
      })
    }
    res
      .status(202)
      .json({
        ok: true,
        accepted: rows.length,
        ...(ignoredCount ? { ignored: ignoredCount } : {}),
      })
  } catch (error) {
    await emitCommunicationsApiFailureAlert({
      operation: "batch",
      path: "src/api/api/batch/route.ts",
      eventCount: events.length,
      error,
      logger,
    })
    res.status(500).json({ ok: false, error: "batch_record_failed" })
  }
}
