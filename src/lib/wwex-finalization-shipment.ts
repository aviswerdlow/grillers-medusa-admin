import {
  readAcceptedShippingPrice,
  priceCents,
} from "./shipping-price-contract"
import { SHIPPING_PACKING_PLAN_KEY } from "./shipping-packing-plan"
import {
  createWwexSpeedshipClientFromEnv,
  isUpsServiceCode,
  normalizeGrillersUpsServiceCode,
  type WwexBookingResult,
  type WwexOffer,
  type WwexQuoteResult,
} from "../modules/fulfillment/wwex-speedship"
import { metadataObject } from "./catch-weight-finalization"
import { emitOpsAlert } from "./ops-alert"

type LoggerLike = {
  warn?: (message: string) => void
  info?: (message: string) => void
  error?: (message: string) => void
}

type FinalizationPreview = {
  finalization: Record<string, any>
  lines: Array<Record<string, any>>
  packages?: Array<Record<string, any>>
  totals: Record<string, any>
  package_capture_required?: boolean
}

export type WwexFinalizationQuote = {
  status: "quoted" | "blocked"
  reason?: string
  quote: WwexQuoteResult
  offer: WwexOffer
  totals: Record<string, any>
  metadata: Record<string, any>
}

export type WwexFinalizationBooking =
  | {
      status: "booked"
      booking: WwexBookingResult
      label_status?: "available" | "not_requested" | "failed"
      metadata: Record<string, any>
    }
  | {
      status: "skipped" | "failed"
      reason: string
      metadata: Record<string, any>
    }

const numberOrZero = (value: unknown): number => {
  if (value === undefined || value === null || value === "") return 0
  const parsed =
    typeof value === "object" && value !== null && "value" in value
      ? Number((value as Record<string, unknown>).value)
      : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100

const envFlag = (name: string, fallback = false): boolean => {
  const raw = process.env[name]
  if (!raw) return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "")
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 500)
}

function emitWwexFinalizationFailureAlert(input: {
  alertKind:
    | "wwex_finalization_quote_failed"
    | "wwex_finalization_booking_failed"
    | "wwex_finalization_label_failed"
  title: string
  order: Record<string, any>
  logger?: LoggerLike
  error: unknown
  serviceCode?: string | null
  packageCount?: number | null
  offer?: WwexOffer | null
  booking?: WwexBookingResult | null
}) {
  const logger =
    input.logger?.warn && input.logger?.error
      ? { warn: input.logger.warn, error: input.logger.error }
      : undefined

  void emitOpsAlert({
    alertKind: input.alertKind,
    severity: "warn",
    title: input.title,
    path: "src/lib/wwex-finalization-shipment.ts",
    source: "medusa-server",
    logger,
    meta: {
      order_id: input.order.id || null,
      display_id: input.order.display_id || null,
      service_code: input.serviceCode || null,
      package_count: input.packageCount ?? null,
      offer_id: input.offer?.offerId || null,
      product_transaction_id:
        input.booking?.productTransactionId ||
        input.offer?.productTransactionId ||
        null,
      tracking_number: input.booking?.trackingNumber || null,
      error: redactedErrorMessage(input.error),
    },
  }).catch(() => {
    // Alerting must never change finalization behavior.
  })
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value)
    }
  }
  return ""
}

function shippingServiceCode(order: Record<string, any>): string {
  const metadata = metadataObject(order.metadata)
  const methods = Array.isArray(order.shipping_methods)
    ? order.shipping_methods
    : []
  const method = methods[methods.length - 1] || {}
  const data = metadataObject(method.data)
  const optionData = metadataObject(method.shipping_option?.data)
  const normalized = normalizeGrillersUpsServiceCode(
    firstText(
      data.service_code,
      optionData.service_code,
      method.service_code,
      method.name,
      method.shipping_option?.name,
      metadata.service_code,
      metadata.shipping_service_code,
      metadata.fulfillmentType,
      metadata.fulfillment_type
    )
  )

  if (isUpsServiceCode(normalized)) return normalized

  const blob = JSON.stringify([metadata, methods]).toLowerCase()
  if (blob.includes("3 day")) return "3_DAY_SELECT"
  if (blob.includes("2nd day") || blob.includes("second day")) {
    return "2ND_DAY_AIR"
  }
  if (blob.includes("overnight") || blob.includes("next day"))
    return "OVERNIGHT"
  if (blob.includes("ups") || blob.includes("shipping")) return "GROUND"
  return normalized
}

