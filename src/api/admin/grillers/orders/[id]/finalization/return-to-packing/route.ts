import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  FINALIZATION_PACKED_PENDING_REVIEW,
  appendStaffAudit,
  metadataObject,
  returnFinalizationToPacking,
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
    action: "return_to_packing",
    path: "src/api/admin/grillers/orders/[id]/finalization/return-to-packing/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)
  const body = (req.body || {}) as Record<string, any>
  const staffAudit = staffAuditFields(req, body)
  const actor = staffAuditActorId(staffAudit)
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "Front office requested packing correction before charge."
  try {
    const detail = await withInstitutionalFinalizationWrite(db, order, async (workDb) => {
      const detail = await returnFinalizationToPacking(workDb, order, actor, reason)
      const metadata = appendStaffAudit(
        {
          ...metadataObject(order.metadata),
          finalization_id: detail.finalization.id,
          finalization_status: FINALIZATION_PACKED_PENDING_REVIEW,
          catch_weight_status: FINALIZATION_PACKED_PENDING_REVIEW,
        },
        {
          action: "catch_weight_returned_to_packing",
          status: FINALIZATION_PACKED_PENDING_REVIEW,
          reason,
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
      action: "return_to_packing",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/return-to-packing/route.ts",
      status: 409,
    })
    return jsonError(
      res,
      409,
      error instanceof Error
        ? error.message
        : "Could not return order to packing."
    )
  }
}
