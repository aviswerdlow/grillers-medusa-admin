import { verifiedStaffActorId } from "../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createOrUpdateSegment } from "../../../../../lib/communications/admin"
import {
  emitAdminCommunicationsRouteFailureAlert,
  respondAdminCommunicationsRouteFailure,
} from "../_shared/alerts"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const segments = await db("gp_segment")
      .whereNull("deleted_at")
      .select("*")
      .orderBy("name", "asc")
    res.status(200).json({ segments })
  } catch (error) {
    await respondAdminCommunicationsRouteFailure({
      req,
      res,
      action: "list_segments",
      error,
      errorCode: "segment_list_failed",
      meta: {},
    })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Record<string, any>
  if (!body.name || typeof body.name !== "string") {
    res.status(400).json({ error: "name is required" })
    return
  }
  if (!body.definition || typeof body.definition !== "object") {
    res.status(400).json({ error: "definition object is required" })
    return
  }
  try {
    const result = await createOrUpdateSegment(req.scope, {
      key: body.key || null,
      name: body.name,
      description: body.description || null,
      definition: body.definition,
      created_by: verifiedStaffActorId(req) || null,
    })
    res.status(201).json(result)
  } catch (error) {
    await emitAdminCommunicationsRouteFailureAlert({
      req,
      action: "create_segment",
      error,
      meta: { name: String(body.name || "").slice(0, 60) },
    })
    res.status(500).json({ ok: false, error: "segment_create_failed" })
  }
}
