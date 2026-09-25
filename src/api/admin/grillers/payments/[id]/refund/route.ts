import { verifiedStaffActorId } from "../../../../../../lib/staff-principal"
import { assertQbdPostingReady, persistQbdPosting, QbdPostingConflict } from "../../../../../../lib/qbd-posting-outbox"
import { loadQbdOrder } from "../../../../../../lib/qbd-order-metadata"
import { claimStaffRefundRequest, completeStaffRefundRequest, recordStaffRefundProvider, refundRequestKey, requireStaffRefundReconciliation } from "../../../../../../lib/staff-refund-request"
import { amountInMinorUnits } from "../../../../../../lib/catch-weight-finalization"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { releaseAllocationLineQuantities } from "../../../../../../lib/inventory-allocation"
import { emitOpsAlert } from "../../../../../../lib/ops-alert"

type RefundBody = {
  amount?: number | string
  note?: string
  refund_reason_id?: string
  allocation_releases?: Array<{
    order_id?: string
    line_item_id?: string
    quantity?: number | string
  }>
}

class RefundValidationError extends Error {}

const numericAmount = (
  value: unknown,
  label = "Refund amount"
): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RefundValidationError(`${label} must be greater than zero.`)
  }
  return amount
}

const refundAmount = (refund: Record<string, any>, fallback?: number): number => {
  const raw = refund.raw_amount
  const value =
    typeof raw === "object" && raw !== null && "value" in raw
      ? raw.value
      : raw ?? refund.amount ?? fallback ?? 0
  return Number(value)
}

const appendAuditLog = (
  metadata: Record<string, any>,
  entry: Record<string, any>
): Record<string, any> => {
  const raw = metadata.staff_audit_log
  let audit: Array<Record<string, any>> = []

  if (Array.isArray(raw)) {
    audit = raw
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      audit = Array.isArray(parsed) ? parsed : []
    } catch {
      audit = []
    }
  }

  return {
    ...metadata,
    staff_audit_log: JSON.stringify(
      [
        ...audit,
        {
          at: new Date().toISOString(),
          ...entry,
        },
      ].slice(-50)
    ),
  }
}

const redactedErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error || "Unknown error"))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:pi|pm|py|pay|refund|re)_[A-Za-z0-9_]+/g, "[redacted-id]")
    .slice(0, 500)

async function emitStaffRefundRouteFailureAlert({
  logger,
  paymentId,
  orderId,
  refundId,
  stage,
  refundCompleted,
  allocationReleaseCount,
  actorId,
  error,
}: {
  logger?: any
  paymentId?: string | null
  orderId?: string | null
  refundId?: string | null
  stage: string
  refundCompleted: boolean
  allocationReleaseCount: number
  actorId?: string | null
  error: unknown
}) {
  return emitOpsAlert({
    alertKind: "staff_refund_route_failed",
    title: `Staff refund failed during ${stage}`,
    path: "src/api/admin/grillers/payments/[id]/refund/route.ts",
    source: "medusa-server",
    severity: "page",
    logger,
    meta: {
      stage,
      payment_id: paymentId || null,
      order_id: orderId || null,
      refund_id: refundId || null,
      refund_completed: refundCompleted,
      allocation_release_count: allocationReleaseCount,
      actor_id: actorId || null,
      error_message: redactedErrorMessage(error),
    },
  })
}

async function orderIdForPaymentCollection(
  query: { graph: (input: Record<string, unknown>) => Promise<{ data?: any[] }> },
  paymentCollectionId: string | undefined
): Promise<string | null> {
  if (!paymentCollectionId) return null

  const { data } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })

  return data?.[0]?.order_id || null
}

