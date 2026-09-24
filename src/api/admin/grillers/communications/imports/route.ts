import { verifiedStaffActorId } from "../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { importConstantContactPayload } from "../../../../../lib/communications/imports"
import { emitAdminCommunicationsRouteFailureAlert } from "../_shared/alerts"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Record<string, any>
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length) {
    res.status(400).json({ error: "rows array is required" })
    return
  }

  try {
    const result = await importConstantContactPayload(req.scope, rows, {
      uploaded_by: verifiedStaffActorId(req) || null,
      filename: body.filename || null,
    })
    res.status(202).json({ ok: true, ...result })
  } catch (error) {
    await emitAdminCommunicationsRouteFailureAlert({
      req,
      action: "import_constant_contact",
      error,
      meta: {
        row_count: rows.length,
        has_filename: Boolean(body.filename),
      },
    })
    res.status(500).json({ ok: false, error: "import_failed" })
  }
}
