import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { previewFinalization } from "../../../../../../lib/catch-weight-finalization"
import { withInstitutionalFinalizationWrite } from "../../../../../../lib/gp-institutional-finalization-lock"
import {
  emitFinalizationRouteFailureAlert,
  jsonError,
  retrieveFinalizationOrder,
} from "./utils"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  let order: Record<string, any> | null = null

  try {
    order = await retrieveFinalizationOrder(req, req.params.id)

    if (!order) {
      return jsonError(res, 404, "Order was not found.")
    }

    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const detail = await withInstitutionalFinalizationWrite(
      db, order,
      (workDb) => previewFinalization(workDb, order!, { persist: false }),
      { readReleased: true }
    )

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
      action: "load_finalization_detail",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/route.ts",
      status: 500,
    })
    return jsonError(res, 500, "Could not load finalization.")
  }
}
