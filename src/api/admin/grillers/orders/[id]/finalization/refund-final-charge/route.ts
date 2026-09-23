import { verifiedStaffActorId } from "../../../../../../../lib/staff-principal"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"
import {
  amountInMinorUnits,
  metadataObject,
} from "../../../../../../../lib/catch-weight-finalization"
import { releaseAllocationLineQuantities } from "../../../../../../../lib/inventory-allocation"
import { emitOpsAlert } from "../../../../../../../lib/ops-alert"

type RefundBody = {
  amount?: number | string
  note?: string
  allocation_releases?: Array<{
    order_id?: string
    line_item_id?: string
    quantity?: number | string
  }>
}

type AllocationRelease = {
  line_item_id: string
  quantity: number
}

type FinalChargeRefundEntry = {
  id: string
  amount: number
  amount_minor: number
  idempotency_key: string
  qbd_posting_request_key: string
  created_at: string
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 422
  ) {
    super(message)
  }
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
])

function currencyPrecision(currencyCode = "usd") {
  return ZERO_DECIMAL_CURRENCIES.has(currencyCode.toLowerCase()) ? 0 : 2
}

function normalizeCurrencyAmount(
  value: unknown,
  currencyCode: string,
  label: string
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RequestError(`${label} must be greater than zero.`)
  }
  const precision = currencyPrecision(currencyCode)
  const factor = 10 ** precision
  const rounded = Math.round(amount * factor) / factor
  if (Math.abs(amount - rounded) > 1e-9) {
    throw new RequestError(
      `${label} cannot include more than ${precision} decimal places for ${currencyCode.toUpperCase()}.`
    )
  }
  return rounded
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

async function createStripeRefund({
  paymentIntentId,
  amount,
  currencyCode,
  orderId,
  note,
  idempotencyKey,
}: {
  paymentIntentId: string
  amount: number
  currencyCode: string
  orderId: string
  note?: string
  idempotencyKey?: string
}) {
  const apiKey = process.env.STRIPE_API_KEY
  if (!apiKey) {
    throw new Error("Stripe secret key is not configured.")
  }

  const body = new URLSearchParams({
    payment_intent: paymentIntentId,
    amount: String(amountInMinorUnits(amount, currencyCode)),
    "metadata[payment_workflow]": "setup_then_final_charge",
    "metadata[order_id]": orderId,
  })
  if (note) {
    body.set("metadata[note]", note)
  }

  const response = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(json?.error?.message || "Stripe final-charge refund failed.")
  }
  if (!json?.id) {
    throw new Error("Stripe final-charge refund response did not include a refund id.")
  }
  if (["failed", "canceled"].includes(String(json.status || ""))) {
    throw new Error(
      `Stripe final-charge refund ${json.id} returned status ${json.status}.`
    )
  }

  return json as Record<string, any>
}

function finalChargeRefundEntries(
  metadata: Record<string, any>
): FinalChargeRefundEntry[] {
  const raw = metadata.final_charge_refunds
  return Array.isArray(raw)
    ? raw.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          typeof entry.idempotency_key === "string"
      )
    : []
}

function paymentResponse({
  paymentIntentId,
  capturedAmount,
  refundedAmount,
  currencyCode,
  refund,
  refundAmount,
  alreadyRefunded = false,
}: {
  paymentIntentId: string
  capturedAmount: number
  refundedAmount: number
  currencyCode: string
  refund?: Record<string, any> | FinalChargeRefundEntry | null
  refundAmount?: number
  alreadyRefunded?: boolean
}) {
  const amount = refund
    ? Number(
        refundAmount ??
          (refund as any).raw_amount?.value ??
          (refund as FinalChargeRefundEntry).amount ??
          0
      )
    : 0

  return {
    ...(alreadyRefunded ? { already_refunded: true } : {}),
    payment: {
      id: `final_charge:${paymentIntentId}`,
      provider_id: "pp_stripe_final_charge",
      amount: capturedAmount,
      refunded_amount: refundedAmount,
      currency_code: currencyCode,
      status:
        refundedAmount >= capturedAmount ? "refunded" : "partially_refunded",
      refunds: refund
        ? [
            {
              id: refund.id,
              amount,
              raw_amount: { value: String(amount) },
              data: refund,
              provider_refund_id: refund.id,
            },
          ]
        : [],
    },
  }
}

function normalizeAllocationReleases(
  releases: RefundBody["allocation_releases"],
  currencyCode: string
): { orderId?: string; lines: AllocationRelease[] } {
  const lines = (releases || [])
    .filter((line) => line.line_item_id)
    .map((line) => ({
      line_item_id: line.line_item_id!,
      quantity:
        normalizeCurrencyAmount(
          line.quantity,
          currencyCode,
          "Allocation release quantity"
        ) || 0,
    }))
    .filter((line) => line.quantity > 0)
  const orderId = (releases || []).find((line) => line.order_id)?.order_id

  return { orderId, lines }
}

