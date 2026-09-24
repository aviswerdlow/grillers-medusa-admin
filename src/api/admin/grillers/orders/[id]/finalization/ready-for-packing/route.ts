import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  FINALIZATION_READY_FOR_PACKING,
  appendStaffAudit,
  markFinalizationReadyForPacking,
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
    action: "ready_for_packing",
    path: "src/api/admin/grillers/orders/[id]/finalization/ready-for-packing/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)
  const body = (req.body || {}) as Record<string, any>
  const staffAudit = staffAuditFields(req, body)
  const actor = staffAuditActorId(staffAudit)

  try {
    const detail = await withInstitutionalFinalizationWrite(db, order, async (workDb) => {
      const detail = await markFinalizationReadyForPacking(workDb, order, actor)
      const metadata = appendStaffAudit(
        {
          ...metadataObject(order.metadata),
          finalization_id: detail.finalization.id,
          finalization_status: FINALIZATION_READY_FOR_PACKING,
          catch_weight_status: FINALIZATION_READY_FOR_PACKING,
        },
        {
          action: "catch_weight_ready_for_packing",
          status: FINALIZATION_READY_FOR_PACKING,
          ...staffAudit,
        }
      )
      await orderModule.updateOrders(order.id, { metadata })
      return detail
    })

    res.status(200).json({
      order,
      finalization: detail.finalization,
      lines: detail.lines,
    })
  } catch (error) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: "ready_for_packing",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/ready-for-packing/route.ts",
      status: 409,
    })
    return jsonError(
      res,
      409,
      error instanceof Error
        ? error.message
        : "Could not mark order ready for packing."
    )
  }
}
