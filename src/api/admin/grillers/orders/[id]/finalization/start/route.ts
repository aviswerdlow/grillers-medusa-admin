import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  FINALIZATION_PICKING,
  FINALIZATION_READY_FOR_PACKING,
  FINALIZATION_PACKING,
  appendStaffAudit,
  ensureFinalizationForOrder,
  metadataObject,
  prepareFinalizationLinesForPacking,
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
  const body = (req.body || {}) as { phase?: string }
  const staffAudit = staffAuditFields(req, body)
  const actor = staffAuditActorId(staffAudit)
  const phase = body.phase === "pack" ? "pack" : "pick"
  const nextStatus =
    phase === "pack" ? FINALIZATION_PACKING : FINALIZATION_PICKING
  const order = await loadFinalizationOrderForRoute(req, res, {
    action: phase === "pack" ? "start_packing" : "start_picking",
    path: "src/api/admin/grillers/orders/[id]/finalization/start/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)

  try {
    const { detail, lines } = await withInstitutionalFinalizationWrite(db, order, async (workDb) => {
      const detail = await ensureFinalizationForOrder(workDb, order, nextStatus)
      if (phase === "pack" && ![
        FINALIZATION_READY_FOR_PACKING,
        FINALIZATION_PACKING,
        "packed_pending_review",
        "packed_pending_charge",
        "charge_failed_hold",
      ].includes(detail.finalization.status)) {
        throw new Error("This order must be marked ready for packing before a packer starts.")
      }
      const lines = phase === "pack"
        ? await prepareFinalizationLinesForPacking(workDb, detail.lines, actor)
        : detail.lines
      await workDb("gp_order_finalization")
        .where({ id: detail.finalization.id })
        .update({
          status: nextStatus,
          started_at: detail.finalization.started_at || new Date(),
          started_by: detail.finalization.started_by || actor,
          packed_at: phase === "pack" ? detail.finalization.packed_at || new Date() : null,
          packed_by: phase === "pack" ? detail.finalization.packed_by || actor : null,
          updated_at: new Date(),
        })
      const metadata = appendStaffAudit(
        {
          ...metadataObject(order.metadata),
          finalization_id: detail.finalization.id,
          finalization_status: nextStatus,
          catch_weight_status: nextStatus,
        },
        {
          action: phase === "pack" ? "catch_weight_packing_started" : "catch_weight_picking_started",
          status: nextStatus,
          ...staffAudit,
        }
      )
      await orderModule.updateOrders(order.id, { metadata })
      return { detail, lines }
    })

    res.status(200).json({
      order,
      finalization: {
        ...detail.finalization,
        status: nextStatus,
        started_by: detail.finalization.started_by || actor,
        packed_by:
          phase === "pack" ? detail.finalization.packed_by || actor : null,
      },
      lines,
    })
  } catch (error) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: phase === "pack" ? "start_packing" : "start_picking",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/start/route.ts",
      status: 409,
    })
    return jsonError(
      res,
      409,
      error instanceof Error
        ? error.message
        : "Could not start finalization work."
    )
  }
}