function pendingQbdPosting(metadata: Record<string, any>) {
  return String(metadata.qbd_posting_status || "").startsWith("pending")
}

const redactedErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error || "Unknown error"))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:pi|pm|py|pay|refund|re)_[A-Za-z0-9_]+/g, "[redacted-id]")
    .slice(0, 500)

function requestHeader(req: MedusaRequest, name: string): string | undefined {
  const headers = (req as any).headers || {}
  return (
    headers[name] ||
    headers[name.toLowerCase()] ||
    (typeof (req as any).get === "function" ? (req as any).get(name) : undefined)
  )
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = req.params.id
  const body = (req.body ?? {}) as RefundBody
  const orderModule = req.scope.resolve(Modules.ORDER)
  const eventBus = req.scope.resolve(Modules.EVENT_BUS)
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const actorId = verifiedStaffActorId(req) || undefined
  let stage = "retrieve_order"
  let paymentIntentId: string | null = null
  let logger: any
  try {
    logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  } catch {
    logger = undefined
  }
  let stripeRefund: Record<string, any> | undefined

  try {
    const order = await orderModule.retrieveOrder(orderId, {
      select: ["id", "currency_code", "total", "metadata"],
    })
    const metadata = metadataObject(order.metadata)
    paymentIntentId = String(metadata.stripe_payment_intent_id || "")
    if (!paymentIntentId || metadata.final_charge_status !== "succeeded") {
      return res.status(409).json({
        message: "Order does not have a succeeded Stripe final charge to refund.",
      })
    }

    const currencyCode = String(order.currency_code || "usd")
    const capturedAmount = Number(
      metadata.final_total ||
        metadata.final_order_total ||
        metadata.final_charge_amount ||
        order.total ||
        0
    )
    const alreadyRefunded = Number(metadata.final_charge_refunded_amount || 0)
    const refundableAmount = Math.max(0, capturedAmount - alreadyRefunded)
    const refundAmount =
      normalizeCurrencyAmount(body.amount, currencyCode, "Refund amount") ??
      refundableAmount
    const providedIdempotencyKey = requestHeader(req, "Idempotency-Key")
    const idempotencyKey =
      providedIdempotencyKey ||
      `final-charge-refund:${order.id}:${paymentIntentId}:${refundAmount}:${randomUUID()}`
    const existingRefundEntry = finalChargeRefundEntries(metadata).find(
      (entry) => entry.idempotency_key === idempotencyKey
    )

    if (existingRefundEntry) {
      return res.status(200).json(
        paymentResponse({
          paymentIntentId,
          capturedAmount,
          refundedAmount: alreadyRefunded,
          currencyCode,
          refund: existingRefundEntry,
          refundAmount: existingRefundEntry.amount,
          alreadyRefunded: true,
        })
      )
    }

    if (refundAmount <= 0 || refundAmount > refundableAmount + 0.005) {
      return res.status(422).json({
        message: `Refund amount exceeds the refundable final-charge balance of ${refundableAmount.toFixed(2)}.`,
      })
    }

    stage = "validate_allocation_releases"
    const allocation = normalizeAllocationReleases(
      body.allocation_releases,
      currencyCode
    )

    if (pendingQbdPosting(metadata)) {
      return res.status(409).json({
        message:
          "Order already has a pending QuickBooks posting. Post or clear it before refunding the final charge.",
        qbd_posting_status: metadata.qbd_posting_status,
        qbd_posting_action: metadata.qbd_posting_action,
        qbd_posting_request_key: metadata.qbd_posting_request_key,
      })
    }

    stage = "refund_stripe"
    const refund = await createStripeRefund({
      paymentIntentId,
      amount: refundAmount,
      currencyCode,
      orderId: order.id,
      note: body.note,
      idempotencyKey,
    })
    stripeRefund = refund
    const requestKey = `refund:${refund.id}`
    const amountMinor = amountInMinorUnits(refundAmount, currencyCode)
    const existingEntries = finalChargeRefundEntries(metadata)
    const refundRecordedInMetadata =
      existingEntries.some((entry) => entry.id === refund.id) ||
      metadata.stripe_refund_id === refund.id

    stage = "list_refund_transactions"
    const existingTransactions = await orderModule.listOrderTransactions(
      {
        order_id: order.id,
        reference: "refund",
        reference_id: refund.id,
      },
      { select: ["id"] }
    )
    const refundAlreadyRecorded =
      existingTransactions.length > 0 || refundRecordedInMetadata

    if (!refundAlreadyRecorded) {
      stage = "record_order_transaction"
      await orderModule.addOrderTransactions({
        order_id: order.id,
        amount: -Math.abs(refundAmount),
        currency_code: currencyCode,
        reference: "refund",
        reference_id: refund.id,
      })
    }
    const nextRefundedAmount = refundAlreadyRecorded
      ? alreadyRefunded
      : Number((alreadyRefunded + refundAmount).toFixed(2))
    const refundEntry: FinalChargeRefundEntry = {
      id: refund.id,
      amount: refundAmount,
      amount_minor: amountMinor,
      idempotency_key: idempotencyKey,
      qbd_posting_request_key: requestKey,
      created_at: new Date().toISOString(),
    }

    const nextMetadata = appendAuditLog(
      {
        ...metadata,
        final_charge_refunded_amount: nextRefundedAmount,
        final_charge_refunds: refundRecordedInMetadata
          ? existingEntries
          : [...existingEntries, refundEntry].slice(-50),
        qbd_posting_required: true,
        qbd_posting_status: "pending_manual",
        qbd_posting_action: "card_refund_accounting_record",
        qbd_posting_amount: amountMinor,
        qbd_posting_request_key: requestKey,
        qbd_posting_requested_at: new Date().toISOString(),
        stripe_refund_id: refund.id,
        stripe_provider_refund_id: refund.id,
      },
      {
        action: "stripe_final_charge_refund",
        status: "queued_for_quickbooks",
        qbd_posting_action: "card_refund_accounting_record",
        qbd_posting_request_key: requestKey,
        qbd_posting_amount: amountMinor,
        refund_id: refund.id,
        stripe_payment_intent_id: paymentIntentId,
        staff_actor_id: actorId,
        note: body.note || null,
      }
    )
    stage = "update_order_metadata"
    await orderModule.updateOrders(order.id, { metadata: nextMetadata })

    stage = "emit_refund_event"
    await eventBus.emit({
      name: "payment.refunded",
      data: {
        id: `final_charge:${paymentIntentId}`,
        payment_id: `final_charge:${paymentIntentId}`,
        refund_id: refund.id,
        order_id: order.id,
        amount: refundAmount,
        reason: body.note,
      },
    })

    const allocationOrderId = allocation.orderId || order.id
    if (allocationOrderId && allocation.lines.length) {
      stage = "release_inventory_allocation"
      await releaseAllocationLineQuantities({
        db,
        inventory: req.scope.resolve(Modules.INVENTORY),
        locking: req.scope.resolve(Modules.LOCKING),
        orderId: allocationOrderId,
        lines: allocation.lines,
        reason: "released_refund",
        releaseKey: requestKey,
        actorType: "staff",
        actorId,
        note: body.note || null,
      })
    }

    res.status(200).json(
      paymentResponse({
        paymentIntentId,
        capturedAmount,
        refundedAmount: nextRefundedAmount,
        currencyCode,
        refund,
        refundAmount,
      })
    )
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Stripe final-charge refund failed."
    if (stripeRefund?.id) {
      // Money left Stripe but the Medusa transaction/metadata write threw: the
      // refund DID happen at the processor while our ledger does not reflect it.
      // This is a money/ledger divergence — page immediately. Never log card/PII;
      // only ids and a sliced error message.
      await emitOpsAlert({
        alertKind: "refund_recorded_mismatch",
        title: `Stripe refund ${stripeRefund.id} succeeded but Medusa recording failed for order ${orderId}`,
        path: "src/api/admin/grillers/orders/[id]/finalization/refund-final-charge/route.ts",
        source: "medusa",
        severity: "page",
        logger,
        meta: {
          stripe_refund_id: stripeRefund.id,
          order_id: orderId,
          error_name: err instanceof Error ? err.name : "Error",
          error_message_sliced: String(message).slice(0, 300),
        },
      })
      return res.status(500).json({
        message: `Stripe refund ${stripeRefund.id} succeeded, but Medusa refund recording failed: ${message}`,
        stripe_refund_id: stripeRefund.id,
      })
    }

    if (!(err instanceof RequestError)) {
      await emitOpsAlert({
        alertKind: "final_charge_refund_route_failed",
        title: `Final-charge refund failed during ${stage}`,
        path: "src/api/admin/grillers/orders/[id]/finalization/refund-final-charge/route.ts",
        source: "medusa",
        severity: "page",
        logger,
        meta: {
          order_id: orderId,
          stage,
          stripe_payment_intent_id: paymentIntentId,
          actor_id: actorId || null,
          refund_completed: false,
          error_name: err instanceof Error ? err.name : "Error",
          error_message: redactedErrorMessage(err),
        },
      })
    }

    res.status(err instanceof RequestError ? err.status : 402).json({ message })
  }
}
