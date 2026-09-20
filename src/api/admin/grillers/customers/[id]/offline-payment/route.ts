import { requestStaffPrincipal, verifiedStaffActorId } from "../../../../../../lib/staff-principal"
import { configuredIds } from "../../../../../../lib/staff-access-policy"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

import {
  validateOfflinePayment,
  offlinePaymentMetadata,
  readOfflinePaymentMetadata,
  normalizeApproverEmails,
  isApprover,
  type OfflinePaymentInput,
} from "../../../../../../lib/gp-offline-payment"
import {
  appendStaffAudit,
  metadataObject,
} from "../../../../../../lib/catch-weight-finalization"
import {
  readInvoiceApplicationStatus,
  invoiceApplicationDecisionMetadata,
} from "../../../../../../lib/gp-invoice-application"
import { emitOpsAlert } from "../../../../../../lib/ops-alert"

/**
 * #279 / #282 — set/clear a customer's approved offline-payment ("pay by invoice") terms.
 *
 * Only the configured approvers (Peter / Avi / Julie, via GP_OFFLINE_PAYMENT_APPROVER_EMAILS)
 * may call this. Every change is validated and written to the customer's staff_audit_log with
 * the before/after so credit-terms changes are accountable.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = req.params.id
  const actorId = verifiedStaffActorId(req)
  const logger = req.scope.resolve("logger") as
    | { info?: (m: string) => void; error?: (m: string) => void }
    | undefined

  const allowlist = normalizeApproverEmails(
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS
  )
  if (allowlist.length === 0) {
    return res.status(403).json({
      type: "not_authorized",
      message:
        "Offline-payment approvals are not enabled (set GP_OFFLINE_PAYMENT_APPROVER_EMAILS).",
    })
  }

  // Resolve the acting admin user's email for the approver allowlist.
  let actorEmail = ""
  try {
    const principal = requestStaffPrincipal(req)
    if (principal) actorEmail = principal.email || ""
    else {
      const userModule = req.scope.resolve(Modules.USER) as any
      const user = actorId ? await userModule.retrieveUser(actorId, { select: ["id", "email"] }) : null
      actorEmail = user?.email || ""
    }
  } catch {
    actorEmail = ""
  }

  const principal = requestStaffPrincipal(req)
  const approvedIdentity = principal?.kind !== "customer" || configuredIds("GP_INVOICE_APPROVER_CUSTOMER_IDS").has(principal.id)
  if (!approvedIdentity || !isApprover(actorEmail, allowlist)) {
    return res.status(403).json({
      type: "not_authorized",
      message:
        "You are not authorized to approve offline-payment accounts. Ask a designated approver (Peter, Avi, or Julie).",
    })
  }

  // #291: an approver can decline a pending self-serve application without setting terms.
  const declineApplication =
    (req.body as any)?.decline_application === true ||
    (req.body as any)?.decline_application === "true"

  const result = validateOfflinePayment((req.body || {}) as OfflinePaymentInput)
  if (!result.valid) {
    return res.status(400).json({
      type: "invalid_data",
      message: "Please correct the highlighted fields.",
      errors: result.errors,
    })
  }

  const customerModule = req.scope.resolve(Modules.CUSTOMER) as any

  try {
    const customer = await customerModule.retrieveCustomer(customerId, {
      select: ["id", "metadata"],
    })
    const existingMeta = metadataObject(customer?.metadata)
    const before = readOfflinePaymentMetadata(existingMeta)
    const after = result.normalized

    // #291: transition the self-serve invoice application status alongside the terms change.
    const currentAppStatus = readInvoiceApplicationStatus(existingMeta)

    // Codex P2 (x2): a decline only applies to a PENDING, not-yet-approved application. Refuse
    // to "decline" an approved account (even one with stale `pending` metadata) or one with no
    // application — that would wipe its terms via the revoke path. Use the explicit approve
    // toggle (approved=false) to revoke an approved account instead.
    if (declineApplication && (currentAppStatus !== "pending" || before.approved)) {
      return res.status(409).json({
        type: "no_pending_application",
        message:
          "This account has no pending application to decline. Use the approval toggle to change an approved account.",
      })
    }

    let applicationMeta: Record<string, unknown> = {}
    let action = "offline_payment_terms_updated"
    if (declineApplication) {
      applicationMeta = invoiceApplicationDecisionMetadata(
        "declined",
        actorEmail,
        new Date().toISOString()
      )
      action = "invoice_application_declined"
    } else if (after.approved && currentAppStatus === "pending") {
      applicationMeta = invoiceApplicationDecisionMetadata(
        "approved",
        actorEmail,
        new Date().toISOString()
      )
      action = "invoice_application_approved"
    }

    const metadata = appendStaffAudit(
      { ...existingMeta, ...offlinePaymentMetadata(after), ...applicationMeta },
      {
        action,
        staff_actor_id: actorId,
        staff_actor_email: actorEmail,
        before,
        after,
      }
    )

    await customerModule.updateCustomers(customerId, { metadata })
    logger?.info?.(
      `[offline-payment] ${actorEmail} set customer ${customerId} approved=${after.approved} limit=${after.credit_limit}` +
        (applicationMeta.gp_invoice_application_status
          ? ` application=${applicationMeta.gp_invoice_application_status}`
          : "")
    )

    return res.status(200).json({
      customer_id: customerId,
      offline_payment: after,
      ...(applicationMeta.gp_invoice_application_status
        ? {
            application_status:
              applicationMeta.gp_invoice_application_status,
          }
        : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger?.error?.(`[offline-payment] failed for ${customerId}: ${message}`)
    await emitOpsAlert({
      alertKind: "staff_offline_payment_error",
      severity: "page",
      path: "admin/grillers/customers/offline-payment",
      title: "Staff offline-payment terms update failed",
      fingerprint: "staff_offline_payment:update_500",
      meta: {
        customer_id: customerId,
        staff_actor_id: actorId,
        staff_actor_email: actorEmail || undefined,
        error_name: err instanceof Error ? err.name : undefined,
        error_message: message.slice(0, 300),
      },
      logger: logger as any,
    })
    return res.status(500).json({
      type: "server_error",
      message: "Could not update the account's payment terms.",
    })
  }
}
