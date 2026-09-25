import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createHmac } from "node:crypto"

import { resolveFoodTaxForAddress } from "../modules/ga-tax/rules"
import { emitOpsAlert } from "../lib/ops-alert"
import { transitDaysForOrder } from "../lib/packaging-cost"
import type { QbdOutboxEnvelope } from "../lib/qbd-outbox-delivery"

import { ORDER_FIELDS } from "../lib/qb-sync-order-fields"
export { ORDER_FIELDS } from "../lib/qb-sync-order-fields"

const IMPORT_TIMEOUT_MS = 15_000
type QbdListIdFallbacks = Record<string, string>
type MissingQbdLineIdentity = {
  line_id: string | null
  variant_id: string | null
  sku: string | null
  title: string | null
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (
    value &&
    typeof value === "object" &&
    "value" in value &&
    (typeof value.value === "number" || typeof value.value === "string")
  ) {
    return numeric(value.value)
  }

  return null
}

function firstNumeric(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numeric(value)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function firstPositiveNumeric(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numeric(value)
    if (parsed !== null && parsed > 0) {
      return parsed
    }
  }

  return null
}

const QBD_LIST_ID_KEYS = [
  "qbd_list_id",
  "qbdListId",
  "QbdListId",
  "quickbooks_list_id",
  "quickbooksListId",
  "QuickBooksListId",
  "qb_list_id",
  "qbListId",
  "QbListId",
  "qbd_item_list_id",
  "qbdItemListId",
  "QbdItemListId",
  "quickbooks_item_list_id",
  "quickbooksItemListId",
  "QuickBooksItemListId",
  "qb_item_list_id",
  "qbItemListId",
  "QbItemListId",
  "qbd_item_id",
  "qbdItemId",
  "QbdItemId",
  "quickbooks_item_id",
  "quickbooksItemId",
  "QuickBooksItemId",
  "qb_item_id",
  "qbItemId",
  "QbItemId",
]

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim()
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }

  return null
}

function metadataListId(metadata: unknown): string | null {
  const record = objectRecord(metadata)
  for (const key of QBD_LIST_ID_KEYS) {
    const value = textValue(record[key])
    if (value) {
      return value
    }
  }

  for (const namespace of ["qbd", "quickbooks", "qb"]) {
    const nested = objectRecord(record[namespace])
    const value =
      textValue(nested.list_id) ||
      textValue(nested.item_list_id) ||
      textValue(nested.item_id)
    if (value) {
      return value
    }
  }

  return null
}

function itemQbdListId(item: Record<string, unknown>): string | null {
  const variant = objectRecord(item.variant)
  const product = objectRecord(item.product)
  const variantProduct = objectRecord(variant.product)

  return (
    metadataListId(item.metadata) ||
    metadataListId(variant.metadata) ||
    metadataListId(product.metadata) ||
    metadataListId(variantProduct.metadata)
  )
}

function lookupKey(prefix: string, value: unknown): string | null {
  const text = textValue(value)
  return text ? `${prefix}:${text.toLowerCase()}` : null
}

function itemFallbackKeys(item: Record<string, unknown>): string[] {
  const variant = objectRecord(item.variant)
  const detail = objectRecord(item.detail)

  return [
    lookupKey("variant", item.variant_id),
    lookupKey("variant", detail.variant_id),
    lookupKey("variant", variant.id),
    lookupKey("sku", item.variant_sku),
    lookupKey("sku", item.sku),
    lookupKey("sku", detail.sku),
    lookupKey("sku", variant.sku),
  ].filter((key): key is string => Boolean(key))
}

function finalLinesByLineItemId(
  order: Record<string, unknown>
): Map<string, Record<string, unknown>> {
  const metadata = objectRecord(order.metadata)
  const lines = Array.isArray(metadata.catch_weight_final_lines)
    ? metadata.catch_weight_final_lines
    : []
  const byId = new Map<string, Record<string, unknown>>()

  for (const rawLine of lines) {
    if (!rawLine || typeof rawLine !== "object") {
      continue
    }
    const line = rawLine as Record<string, unknown>
    const lineItemId = textValue(line.line_item_id)
    if (lineItemId) {
      byId.set(lineItemId, line)
    }
  }

  return byId
}