async function queueQbdRefundPosting({ db, order, refund, refundAmountValue, note, actorId }: {
  db: any
  order: Record<string, any>
  refund: Record<string, any>
  refundAmountValue: number
  note?: string
  actorId?: string
}) {
  const amountMinor = amountInMinorUnits(Math.abs(refundAmountValue), order.currency_code)
  const requestKey = `refund:${refund.id}`
  await persistQbdPosting({ db, order, buildMetadata: (current) => appendAuditLog({
    ...current, qbd_posting_required: true, qbd_posting_status: "pending_manual",
    qbd_posting_action: "card_refund_accounting_record", qbd_posting_amount: amountMinor,
    qbd_posting_request_key: requestKey, qbd_posting_requested_at: new Date().toISOString(),
    stripe_refund_id: refund.id, stripe_provider_refund_id: refund.provider_refund_id || refund.data?.id || refund.id,
    stripe_refund_status: "submitted",
  }, { action: "stripe_refund", status: "queued_for_quickbooks", qbd_posting_action: "card_refund_accounting_record",
    qbd_posting_request_key: requestKey, qbd_posting_amount: amountMinor, refund_id: refund.id,
    staff_actor_id: actorId, note: note || null,
  }) })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const paymentId = req.params.id
  const body = (req.body ?? {}) as RefundBody
  const actorId = verifiedStaffActorId(req) || undefined
  let stage = "parse_request"
  let orderId: string | null = null
  let refundId: string | null = null
  let refundCompleted = false
  let refundRequestId: string | undefined
  let db: any
  let allocationReleaseCount = Array.isArray(body.allocation_releases)
    ? body.allocation_releases.filter((line) => line.line_item_id).length
    : 0
  let logger: any
  try {
    logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  } catch {
    logger = undefined
  }

  try {
    const amount = numericAmount(body.amount)
    const allocationLines = (body.allocation_releases || [])
      .filter((line) => line.line_item_id)
      .map((line) => ({
        line_item_id: line.line_item_id!,
        quantity: numericAmount(line.quantity, "Allocation release quantity") || 0,
      }))
      .filter((line) => line.quantity > 0)
    allocationReleaseCount = allocationLines.length
    const allocationOrderId =
      (body.allocation_releases || []).find((line) => line.order_id)?.order_id ||
      null

    const paymentModule = req.scope.resolve(Modules.PAYMENT)
    const orderModule = req.scope.resolve(Modules.ORDER)
    const eventBus = req.scope.resolve(Modules.EVENT_BUS)
    const query = req.scope.resolve("query")
    db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const requestKey = refundRequestKey(req)

    stage = "retrieve_payment"
    const before = await paymentModule.retrievePayment(paymentId, {
      select: ["id", "payment_collection_id", "currency_code"],
      relations: ["refunds"],
    })
    const existingRefundIds = new Set(
      (before.refunds || []).map((refund: Record<string, any>) => refund.id)
    )

    stage = "accounting_preflight"
    orderId = await orderIdForPaymentCollection(query, before.payment_collection_id)
    if (!orderId) throw new QbdPostingConflict("Payment is not linked to an order; resolve it before refunding.")
    if (allocationOrderId && allocationOrderId !== orderId) throw new RefundValidationError("Allocation release must belong to the refunded order.")
    const accountingOrder = await loadQbdOrder(query, orderId)
    await assertQbdPostingReady(db, orderId)
    const intent = await claimStaffRefundRequest(db, { orderId, paymentId, requestKey,
      amount, currencyCode: before.currency_code, note: body.note, reasonId: body.refund_reason_id, allocationLines })
    if (intent.replay) return res.status(200).json({ ...intent.replay, already_refunded: true })
    refundRequestId = intent.id

    stage = "refund_payment"
    const payment = await paymentModule.refundPayment({
      payment_id: paymentId,
      amount,
      note: body.note,
      refund_reason_id: body.refund_reason_id,
      created_by: actorId,
    })
    refundCompleted = true

    const refunds = (payment.refunds || []) as Array<Record<string, any>>
    const refund =
      refunds.find((candidate) => !existingRefundIds.has(candidate.id)) ||
      refunds[refunds.length - 1]
    refundId = refund?.id || null

    if (!refund?.id) throw new Error("The payment provider did not return a durable refund identity.")
    await recordStaffRefundProvider(db, intent.id, refund.id)

    if (orderId && refund?.id) {
      const resolvedRefundAmount = refundAmount(refund, amount)
      stage = "list_refund_transactions"
      const existingTransactions = await orderModule.listOrderTransactions(
        {
          order_id: orderId,
          reference: "refund",
          reference_id: refund.id,
        },
        { select: ["id"] }
      )

      if (!existingTransactions.length) {
        stage = "record_order_transaction"
        await orderModule.addOrderTransactions({
          order_id: orderId,
          amount: -Math.abs(resolvedRefundAmount),
          currency_code: payment.currency_code || before.currency_code,
          reference: "refund",
          reference_id: refund.id,
        })
      }

      stage = "queue_qbd_refund_posting"
      await queueQbdRefundPosting({
        db,
        order: accountingOrder,
        refund,
        refundAmountValue: resolvedRefundAmount,
        note: body.note,
        actorId,
      })
    }

    if (refund?.id) {
      stage = "emit_refund_event"
      await eventBus.emit({
        name: "payment.refunded",
        data: {
          id: payment.id,
          payment_id: payment.id,
          refund_id: refund.id,
          order_id: orderId,
          amount: refundAmount(refund, amount),
          reason: body.note,
        },
      })
    }

    const effectiveAllocationOrderId = allocationOrderId || orderId
    if (effectiveAllocationOrderId && allocationLines.length) {
      stage = "release_inventory_allocation"
      await releaseAllocationLineQuantities({
        db,
        orderId: effectiveAllocationOrderId,
        lines: allocationLines,
        reason: "released_refund",
        actorType: "staff",
        actorId,
        note: body.note || null,
      })
    }

    // Store only the fields needed to replay the refund result, never provider card data.
    const response = { payment: { id: payment.id, currency_code: payment.currency_code || before.currency_code,
      refunds: [{ id: refund.id, amount: refundAmount(refund, amount), provider_refund_id: refund.provider_refund_id || refund.data?.id }],
    } }
    await completeStaffRefundRequest(db, intent.id, response)
    res.status(200).json(response)
  } catch (error) {
    if (refundRequestId) await requireStaffRefundReconciliation(db, refundRequestId).catch(() => undefined)
    if (error instanceof QbdPostingConflict && !refundCompleted) {
      return res.status(409).json({ message: error.message })
    }
    if (error instanceof RefundValidationError) {
      return res.status(400).json({ message: error.message })
    }

    await emitStaffRefundRouteFailureAlert({
      logger,
      paymentId,
      orderId,
      refundId,
      stage,
      refundCompleted,
      allocationReleaseCount,
      actorId,
      error,
    })

    res.status(500).json({
      message: refundCompleted
        ? "Refund was issued, but follow-up recording failed. Do not retry until support checks the order."
        : refundRequestId
          ? "The refund outcome needs reconciliation. Do not submit another refund until support checks the provider and order records."
          : "Could not refund payment before the provider was called.",
    })
  }
}