function shipmentDate(order: Record<string, any>): string | null {
  const metadata = metadataObject(order.metadata)
  return (
    firstText(
      metadata.fulfillmentDispatchDate,
      metadata.shipmentDate,
      metadata.shipment_date,
      metadata.requestedShipDate,
      metadata.requested_ship_date
    ) || null
  )
}

function packageInputs(preview: FinalizationPreview) {
  return (preview.packages || [])
    .filter((pkg) => pkg && typeof pkg === "object")
    .map((pkg) => ({
      id: pkg.id,
      package_type: pkg.package_type,
      packed_weight_lb: pkg.packed_weight_lb,
      dry_ice_lb: pkg.dry_ice_lb,
      length_in: pkg.length_in,
      width_in: pkg.width_in,
      height_in: pkg.height_in,
      note: pkg.note,
    }))
}

function quoteMetadata(offer: WwexOffer) {
  return {
    wwex_quote_status: "quoted",
    wwex_quote_quoted_at: new Date().toISOString(),
    wwex_offer_id: offer.offerId,
    wwex_product_transaction_id: offer.productTransactionId,
    wwex_ups_service_code: offer.upsServiceCode,
    wwex_final_rate: offer.price.value,
    wwex_final_rate_currency: offer.price.currency,
    wwex_transit_days: offer.transitDays ?? null,
    wwex_estimated_delivery_date: offer.estimatedDeliveryDate || null,
    wwex_delivery_by: offer.deliveryBy || null,
  }
}