function quantityForFinalLine(line: Record<string, unknown>): number {
  const pricingMode = textValue(line.pricing_mode)
  const quantity =
    pricingMode === "per_lb"
      ? firstNumeric(line.actual_weight_total)
      : firstNumeric(line.actual_quantity, line.actual_piece_count)

  return quantity && quantity > 0 ? quantity : 1
}

function syntheticItemForFinalLine(
  line: Record<string, unknown>
): Record<string, unknown> | null {
  const metadata = objectRecord(line.metadata)
  const staffAdded =
    line.staff_added_line === true || metadata.staff_added_line === true
  if (!staffAdded) {
    return null
  }

  const qbdListId = textValue(line.qbd_list_id)
  const customerTitle =
    textValue(line.customer_title) || textValue(line.title_snapshot)
  const lineItemId = textValue(line.line_item_id)
  if (!lineItemId || !qbdListId || !customerTitle) {
    return null
  }

  const quantity = quantityForFinalLine(line)
  const subtotal = firstNumeric(line.final_line_subtotal) ?? 0
  const total = firstNumeric(line.final_line_total) ?? subtotal

  return {
    id: lineItemId,
    title: customerTitle,
    product_id: textValue(line.product_id),
    variant_id: textValue(line.variant_id),
    variant_sku: textValue(line.sku),
    sku: textValue(line.sku),
    quantity,
    subtotal,
    total,
    unit_price: firstNumeric(line.actual_unit_price),
    metadata: {
      qbd_list_id: qbdListId,
      catch_weight_staff_added_line: true,
      catch_weight_actual_quantity:
        line.actual_quantity ?? line.actual_piece_count ?? null,
      catch_weight_actual_piece_count: line.actual_piece_count ?? null,
      catch_weight_actual_weight_total: line.actual_weight_total ?? null,
      catch_weight_final_line_subtotal: line.final_line_subtotal ?? null,
      catch_weight_final_line_total: line.final_line_total ?? null,
      catch_weight_customer_title: customerTitle,
      catch_weight_line_note: line.note ?? null,
      catch_weight_replacement_reason:
        line.replacement_reason ?? line.short_reason ?? null,
    },
  }
}

function fallbackQbdListId(
  item: Record<string, unknown>,
  fallbacks: QbdListIdFallbacks
): string | null {
  for (const key of itemFallbackKeys(item)) {
    const value = textValue(fallbacks[key])
    if (value) {
      return value
    }
  }

  return null
}

function normalizedItemQbdListId(item: Record<string, unknown>): string | null {
  return metadataListId(item.metadata)
}

export function missingQbdLineIdentities(
  order: Record<string, unknown>
): MissingQbdLineIdentity[] {
  if (!Array.isArray(order.items)) {
    return []
  }

  return order.items
    .filter((item): item is Record<string, unknown> => {
      return !!item && typeof item === "object" && !normalizedItemQbdListId(item)
    })
    .map((item) => {
      const detail = objectRecord(item.detail)
      const variant = objectRecord(item.variant)

      return {
        line_id: textValue(item.id),
        variant_id:
          textValue(item.variant_id) ||
          textValue(detail.variant_id) ||
          textValue(variant.id),
        sku:
          textValue(item.variant_sku) ||
          textValue(item.sku) ||
          textValue(detail.sku) ||
          textValue(variant.sku),
        title: textValue(item.title),
      }
    })
}

async function emitMissingQbdLineIdentityAlert({
  orderId,
  source,
  missingLines,
  logger,
}: {
  orderId: string
  source: string
  missingLines: MissingQbdLineIdentity[]
  logger: Parameters<typeof emitOpsAlert>[0]["logger"]
}) {
  if (!missingLines.length) {
    return
  }

  await emitOpsAlert({
    alertKind: "qbd_line_identity_missing",
    title: `QBD order import has ${missingLines.length} line(s) without ListID`,
    path: "src/subscribers/qb-sync-order-import.ts",
    source: "medusa",
    severity: "page",
    fingerprint: "qbd:line_identity_missing",
    logger,
    meta: {
      order_id: orderId,
      source_event: source,
      missing_line_count: missingLines.length,
      missing_lines: missingLines.slice(0, 10),
    },
  })
}

