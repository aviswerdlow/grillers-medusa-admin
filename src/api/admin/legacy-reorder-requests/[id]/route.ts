import { verifiedStaffActorId } from "../../../../lib/staff-principal"
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

const ALLOWED_STATUSES = new Set([
  "submitted",
  "contacted",
  "mapped",
  "resolved",
  "dismissed",
  "notification_failed",
])

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim()
  return text.length ? text : null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const id = String(req.params.id)
  const body = (req.body ?? {}) as {
    request_status?: string
    staff_note?: string
  }
  const requestStatus = normalizeText(body.request_status)

  if (!requestStatus || !ALLOWED_STATUSES.has(requestStatus)) {
    res.status(400).json({ message: "Invalid request status" })
    return
  }

  const actorId = normalizeText(verifiedStaffActorId(req))
  const now = new Date()
  const existing = await db("legacy_reorder_request")
    .select("id")
    .where("id", id)
    .whereNull("deleted_at")
    .first()

  if (!existing) {
    res.status(404).json({ message: "Reorder request not found" })
    return
  }

  await db("legacy_reorder_request")
    .where("id", id)
    .update({
      request_status: requestStatus,
      metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({
          staff_note: normalizeText(body.staff_note),
          status_updated_at: now.toISOString(),
          status_updated_by: actorId,
        }),
      ]),
      updated_at: now,
    })

  res.json({ ok: true, id, status: requestStatus })
}
