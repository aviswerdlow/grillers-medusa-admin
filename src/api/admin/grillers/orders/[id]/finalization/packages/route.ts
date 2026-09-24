import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  FINALIZATION_PACKED_PENDING_REVIEW,
  appendStaffAudit,
  metadataObject,
  previewFinalization,
  updateFinalizationPackages,
} from "../../../../../../../lib/catch-weight-finalization"
import { withInstitutionalFinalizationWrite } from "../../../../../../../lib/gp-institutional-finalization-lock"
import {
  emitFinalizationRouteFailureAlert,
  jsonError,
  loadFinalizationOrderForRoute,
  staffAuditActorId,
  staffAuditFields,
} from "../utils"

type PackagesBody = {
  packages?: Array<{
    package_type?: string | null
    shipper_qbd_list_id?: string | null
    count?: number | string | null
    packed_weight_lb?: number | string | null
    dry_ice_lb?: number | string | null
    note?: string | null
  }>
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body || {}) as PackagesBody
  const packages = Array.isArray(body.packages) ? body.packages : []
  const order = await loadFinalizationOrderForRoute(req, res, {
    action: "update_packages",
    path: "src/api/admin/grillers/orders/[id]/finalization/packages/route.ts",
  })
  if (!order) return

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const orderModule = req.scope.resolve(Modules.ORDER)
  const staffAudit = staffAuditFields(req, body as Record<string, any>)
  const actor = staffAuditActorId(staffAudit)

  try {
    const detail = await withInstitutionalFinalizationWrite(db, order, async (workDb) => {
      await updateFinalizationPackages(workDb, order, packages, actor)
      const detail = await previewFinalization(workDb, order, { persist: false })
      const metadata = appendStaffAudit(
        {
          ...metadataObject(order.metadata),
          finalization_id: detail.finalization.id,
          finalization_status: FINALIZATION_PACKED_PENDING_REVIEW,
          catch_weight_status: FINALIZATION_PACKED_PENDING_REVIEW,
        },
        {
          action: "catch_weight_packages_updated",
          status: FINALIZATION_PACKED_PENDING_REVIEW,
          package_count: detail.packages?.length || 0,
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
      package_capture_required: detail.package_capture_required,
      packages: detail.packages,
      payment_setup: detail.payment_setup,
      charge_attempts: detail.charge_attempts,
      errors: detail.errors,
      warnings: detail.warnings,
      totals: detail.totals,
    })
  } catch (error) {
    await emitFinalizationRouteFailureAlert({
      req,
      action: "update_packages",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/packages/route.ts",
      status: 400,
    })
    return jsonError(
      res,
      400,
      error instanceof Error ? error.message : "Could not update packages."
    )
  }
}
