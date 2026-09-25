import { verifiedStaffActorId } from "../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ConstantContactImportInputError,
  importConstantContactPayload,
  type ConstantContactImportBatch,
} from "../../../../../lib/communications/imports"
import { emitAdminCommunicationsRouteFailureAlert } from "../_shared/alerts"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (process.env.GP_CC_IMPORT_ENABLED !== "true") {
    res.status(423).json({ error: "constant_contact_import_disabled" })
    return
  }
  const body = (req.body || {}) as Record<string, any>
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length || !Array.isArray(body.eligibility)) {
    res.status(400).json({ error: "rows and protected eligibility arrays are required" })
    return
  }

  try {
    const result = await importConstantContactPayload(req.scope, body as ConstantContactImportBatch, {
      uploaded_by: verifiedStaffActorId(req) || null,
      filename: body.filename || null,
    })
    res.status(202).json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof ConstantContactImportInputError) {
      res.status(400).json({ ok: false, error: error.message })
      return
    }
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
