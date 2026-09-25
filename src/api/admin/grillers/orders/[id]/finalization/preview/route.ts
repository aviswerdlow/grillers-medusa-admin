import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  appendStaffAudit,
  metadataObject,
  previewFinalization,
} from "../../../../../../../lib/catch-weight-finalization"
import { withInstitutionalFinalizationWrite } from "../../../../../../../lib/gp-institutional-finalization-lock"
import {
  emitFinalizationRouteFailureAlert,
  jsonError,
  loadFinalizationOrderForRoute,
  staffAuditFields,
} from "../utils"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body as Record<string, any> | undefined) || {}
  const persist = Boolean(body.persist)
  const order = await loadFinalizationOrderForRoute(req, res, {
    action: persist ? "persist_finalization_preview" : "preview_finalization",
    path: "src/api/admin/grillers/orders/[id]/finalization/preview/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)

  try {
    const preview = await withInstitutionalFinalizationWrite(
      db, order, async (workDb) => {
        const preview = await previewFinalization(workDb, order, { persist })
        if (persist) {
          const status = preview.finalization.status || "packed_pending_review"
          const metadata = appendStaffAudit(
            {
              ...metadataObject(order.metadata),
              finalization_id: preview.finalization.id,
              finalization_status: status,
              catch_weight_status: status,
              final_total: preview.totals.final_order_total,
              catch_weight_delta: preview.totals.delta_total,
            },
            {
              action: "catch_weight_finalization_previewed",
              status,
              error_count: preview.errors.length,
              ...staffAuditFields(req, body),
            }
          )
          await orderModule.updateOrders(order.id, { metadata })
        }
        return preview
      },
      { readReleased: !persist }
    )

    res.status(200).json({
      order,
      ...preview,
    })
  } catch (error) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: persist ? "persist_finalization_preview" : "preview_finalization",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/preview/route.ts",
      status: 409,
    })
    return jsonError(
      res,
      409,
      error instanceof Error
        ? error.message
        : "Could not preview finalization."
    )
  }
}
