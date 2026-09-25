import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  appendStaffAudit,
  ensureFinalizationForOrder,
  metadataObject,
  updateFinalizationLine,
} from "../../../../../../../../lib/catch-weight-finalization"
import { withInstitutionalFinalizationWrite } from "../../../../../../../../lib/gp-institutional-finalization-lock"
import {
  emitFinalizationRouteFailureAlert,
  jsonError,
  loadFinalizationOrderForRoute,
  staffAuditFields,
} from "../../utils"

export const PATCH = async (req: MedusaRequest, res: MedusaResponse) => {
  const order = await loadFinalizationOrderForRoute(req, res, {
    action: "update_finalization_line",
    path: "src/api/admin/grillers/orders/[id]/finalization/lines/[lineId]/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)
  const body = (req.body || {}) as Record<string, any>
  const staffAudit = staffAuditFields(req, body)

  try {
    const line = await withInstitutionalFinalizationWrite(db, order, async (workDb) => {
      await ensureFinalizationForOrder(workDb, order)
      const line = await updateFinalizationLine(workDb, order.id, req.params.lineId, body)
      const finalization = await workDb("gp_order_finalization")
        .where({ id: line.finalization_id })
        .whereNull("deleted_at")
        .first()
      const finalizationStatus = finalization?.status || "picking"
      const metadata = appendStaffAudit(
        {
          ...metadataObject(order.metadata),
          finalization_status: finalizationStatus,
          catch_weight_status: finalizationStatus,
        },
        {
          action: "catch_weight_line_updated",
          status: finalizationStatus,
          line_item_id: req.params.lineId,
          ...staffAudit,
        }
      )
      await orderModule.updateOrders(order.id, { metadata })
      return line
    })

    res.status(200).json({ line })
  } catch (error) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: "update_finalization_line",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/lines/[lineId]/route.ts",
      status: 400,
    })
    return jsonError(
      res,
      400,
      error instanceof Error ? error.message : "Could not update item."
    )
  }
}
