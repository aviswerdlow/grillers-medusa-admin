import { quoteWwexFinalizationShipping } from "../../../../../../../lib/wwex-finalization-shipment"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  FINALIZATION_PACKED_PENDING_CHARGE,
  appendStaffAudit,
  approveFinalization,
  previewFinalization,
  orderRequiresPackageCapture,
  invoiceArOrderMetadata,
  isInvoiceOrder,
  metadataObject,
} from "../../../../../../../lib/catch-weight-finalization"
import { FINALIZATION_PACKED_PENDING_CHARGE_EVENT } from "../../../../../../../lib/auto-finalize-charge"
import { requestStaffPrincipal } from "../../../../../../../lib/staff-principal"
import {
  institutionalCheckoutAuthority,
  institutionalDollarsToCents,
  institutionalOrderTermsMatch,
  reserveInstitutionalCheckout,
} from "../../../../../../../lib/gp-institutional-checkout"
import { withInstitutionalFinalizationWrite } from "../../../../../../../lib/gp-institutional-finalization-lock"
import { recordDeniedInstitutionalRelease } from "../../../../../../../lib/gp-institutional-override-audit"
import {
  institutionalReleaseIntent,
  persistInstitutionalReleaseIntent,
  reconcileInstitutionalReleaseIntent,
} from "../../../../../../../lib/gp-institutional-release-intent"
import {
  emitFinalizationRouteFailureAlert,
  jsonError,
  loadFinalizationOrderForRoute,
  staffAuditActorId,
  staffAuditFields,
} from "../utils"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const order = await loadFinalizationOrderForRoute(req, res, {
    action: "approve_finalization",
    path: "src/api/admin/grillers/orders/[id]/finalization/approve/route.ts",
  })
  if (!order) return

  let deniedInstitutionalReason: string | null = null
  try {
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const orderModule = req.scope.resolve(Modules.ORDER)
    const body = (req.body || {}) as Record<string, any>
    const staffAudit = staffAuditFields(req, body)
    const { approved, approvedStatus } = await withInstitutionalFinalizationWrite(
      db, order, async (workDb) => {
        let shippingCostMetadata = {}
        if (isInvoiceOrder(order) && orderRequiresPackageCapture(order)) {
          const preview = await previewFinalization(workDb, order)
          const quoted = await quoteWwexFinalizationShipping({
            order,
            preview,
            logger: req.scope.resolve(ContainerRegistrationKeys.LOGGER),
          })
          if (!quoted || quoted.status !== "quoted")
            throw new Error("Shipping needs review before this invoice order can be released.")
          shippingCostMetadata = quoted.metadata
        }
        let reservedCents: number | null = null
        if (isInvoiceOrder(order) && process.env.GP_INSTITUTIONAL_TERMS_ENABLED === "true") {
          const commitmentId = metadataObject(order.metadata).gp_institutional_commitment_id
          if (typeof commitmentId !== "string" || commitmentId !== `cart:${order.cart_id}` ||
              typeof order.customer_id !== "string" || !order.customer_id) {
            throw new Error("Institutional order identity or reservation is unverified.")
          }
          const authority = await institutionalCheckoutAuthority(order.customer_id)
          if (authority.status !== "allow") {
            deniedInstitutionalReason = authority.reason
            throw new Error("Institutional terms need a current account review.")
          }
          if (!institutionalOrderTermsMatch(order.metadata, authority.account)) {
            deniedInstitutionalReason = "qbd_terms_changed"
            throw new Error("Institutional terms changed after checkout and need a new review.")
          }
          const preview = await previewFinalization(workDb, {
            ...order,
            metadata: { ...metadataObject(order.metadata), ...shippingCostMetadata },
          })
          if (preview.errors.length) {
            throw new Error("Finalization cannot be approved until all line errors are fixed.")
          }
          reservedCents = institutionalDollarsToCents(preview.totals.final_order_total)
          const credit = await reserveInstitutionalCheckout({
            db,
            transaction: workDb,
            account: authority.account,
            reservationId: commitmentId,
            amountCents: reservedCents,
          })
          if (credit.status !== "reserved") {
            deniedInstitutionalReason = credit.reason
            throw new Error("Institutional credit is on hold for review.")
          }
        }
        const approved = await approveFinalization(
          workDb,
          order,
          staffAuditActorId(staffAudit)
        )
        if (reservedCents !== null &&
            institutionalDollarsToCents(approved.totals.final_order_total) !== reservedCents) {
          throw new Error("Packed invoice total changed during credit reservation.")
        }
        const approvedStatus = approved.finalization.status
        const metadata = isInvoiceOrder(order)
          ? invoiceArOrderMetadata({
              order: {
                ...order,
                metadata: { ...metadataObject(order.metadata), ...shippingCostMetadata },
              },
              finalization: approved.finalization,
              lines: approved.lines,
              packages: approved.packages,
              actorId: staffAuditActorId(staffAudit),
              staffAudit,
            })
          : appendStaffAudit(
              {
                ...metadataObject(order.metadata),
                finalization_id: approved.finalization.id,
                finalization_status: approvedStatus,
                catch_weight_status: approvedStatus,
                final_total: approved.totals.final_order_total,
                catch_weight_delta: approved.totals.delta_total,
              },
              {
                action: "catch_weight_finalization_approved",
                status: approvedStatus,
                ...staffAudit,
              }
            )
        if (reservedCents !== null) {
          const intent = institutionalReleaseIntent({
            orderId: order.id,
            commitmentId: metadataObject(order.metadata).gp_institutional_commitment_id,
            baseMetadata: order.metadata,
            targetMetadata: metadata,
            amountCents: reservedCents,
          })
          await persistInstitutionalReleaseIntent(workDb, approved.finalization.id, intent)
        } else {
          await orderModule.updateOrders(order.id, { metadata })
        }
        return { approved, approvedStatus }
      }
    )
    if (isInvoiceOrder(order) && process.env.GP_INSTITUTIONAL_TERMS_ENABLED === "true") {
      // The credit and finalization transaction has committed. Only now may
      // the order.updated path expose the unpaid invoice to the QBD writer.
      const result = await reconcileInstitutionalReleaseIntent({
        db, orderModule, orderId: order.id,
      })
      if (result.status !== "applied") {
        throw new Error("Institutional release needs reconciliation before fulfillment.")
      }
    }

    // #9/#235: signal the fixed-price auto-charge trigger. Only for card orders now awaiting
    // the final charge (packed_pending_charge) — never invoice orders, which approve releases
    // straight to fulfillment. Best-effort: a failed emit must NOT fail the human approve — the
    // order simply waits for a manual charge. The subscriber is flag-gated (default OFF) and
    // fails safe, so emitting is a harmless no-op when auto-charge is disabled.
    const principal = requestStaffPrincipal(req)
    const canTriggerCharge = principal?.kind === "operator" || principal?.capabilities.has("charge") === true
    if (approvedStatus === FINALIZATION_PACKED_PENDING_CHARGE && canTriggerCharge) {
      try {
        const eventBus = req.scope.resolve(Modules.EVENT_BUS)
        await eventBus.emit({
          name: FINALIZATION_PACKED_PENDING_CHARGE_EVENT,
          data: {
            id: order.id,
            order_id: order.id,
            finalization_id: approved.finalization.id,
          },
        })
      } catch (emitError) {
        const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
        logger.warn(
          `[approve-finalization] could not emit ${FINALIZATION_PACKED_PENDING_CHARGE_EVENT} for order=${order.id}: ${
            emitError instanceof Error ? emitError.message : String(emitError)
          }`
        )
      }
    }

    res.status(200).json({
      order,
      ...approved,
    })
  } catch (error) {
    if (deniedInstitutionalReason) {
      try {
        await recordDeniedInstitutionalRelease({
          db: req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
          orderId: order.id,
          actorId: staffAuditActorId(staffAuditFields(req)),
          requestedReason: (req.body as Record<string, unknown> | null)?.institutional_override_reason,
          authorityReason: deniedInstitutionalReason,
        })
      } catch (auditError) {
        await emitFinalizationRouteFailureAlert({
          req,
          action: "institutional_denied_release_audit_failed",
          error: auditError,
          order,
          path: "src/api/admin/grillers/orders/[id]/finalization/approve/route.ts",
          status: 503,
        })
        return jsonError(res, 503, "Institutional release was denied; its audit needs review.")
      }
    }
    await emitFinalizationRouteFailureAlert({
      req,
      action: "approve_finalization",
      error,
      order,
      orderId: req.params.id,
      path: "src/api/admin/grillers/orders/[id]/finalization/approve/route.ts",
      status: 409,
    })
    return jsonError(
      res,
      409,
      error instanceof Error
        ? error.message
        : "Finalization could not be approved."
    )
  }
}
