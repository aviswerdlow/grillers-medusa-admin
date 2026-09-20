import { verifiedStaffAuditFields } from "../../../../lib/staff-principal"
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  LegacyReorderRequestError,
  notificationModuleFromScope,
  submitLegacyReorderRequest,
} from "../../../../lib/legacy-reorder-request"
import { emitOpsAlert } from "../../../../lib/ops-alert"

type AdminReorderRequestBody = {
  customer_id?: string
  key?: string
  staff_actor_customer_id?: string
  staff_actor_email?: string
  staff_actor_name?: string
  staff_note?: string
}

const normalizeText = (value: unknown): string | null => {
  const text = String(value ?? "").trim()
  return text.length ? text : null
}

function sendResult(res: MedusaResponse, result: any) {
  const { httpStatus, ...body } = result
  res.status(httpStatus).json(body)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as AdminReorderRequestBody
  const customerId = normalizeText(body.customer_id)
  const key = normalizeText(body.key)

  if (!customerId) {
    res.status(400).json({ message: "Missing customer_id" })
    return
  }
  if (!key) {
    res.status(400).json({ message: "Missing purchase history key" })
    return
  }

  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  try {
    const result = await submitLegacyReorderRequest({
      db,
      notificationModule: notificationModuleFromScope(req.scope),
      logger,
      customerId,
      key,
      source: "admin_staff_reorder",
      metadata: {
        staff_actor_customer_id: verifiedStaffAuditFields(req).staff_actor_customer_id,
        staff_actor_email: verifiedStaffAuditFields(req).staff_actor_email,
        staff_actor_name: verifiedStaffAuditFields(req).staff_actor_name,
        staff_note: normalizeText(body.staff_note),
      },
    })
    sendResult(res, result)
  } catch (err) {
    if (err instanceof LegacyReorderRequestError) {
      res.status(err.statusCode).json({ message: err.message })
      return
    }

    const message = err instanceof Error ? err.message : String(err)
    logger?.error?.(
      `[legacy-reorder-request] admin submit failed customer=${customerId}: ${message}`
    )
    await emitOpsAlert({
      alertKind: "legacy_reorder_request_failed",
      severity: "page",
      path: "src/api/admin/legacy-order-history/reorder-request/route.ts",
      title: "Staff legacy reorder request failed",
      fingerprint: "legacy_reorder_request:admin:500",
      meta: {
        customer_id: customerId,
        staff_actor_customer_id: verifiedStaffAuditFields(req).staff_actor_customer_id,
        source: "admin_staff_reorder",
        has_key: Boolean(key),
        error_name: err instanceof Error ? err.name : undefined,
        error_message: message.slice(0, 300),
      },
      logger,
    })
    res.status(500).json({
      message: "Could not submit reorder request. Please try again.",
    })
  }
}