export async function quoteWwexFinalizationShipping(input: {
  order: Record<string, any>
  preview: FinalizationPreview
  logger?: LoggerLike
}): Promise<WwexFinalizationQuote | null> {
  if (!input.preview.package_capture_required) return null

  const serviceCode = shippingServiceCode(input.order)
  const packages = packageInputs(input.preview)
  try {
    const accepted = readAcceptedShippingPrice(input.order)
    const plan = metadataObject(input.order.metadata)[SHIPPING_PACKING_PLAN_KEY]
    if (
      !plan ||
      plan.id !== accepted.quote.packingPlanId ||
      serviceCode !== plan.service
    )
      throw new Error("Accepted shipping price and packing plan need review.")
    const client = createWwexSpeedshipClientFromEnv(process.env, input.logger)
    if (!client || !isUpsServiceCode(serviceCode) || !packages.length)
      throw new Error(
        "Final shipping quote is unavailable. Keep the order on hold."
      )
    if (
      priceCents(input.preview.totals.final_shipping_total) !==
        priceCents(accepted.customerShipping - accepted.shippingTax) ||
      priceCents(input.preview.totals.final_discount_total) !==
        priceCents(accepted.nonShippingCredit)
    )
      throw new Error(
        "Final shipping totals differ from the accepted price contract."
      )
    const quote = await client.quoteSmallpack({
      serviceCode,
      shippingAddress: input.order.shipping_address || {},
      packages,
      items: input.preview.lines || [],
      shipmentDate: shipmentDate(input.order),
      orderDisplayId: input.order.display_id,
      orderId: input.order.id,
      residentialDelivery: true,
    })
    if (
      quote.offer.price.currency.toLowerCase() !==
      accepted.quote.policy.currency
    )
      throw new Error("Final carrier currency mismatch.")
    const freight = priceCents(quote.offer.price.value) / 100
    return {
      status: "quoted",
      quote,
      offer: quote.offer,
      // Cost changes never replace the customer contract. A changed service,
      // address or basket needs the separate approved amendment workflow.
      totals: input.preview.totals,
      metadata: {
        ...quoteMetadata(quote.offer),
        shipping_final_cost_v1: {
          price_policy_revision: accepted.quote.policy.revision,
          packing_plan_id: plan.id,
          carrier_freight: freight,
          customer_shipping: accepted.customerShipping,
          shipping_discount: accepted.shippingDiscount,
          estimated_box_cost: accepted.quote.boxCost,
          estimated_dry_ice_cost: accepted.quote.dryIceCost,
          actual_packages: packages,
          // Actual box procurement costs/carrier bills belong to #369. Missing
          // observations are unknown, never reconstructed as zero.
          actual_box_cost: null,
          actual_dry_ice_cost: null,
          carrier_bill: null,
        },
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.logger?.warn?.(
      `[wwex] final packed-box quote failed for order ${input.order.id}; finalization blocked: ${redactedErrorMessage(error)}`
    )
    emitWwexFinalizationFailureAlert({
      alertKind: "wwex_finalization_quote_failed",
      title: `WWEX finalization quote failed for order ${input.order.id}`,
      order: input.order,
      logger: input.logger,
      error,
      serviceCode,
      packageCount: packages.length,
    })
    return {
      status: "blocked",
      reason: "shipping_price_review_required",
      quote: null as any,
      offer: null as any,
      totals: {},
      metadata: {
        wwex_quote_status: "failed",
        wwex_quote_failed_at: new Date().toISOString(),
        wwex_quote_error: redactedErrorMessage(error),
      },
    }
  }
}

export async function bookWwexFinalizationShipment(input: {
  order: Record<string, any>
  quote: WwexFinalizationQuote | null
  logger?: LoggerLike
}): Promise<WwexFinalizationBooking> {
  if (!input.quote?.quote?.offer) {
    return {
      status: "skipped",
      reason: "no_wwex_quote",
      metadata: {
        wwex_booking_status: "skipped",
        wwex_booking_reason: "no_wwex_quote",
      },
    }
  }

  if (!envFlag("WWEX_BOOK_SHIPMENTS_ON_RELEASE", false)) {
    return {
      status: "skipped",
      reason: "booking_disabled",
      metadata: {
        wwex_booking_status: "skipped",
        wwex_booking_reason: "booking_disabled",
      },
    }
  }

  const client = createWwexSpeedshipClientFromEnv(process.env, input.logger)
  if (!client) {
    return {
      status: "skipped",
      reason: "client_not_configured",
      metadata: {
        wwex_booking_status: "skipped",
        wwex_booking_reason: "client_not_configured",
      },
    }
  }

  try {
    const metadata = metadataObject(input.order.metadata)
    const booking = await client.bookSmallpack({
      quote: input.quote.quote,
      notificationEmails: firstText(
        metadata.wwex_notification_email,
        process.env.WWEX_NOTIFICATION_EMAIL
      )
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean),
    })

    let labelStatus: "available" | "not_requested" | "failed" = "not_requested"
    if (envFlag("WWEX_FETCH_LABEL_ON_RELEASE", true)) {
      try {
        await client.downloadSmallpackLabel(booking.productTransactionId)
        labelStatus = "available"
      } catch (error) {
        labelStatus = "failed"
        input.logger?.warn?.(
          `[wwex] label download failed for order ${input.order.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        emitWwexFinalizationFailureAlert({
          alertKind: "wwex_finalization_label_failed",
          title: `WWEX label download failed for order ${input.order.id}`,
          order: input.order,
          logger: input.logger,
          error,
          offer: input.quote.offer,
          booking,
        })
      }
    }

    return {
      status: "booked",
      booking,
      label_status: labelStatus,
      metadata: {
        wwex_booking_status: "booked",
        wwex_booked_at: new Date().toISOString(),
        wwex_tracking_number: booking.trackingNumber || null,
        wwex_label_status: labelStatus,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.logger?.warn?.(
      `[wwex] shipment booking failed for order ${input.order.id}: ${message}`
    )
    emitWwexFinalizationFailureAlert({
      alertKind: "wwex_finalization_booking_failed",
      title: `WWEX shipment booking failed for order ${input.order.id}`,
      order: input.order,
      logger: input.logger,
      error,
      offer: input.quote.offer,
    })
    return {
      status: "failed",
      reason: message,
      metadata: {
        wwex_booking_status: "failed",
        wwex_booking_failed_at: new Date().toISOString(),
        wwex_booking_error: message,
      },
    }
  }
}
