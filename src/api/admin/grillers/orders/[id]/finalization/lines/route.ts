import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  addFinalizationLine,
  appendStaffAudit,
  metadataObject,
} from "../../../../../../../lib/catch-weight-finalization"
import { withInstitutionalFinalizationWrite } from "../../../../../../../lib/gp-institutional-finalization-lock"
import {
  emitFinalizationRouteFailureAlert,
  jsonError,
  loadFinalizationOrderForRoute,
  staffAuditActorId,
  staffAuditFields,
} from "../utils"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const order = await loadFinalizationOrderForRoute(req, res, {
    action: "add_finalization_line",
    path: "src/api/admin/grillers/orders/[id]/finalization/lines/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)
  const body = (req.body || {}) as Record<string, any>
  const staffAudit = staffAuditFields(req, body)
  const actor = staffAuditActorId(staffAudit)

  try {
    const line = await withInstitutionalFinalizationWrite(db, order, async (workDb) => {
      const line = await addFinalizationLine(workDb, order, body, actor)
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
          action: "catch_weight_line_added",
          status: finalizationStatus,
          line_item_id: line.line_item_id,
          variant_id: line.variant_id,
          sku: line.sku,
          ...staffAudit,
        }
      )
      await orderModule.updateOrders(order.id, { metadata })
      return line
    })

    res.status(200).json({ line })
  } catch (error: any) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: "add_finalization_line",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/lines/route.ts",
      status: 400,
    })
    return jsonError(res, 400, error?.message || "Could not add item.")
  }
}