/**
 * #276: resolve the staff member who entered an order on a customer's behalf so the
 * QuickBooks SalesOrder memo can read "Submitted online by <staff id> on behalf of
 * <customer code>". Prefers an explicit field, then the most recent staff audit actor.
 * Returns null for ordinary customer self-service orders.
 */
export function resolveEnteredByStaffId(
  metadata: Record<string, unknown>
): string | null {
  const direct =
    textValue(metadata.qbd_entered_by_staff_id) ||
    textValue(metadata.entered_by_staff_id) ||
    textValue(metadata.staff_actor_id)
  if (direct) {
    return direct
  }

  const rawLog = metadata.staff_audit_log
  let entries: unknown[] = []
  if (Array.isArray(rawLog)) {
    entries = rawLog
  } else if (typeof rawLog === "string" && rawLog.trim()) {
    try {
      const parsed = JSON.parse(rawLog)
      entries = Array.isArray(parsed) ? parsed : []
    } catch {
      entries = []
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = objectRecord(entries[i])
    const actor = textValue(entry.staff_actor_id) || textValue(entry.actor_id)
    if (actor) {
      return actor
    }
  }

  return null
}

export function normalizeOrderForQbSync(
  order: Record<string, unknown>,
  qbdListIdFallbacks: QbdListIdFallbacks = {}
): Record<string, unknown> {
  const finalLines = finalLinesByLineItemId(order)
  const seenFinalLineIds = new Set<string>()
  const items = Array.isArray(order.items)
    ? order.items.map((rawItem) => {
        if (!rawItem || typeof rawItem !== "object") {
          return rawItem
        }

        const item = rawItem as Record<string, unknown>
        const detail =
          item.detail && typeof item.detail === "object"
            ? (item.detail as Record<string, unknown>)
            : {}
        const metadata = objectRecord(item.metadata)
        const finalLine = textValue(item.id)
          ? finalLines.get(textValue(item.id)!)
          : undefined
        if (finalLine && textValue(item.id)) {
          seenFinalLineIds.add(textValue(item.id)!)
        }
        const qbdListId =
          textValue(finalLine?.qbd_list_id) ||
          itemQbdListId(item) ||
          fallbackQbdListId(item, qbdListIdFallbacks)
        const pricingMode = textValue(finalLine?.pricing_mode)
        const quantity =
          pricingMode === "per_lb"
            ? firstNumeric(finalLine?.actual_weight_total)
            : firstNumeric(
                finalLine?.actual_quantity,
                finalLine?.actual_piece_count
              )
        const fallbackQuantity =
          quantity ??
          firstNumeric(
            item.raw_quantity,
            detail.raw_quantity,
            detail.quantity,
            item.quantity
          ) ??
          1
        const unitPrice = firstNumeric(item.unit_price, item.raw_unit_price)
        const computedLineSubtotal =
          unitPrice !== null ? unitPrice * fallbackQuantity : null
        const subtotal =
          firstNumeric(finalLine?.final_line_subtotal) ??
          firstPositiveNumeric(
            item.raw_subtotal,
            item.subtotal,
            item.original_subtotal
          ) ??
          computedLineSubtotal ??
          0
        const total =
          firstNumeric(finalLine?.final_line_total) ??
          firstPositiveNumeric(
            item.raw_total,
            item.total,
            item.original_total
          ) ??
          (computedLineSubtotal !== null
            ? computedLineSubtotal + (numeric(item.tax_total) ?? 0)
            : null) ??
          subtotal
        const customerTitle = textValue(finalLine?.customer_title)

        return {
          ...item,
          title: customerTitle || item.title,
          metadata: qbdListId
            ? {
                ...metadata,
                qbd_list_id: qbdListId,
                catch_weight_actual_quantity:
                  finalLine?.actual_quantity ?? finalLine?.actual_piece_count,
                catch_weight_actual_piece_count:
                  finalLine?.actual_piece_count ?? null,
                catch_weight_actual_weight_total:
                  finalLine?.actual_weight_total ?? null,
                catch_weight_final_line_subtotal:
                  finalLine?.final_line_subtotal ?? null,
                catch_weight_final_line_total:
                  finalLine?.final_line_total ?? null,
                catch_weight_customer_title: customerTitle || null,
                catch_weight_line_note: finalLine?.note ?? null,
                catch_weight_replacement_reason:
                  finalLine?.replacement_reason ?? finalLine?.short_reason ?? null,
              }
            : item.metadata,
          quantity: fallbackQuantity,
          subtotal,
          total,
        }
      }).concat(
        Array.from(finalLines.entries())
          .filter(([lineItemId]) => !seenFinalLineIds.has(lineItemId))
          .map(([, finalLine]) => syntheticItemForFinalLine(finalLine))
          .filter((item): item is Record<string, unknown> => Boolean(item))
      )
    : order.items

  const itemTotal = Array.isArray(items)
    ? items.reduce((sum, item) => {
        if (!item || typeof item !== "object") return sum
        return sum + (numeric((item as Record<string, unknown>).total) ?? 0)
      }, 0)
    : null
  const itemSubtotal = Array.isArray(items)
    ? items.reduce((sum, item) => {
        if (!item || typeof item !== "object") return sum
        return sum + (numeric((item as Record<string, unknown>).subtotal) ?? 0)
      }, 0)
    : null

  const shippingTotal = numeric(order.shipping_total) ?? 0
  const taxTotal = numeric(order.tax_total) ?? 0
  const discountTotal = numeric(order.discount_total) ?? 0
  const grossItemTotal =
    firstPositiveNumeric(order.item_total) ??
    (itemTotal !== null && itemTotal > 0 ? itemTotal : null)
  const computedOrderTotal =
    grossItemTotal !== null
      ? grossItemTotal + shippingTotal - discountTotal
      : null
  const total =
    computedOrderTotal !== null && computedOrderTotal > 0
      ? computedOrderTotal
      : firstNumeric(order.total, itemTotal, taxTotal)
  const subtotal =
    firstPositiveNumeric(order.item_subtotal, order.subtotal) ??
    (itemSubtotal !== null && itemSubtotal > 0 ? itemSubtotal : null) ??
    (itemTotal !== null && itemTotal > 0 ? itemTotal : null) ??
    numeric(order.subtotal)
  const shippingAddress = objectRecord(order.shipping_address)
  const province =
    textValue(shippingAddress.province) ||
    textValue(shippingAddress.province_code)
  const qbdTaxMetadata: Record<string, unknown> = {}

  if (province) {
    const taxResolution = resolveFoodTaxForAddress(
      province,
      textValue(shippingAddress.postal_code)
    )
    qbdTaxMetadata.qbd_tax_state = taxResolution.state
    qbdTaxMetadata.qbd_tax_county = taxResolution.county
    qbdTaxMetadata.qbd_tax_rate = taxResolution.itemRate
    qbdTaxMetadata.qbd_sales_tax_code_full_name =
      taxResolution.qbdSalesTaxCodeFullName
    qbdTaxMetadata.qbd_shipping_sales_tax_code_full_name =
      taxResolution.qbdShippingSalesTaxCodeFullName

    if (taxResolution.qbdTaxItem) {
      qbdTaxMetadata.qbd_tax_item_list_id = taxResolution.qbdTaxItem.listId
      qbdTaxMetadata.qbd_tax_item_full_name = taxResolution.qbdTaxItem.fullName
    }
  }

  const baseMetadata = objectRecord(order.metadata)
  const enteredByStaffId = resolveEnteredByStaffId(baseMetadata)

  // #287: UPS transit days for the QuickBooks memo + last SalesOrder line (dry-ice planning).
  // Only for UPS services (Ground via the ZIP3 table, Overnight=1, 2-Day=2, 3-Day=3); never for
  // Atlanta delivery / pickup / Southeast route, which carry no UPS transit.
  const shippingMethod = Array.isArray(order.shipping_methods)
    ? objectRecord(order.shipping_methods[0])
    : {}
  const serviceCode =
    textValue(objectRecord(shippingMethod.data).service_code) ||
    textValue(shippingMethod.name) ||
    textValue(baseMetadata.service_code) ||
    textValue(baseMetadata.fulfillmentType) ||
    textValue(baseMetadata.fulfillment_type)
  const isUpsService =
    !!serviceCode &&
    /(ups|ground|overnight|next.?day|2nd.?day|2.?day|3.?day)/i.test(serviceCode) &&
    !/(atlanta|pickup|scheduled|southeast|local)/i.test(serviceCode)
  const upsTransitMeta: Record<string, unknown> = {}
  if (isUpsService) {
    const days = transitDaysForOrder(serviceCode, textValue(shippingAddress.postal_code))
    if (Number.isFinite(days) && days > 0) {
      upsTransitMeta.qbd_ups_transit_days = days
    }
  }

  return {
    ...order,
    metadata: {
      ...baseMetadata,
      ...qbdTaxMetadata,
      // #276: pass the entering staff member through so the QuickBooks memo can attribute
      // the order. catch_weight_packages (shipper boxes) already flow through baseMetadata.
      ...(enteredByStaffId ? { qbd_entered_by_staff_id: enteredByStaffId } : {}),
      // #287: UPS transit days for the QB memo + last SalesOrder line.
      ...upsTransitMeta,
    },
    items,
    subtotal,
    total,
  }
}

export async function legacyQbdListIdFallbacksForOrder(
  db: any,
  order: Record<string, unknown>
): Promise<QbdListIdFallbacks> {
  const variantIds = new Set<string>()
  const skus = new Set<string>()

  if (Array.isArray(order.items)) {
    for (const rawItem of order.items) {
      if (!rawItem || typeof rawItem !== "object") {
        continue
      }

      const item = rawItem as Record<string, unknown>
      const variant = objectRecord(item.variant)
      const detail = objectRecord(item.detail)

      for (const value of [item.variant_id, detail.variant_id, variant.id]) {
        const text = textValue(value)
        if (text) {
          variantIds.add(text)
        }
      }

      for (const value of [
        item.variant_sku,
        item.sku,
        detail.sku,
        variant.sku,
      ]) {
        const text = textValue(value)
        if (text) {
          skus.add(text.toLowerCase())
        }
      }
    }
  }

  if (!variantIds.size && !skus.size) {
    return {}
  }

  const rows = await db("legacy_item_map")
    .select(["qbd_item_list_id", "sku", "medusa_variant_id"])
    .whereNull("deleted_at")
    .andWhere((builder: any) => {
      if (variantIds.size) {
        builder.orWhereIn("medusa_variant_id", Array.from(variantIds))
      }

      if (skus.size) {
        builder.orWhereIn(db.raw("lower(sku)"), Array.from(skus))
      }
    })
    .orderBy("confidence", "desc")
    .orderBy("updated_at", "desc")

  const fallbacks: QbdListIdFallbacks = {}
  for (const row of rows) {
    const qbdListId = textValue(row.qbd_item_list_id)
    if (!qbdListId) {
      continue
    }

    const variantKey = lookupKey("variant", row.medusa_variant_id)
    if (variantKey && !fallbacks[variantKey]) {
      fallbacks[variantKey] = qbdListId
    }

    const skuKey = lookupKey("sku", row.sku)
    if (skuKey && !fallbacks[skuKey]) {
      fallbacks[skuKey] = qbdListId
    }
  }

  return fallbacks
}

export function buildQbSyncSignature(
  body: string,
  timestamp: string,
  secret: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")
}

export async function postOrderToQbSync(
  endpoint: string,
  token: string,
  order: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
  signingSecret = process.env.QB_SYNC_ORDER_IMPORT_SIGNING_SECRET || token,
  outbox?: QbdOutboxEnvelope
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS)
  const body = JSON.stringify({ order, ...(outbox ? { qbd_outbox: outbox } : {}) })
  const timestamp = String(Date.now())
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-QB-Sync-Token": token,
  }

  if (signingSecret) {
    headers["X-QB-Sync-Timestamp"] = timestamp
    headers["X-QB-Sync-Signature"] = buildQbSyncSignature(
      body,
      timestamp,
      signingSecret
    )
  }

  try {
    return await fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function importOrderToQbSync({
  orderId,
  container,
  source = "order.placed",
}: {
  orderId: string
  container: SubscriberArgs<{ id: string }>["container"]
  source?: string
}) {
  const logger = container.resolve("logger")
  const query = container.resolve("query")
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const endpoint = process.env.QB_SYNC_ORDER_IMPORT_URL
  const token = process.env.QB_SYNC_ORDER_IMPORT_TOKEN

  if (!endpoint || !token) {
    logger.warn(
      `[qb-sync-order-import] QB_SYNC_ORDER_IMPORT_URL or QB_SYNC_ORDER_IMPORT_TOKEN missing; skipped order=${orderId} source=${source}`
    )
    await emitOpsAlert({
      alertKind: "qbd_push_skipped",
      title: "QBD order import skipped because sync config is missing",
      path: "src/subscribers/qb-sync-order-import.ts",
      source: "medusa",
      severity: "page",
      logger,
      meta: {
        order_id: orderId,
        source_event: source,
        missing_url: !endpoint,
        missing_token: !token,
      },
    })
    return
  }

  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: orderId },
    })

    const order = orders?.[0] as Record<string, unknown> | undefined
    if (!order) {
      logger.warn(`[qb-sync-order-import] order not found id=${orderId} source=${source}`)
      await emitOpsAlert({
        alertKind: "qbd_push_skipped",
        title: "QBD order import skipped because order was not found",
        path: "src/subscribers/qb-sync-order-import.ts",
        source: "medusa",
        severity: "page",
        logger,
        meta: {
          order_id: orderId,
          source_event: source,
        },
      })
      return
    }

    const normalizedOrder = normalizeOrderForQbSync(
      order,
      await legacyQbdListIdFallbacksForOrder(db, order)
    )
    await emitMissingQbdLineIdentityAlert({
      orderId,
      source,
      missingLines: missingQbdLineIdentities(normalizedOrder),
      logger,
    })

    const response = await postOrderToQbSync(endpoint, token, normalizedOrder)

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      logger.error(
        `[qb-sync-order-import] import failed order=${orderId} source=${source} status=${response.status} body=${body.slice(0, 500)}`
      )
      // #251: QBD import failures must be queryable even though order flow continues.
      await emitOpsAlert({
        alertKind: "qbd_push_failed",
        title: `QBD order import failed for ${orderId}`,
        path: "src/subscribers/qb-sync-order-import.ts",
        source: "medusa",
        severity: "page",
        logger,
        meta: {
          order_id: orderId,
          source_event: source,
          status: response.status,
          body_preview: body.slice(0, 500),
        },
      })
      return
    }

    logger.info(`[qb-sync-order-import] imported order=${orderId} source=${source}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(
      `[qb-sync-order-import] failed for order ${orderId} source=${source}: ${message}`
    )
    // #251: QBD import exceptions must not disappear into logs only.
    await emitOpsAlert({
      alertKind: "qbd_push_failed",
      title: `QBD order import exception for ${orderId}`,
      path: "src/subscribers/qb-sync-order-import.ts",
      source: "medusa",
      severity: "page",
      logger,
      meta: {
        order_id: orderId,
        source_event: source,
        error: message,
      },
    })
  }
}

export default async function qbSyncOrderImportHandler({
  event: { name, data },
  container,
}: SubscriberArgs<{ id: string }>) {
  await importOrderToQbSync({
    orderId: data.id,
    container,
    source: name || "order.placed",
  })
}

export const config: SubscriberConfig = {
  event: ["order.placed", "order.updated", "order.final_charge_succeeded"],
}
