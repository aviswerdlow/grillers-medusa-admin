import { isInternalCatalogRecord, isInternalCatalogProduct } from "./public-catalog"
import { randomUUID } from "crypto"
import { variantNativeStock, unmirroredInventoryDemand, unmirroredVariantUnits, nativeReservedUnitsForLine, type NativeReservation } from "./inventory-stock"

export type AvailabilityLifecycle =
  | "active"
  | "seasonal_inactive"
  | "discontinued"
  | "internal_only"

export type AvailabilityDecision =
  | "available"
  | "partial"
  | "blocked"
  | "future_allowed"
  | "inactive"

export type AllocationStatus =
  | "draft"
  | "reserved"
  | "future_committed"
  | "blocked"
  | "substituted"
  | "released"
  | "fulfilled"
  | "canceled"

export type AllocationSource =
  | "customer_web"
  | "staff_phone_order"
  | "staff_adjustment"
  | "system_reconciliation"
  | "admin"

export type AvailabilityLineInput = {
  /** Trusted order-placement caller only; public/admin request adapters do not accept this field. */
  reservation_line_id?: string
  product_id?: string
  variant_id: string
  quantity: number
  qbd_list_id?: string
  sku?: string
  title?: string
  metadata?: Record<string, unknown> | null
}

export type AvailabilityCheckInput = {
  db: DbConnection
  query: QueryGraph
  lines: AvailabilityLineInput[]
  requested_fulfillment_date?: string | Date | null
  fulfillment_type?: string | null
  customer_id?: string | null
  cart_id?: string | null
  order_id?: string | null
  source?: AllocationSource
  include_internal?: boolean
  record_snapshots?: boolean
  now?: Date
}

export type AvailabilityAlternative = {
  product_id?: string
  variant_id: string
  title: string
  sku?: string
  available_to_promise_quantity?: number
  relationship: string
}

export type AvailabilityResult = {
  variant_id: string
  product_id?: string
  qbd_list_id?: string
  sku?: string
  title?: string
  requested_quantity: number
  current_stock_quantity: number
  allocated_quantity: number
  safety_stock_quantity: number
  available_to_promise_quantity: number
  lifecycle: AvailabilityLifecycle
  decision: AvailabilityDecision
  reason: string
  future_order_eligible: boolean
  replenishment_lead_days: number
  earliest_available_date?: string
  alternatives: AvailabilityAlternative[]
  manage_inventory?: boolean
  allow_backorder?: boolean
}

export type QueryGraph = {
  graph: (input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }) => Promise<{ data?: any[] }>
}

export type DbConnection = {
  (tableName: string): any
  raw?: (...args: any[]) => any
  transaction?: <T>(work: (trx: DbConnection) => Promise<T>) => Promise<T>
}

const ACTIVE_ALLOCATION_STATUSES = [
  "reserved",
  "future_committed",
  "blocked",
] as const

const BLOCKING_LIFECYCLES = new Set<AvailabilityLifecycle>([
  "seasonal_inactive",
  "discontinued",
  "internal_only",
])

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
  "ListID",
]

const LIFECYCLE_KEYS = [
  "availability_lifecycle",
  "availabilityLifecycle",
  "AvailabilityLifecycle",
]

const FUTURE_ORDER_KEYS = [
  "future_order_eligible",
  "futureOrderEligible",
  "FutureOrderEligible",
]

const REPLENISHMENT_KEYS = [
  "replenishment_lead_days",
  "replenishmentLeadDays",
  "ReplenishmentLeadDays",
]

const SAFETY_STOCK_KEYS = [
  "safety_stock_quantity",
  "safetyStockQuantity",
  "SafetyStockQuantity",
]

const ALTERNATIVE_KEYS = [
  "alternative_variant_ids",
  "alternativeVariantIds",
  "AlternativeVariantIds",
]

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (value && typeof value === "object" && "value" in value) {
    return numberValue((value as { value?: unknown }).value)
  }
  return undefined
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["true", "1", "yes", "y"].includes(normalized)) return true
    if (["false", "0", "no", "n"].includes(normalized)) return false
  }
  return undefined
}

function metadataText(metadata: unknown, keys: string[]): string | undefined {
  const record = objectRecord(metadata)
  for (const key of keys) {
    const value = textValue(record[key])
    if (value) return value
  }

  for (const namespace of ["qbd", "quickbooks", "qb"]) {
    const nested = objectRecord(record[namespace])
    const value =
      textValue(nested.list_id) ||
      textValue(nested.item_list_id) ||
      textValue(nested.item_id)
    if (value) return value
  }

  return undefined
}

function metadataNumber(
  variantMetadata: unknown,
  productMetadata: unknown,
  keys: string[],
  fallback: number
): number {
  for (const metadata of [variantMetadata, productMetadata]) {
    const record = objectRecord(metadata)
    for (const key of keys) {
      const parsed = numberValue(record[key])
      if (parsed !== undefined && parsed >= 0) return parsed
    }
  }
  return fallback
}

function metadataBoolean(
  variantMetadata: unknown,
  productMetadata: unknown,
  keys: string[],
  fallback: boolean
): boolean {
  for (const metadata of [variantMetadata, productMetadata]) {
    const record = objectRecord(metadata)
    for (const key of keys) {
      const parsed = booleanValue(record[key])
      if (parsed !== undefined) return parsed
    }
  }
  return fallback
}

export function qbdListIdFromMetadata(...metadataValues: unknown[]): string | undefined {
  for (const metadata of metadataValues) {
    const value = metadataText(metadata, QBD_LIST_ID_KEYS)
    if (value) return value
  }
  return undefined
}

export function lifecycleFromMetadata(
  variantMetadata: unknown,
  productMetadata: unknown
): AvailabilityLifecycle {
  for (const metadata of [variantMetadata, productMetadata]) {
    const record = objectRecord(metadata)
    for (const key of LIFECYCLE_KEYS) {
      const value = textValue(record[key])?.toLowerCase()
      if (
        value === "active" ||
        value === "seasonal_inactive" ||
        value === "discontinued" ||
        value === "internal_only"
      ) {
        return value
      }
    }
  }
  return "active"
}

function normalizeQuantity(value: unknown, fallback = 1): number {
  const parsed = numberValue(value)
  if (parsed === undefined || parsed <= 0) return fallback
  return Math.max(1, Math.floor(parsed))
}

function normalizeDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const text = textValue(value)
  if (!text) return null
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function normalizeFulfillmentDate(
  value: string | Date | null | undefined
): Date | null {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  return normalizeDate(value)
}

function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return Math.ceil((end - start) / 86_400_000)
}

function variantProduct(variant: Record<string, unknown>): Record<string, unknown> {
  return objectRecord(variant.product)
}

const variantStockQuantity = variantNativeStock

function alternativeVariantIds(
  variantMetadata: unknown,
  productMetadata: unknown
): string[] {
  for (const metadata of [variantMetadata, productMetadata]) {
    const record = objectRecord(metadata)
    for (const key of ALTERNATIVE_KEYS) {
      const value = record[key]
      if (Array.isArray(value)) {
        return value.map(textValue).filter(Boolean) as string[]
      }
      const text = textValue(value)
      if (text) {
        return text
          .split(/[,\s]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      }
    }
  }
  return []
}

async function fetchVariants(
  query: QueryGraph,
  variantIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!variantIds.length) return out
  if (variantIds.length > 100) {
    for (let i = 0; i < variantIds.length; i += 100) {
      for (const [id, variant] of await fetchVariants(query, variantIds.slice(i, i + 100))) out.set(id, variant)
    }
    return out
  }

  const fields = [
    "id",
    "sku",
    "title",
    "product_id",
    "metadata",
    "manage_inventory",
    "allow_backorder",
    "+inventory_quantity",
    "product.*",
    "product.metadata",
    "product.variants.id",
    "product.variants.sku",
    "product.variants.metadata",
    "inventory_items.*",
    "inventory_items.required_quantity",
    "inventory_items.inventory.*",
    "inventory_items.inventory.location_levels.*",
  ]

  try {
    const { data } = await query.graph({
      entity: "product_variant",
      fields,
      filters: { id: variantIds },
    })
    for (const variant of data || []) {
      if (variant?.id) out.set(variant.id, variant)
    }
  } catch {
    try {
      const { data } = await query.graph({
        entity: "product_variant",
        fields: [
          "id",
          "sku",
          "title",
          "product_id",
          "metadata",
          "manage_inventory",
          "allow_backorder",
          "+inventory_quantity",
          "product.*",
          "product.metadata",
          "product.variants.id",
          "product.variants.sku",
          "product.variants.metadata",
        ],
        filters: { id: variantIds },
      })
      for (const variant of data || []) {
        if (variant?.id) out.set(variant.id, variant)
      }
    } catch {
      for (const id of variantIds) out.set(id, { id })
    }
  }

  return out
}

type AllocationRow = {
  id: string
  variant_id: string
  line_item_id?: string | null
  quantity: number | string
  status: AllocationStatus
  requested_fulfillment_date?: Date | string | null
}

function shouldCountAllocation(row: AllocationRow, now: Date): boolean {
  if (row.status === "reserved" || row.status === "blocked") return true
  if (row.status !== "future_committed") return false

  const rowDate = normalizeDate(row.requested_fulfillment_date)
  const days = daysUntil(rowDate, now)
  return days === null || days < 14
}

async function inventoryStateForAvailability(
  input: AvailabilityCheckInput,
  variantIds: string[],
  now: Date
) {
  // Include other variants' commitments: components may share one inventory item.
  const activeRows = (await input.db("gp_inventory_allocation")
    .select("id", "variant_id", "line_item_id", "quantity", "status", "requested_fulfillment_date")
    .whereNull("deleted_at")
    .whereIn("status", ACTIVE_ALLOCATION_STATUSES as unknown as string[])) as AllocationRow[]
  const commitments = activeRows.filter(row => shouldCountAllocation(row, now))
  const variants = await fetchVariants(input.query, [...new Set([...variantIds, ...commitments.map(row => row.variant_id)])])
  const alternativeIds = variantIds.flatMap(id => {
    const variant = variants.get(id) || {}
    return alternativeVariantIds(variant.metadata, variantProduct(variant).metadata)
  }).filter(id => !variants.has(id))
  for (const [id, variant] of await fetchVariants(input.query, [...new Set(alternativeIds)])) variants.set(id, variant)
  const stocks = new Map([...variants].map(([id, variant]) => [id, variantStockQuantity(variant)]))
  const lineIds = [...new Set([
    ...commitments.map(row => row.line_item_id),
    ...input.lines.map(line => line.reservation_line_id),
  ].filter(Boolean))] as string[]
  const reservations: NativeReservation[] = lineIds.length ? await input.db("reservation_item")
    .select("line_item_id", "inventory_item_id", "location_id", "quantity")
    .whereNull("deleted_at").whereIn("line_item_id", lineIds) : []
  // An unmapped commitment can consume shared stock. Do not silently ignore it.
  const mappingUnverified = commitments.some(row => !stocks.get(row.variant_id)?.ready)
  const unmatched = mappingUnverified ? new Map<string, number>() : unmirroredInventoryDemand(commitments, stocks, reservations)
  return { variants, stocks, reservations, unmatched, mappingUnverified }
}

async function recordAvailabilitySnapshots(
  db: DbConnection,
  input: AvailabilityCheckInput,
  results: AvailabilityResult[],
  requestedDate: Date | null
): Promise<void> {
  if (!input.record_snapshots || !results.length) return
  const now = new Date()
  await db("gp_inventory_availability_snapshot").insert(
    results.map((result) => ({
      id: prefixedId("iatpsnap"),
      cart_id: input.cart_id || null,
      order_id: input.order_id || null,
      product_id: result.product_id || null,
      variant_id: result.variant_id,
      qbd_list_id: result.qbd_list_id || null,
      requested_quantity: result.requested_quantity,
      requested_fulfillment_date: requestedDate || null,
      fulfillment_type: input.fulfillment_type || null,
      current_stock_quantity: result.current_stock_quantity,
      allocated_quantity: result.allocated_quantity,
      safety_stock_quantity: result.safety_stock_quantity,
      available_to_promise_quantity: result.available_to_promise_quantity,
      lifecycle: result.lifecycle,
      decision: result.decision,
      reason: result.reason,
      source: input.source || "customer_web",
      metadata: {
        include_internal: Boolean(input.include_internal),
      },
      created_at: now,
      updated_at: now,
    }))
  )
}

export async function checkInventoryAvailability(
  input: AvailabilityCheckInput
): Promise<AvailabilityResult[]> {
  const now = input.now || new Date()
  const requestedDate = normalizeFulfillmentDate(input.requested_fulfillment_date)
  const normalizedLines = input.lines
    .filter((line) => line?.variant_id)
    .map((line) => ({
      ...line,
      quantity: normalizeQuantity(line.quantity, 1),
    }))
  const variantIds = Array.from(new Set(normalizedLines.map((line) => line.variant_id)))
  const state = await inventoryStateForAvailability(input, variantIds, now)
  const { variants } = state
  const requestedByVariant = new Map<string, number>()
  for (const line of normalizedLines) requestedByVariant.set(line.variant_id, (requestedByVariant.get(line.variant_id) || 0) + line.quantity)

  const results = normalizedLines.map((line) => {
    const variant = variants.get(line.variant_id) || { id: line.variant_id }
    const product = variantProduct(variant)
    const variantMetadata = objectRecord(variant.metadata)
    const productMetadata = objectRecord(product.metadata)
    const productId =
      line.product_id ||
      textValue(variant.product_id) ||
      textValue(product.id) ||
      undefined
    const lifecycle = isInternalCatalogRecord(variant) || isInternalCatalogProduct(product)
      ? "internal_only" : lifecycleFromMetadata(variantMetadata, productMetadata)
    const qbdListId =
      line.qbd_list_id ||
      qbdListIdFromMetadata(line.metadata, variantMetadata, productMetadata)
    const futureOrderEligible = metadataBoolean(
      variantMetadata,
      productMetadata,
      FUTURE_ORDER_KEYS,
      lifecycle === "active"
    )
    const replenishmentLeadDays = Math.max(
      0,
      Math.floor(
        metadataNumber(variantMetadata, productMetadata, REPLENISHMENT_KEYS, 14)
      )
    )
    const safetyStockQuantity = Math.max(
      0,
      Math.floor(metadataNumber(variantMetadata, productMetadata, SAFETY_STOCK_KEYS, 0))
    )
    const stock = variantStockQuantity(variant)
    const allocatedQuantity = unmirroredVariantUnits(stock, state.unmatched)
    const ownReserved = line.reservation_line_id
      ? nativeReservedUnitsForLine(stock, state.reservations, line.reservation_line_id) : 0
    const atp = Math.max(0, stock.quantity - allocatedQuantity - safetyStockQuantity)
    const requestedQuantity = requestedByVariant.get(line.variant_id) || line.quantity
    const days = daysUntil(requestedDate, now)
    const title =
      line.title ||
      textValue(variantMetadata.strapi_title) ||
      textValue(product.title) ||
      textValue(variant.title)
    const sku = line.sku || textValue(variant.sku)
    const alternativeIds = alternativeVariantIds(variantMetadata, productMetadata)

    let decision: AvailabilityDecision
    let reason: string
    let earliestAvailableDate: string | undefined

    if (BLOCKING_LIFECYCLES.has(lifecycle)) {
      decision = "inactive"
      reason = `lifecycle_${lifecycle}`
    } else if (!stock.ready) {
      decision = "blocked"
      reason = stock.reason || "inventory_baseline_required"
    } else if (line.reservation_line_id && ownReserved >= line.quantity) {
      // Placement runs after native reservation. The order's own last unit is
      // already secured; do not reclassify it as an oversell or promise it twice.
      decision = "available"
      reason = "native_reservation"
    } else if (state.mappingUnverified || allocatedQuantity > 0) {
      decision = "blocked"
      reason = "inventory_reconciliation_required"
    } else if (requestedQuantity <= atp) {
      decision = "available"
      reason = "in_stock"
    } else if (futureOrderEligible && days !== null && days >= replenishmentLeadDays) {
      // A lead-time estimate is not incoming stock. #364 will supply a dated,
      // quantity-limited reservation contract; until then there is no bypass.
      decision = "blocked"
      reason = "future_supply_unconfirmed"
    } else if (atp > 0) {
      decision = "partial"
      reason = "partial_atp"
    } else {
      decision = "blocked"
      reason = "insufficient_atp"
    }

    return {
      variant_id: line.variant_id,
      product_id: productId,
      qbd_list_id: qbdListId,
      sku,
      title,
      requested_quantity: line.quantity,
      current_stock_quantity: stock.quantity,
      allocated_quantity: allocatedQuantity,
      safety_stock_quantity: safetyStockQuantity,
      available_to_promise_quantity: atp,
      lifecycle,
      decision,
      reason,
      future_order_eligible: futureOrderEligible,
      replenishment_lead_days: replenishmentLeadDays,
      earliest_available_date: earliestAvailableDate,
      alternatives: alternativeIds.map((variantId) => ({
        variant_id: variantId,
        title: "Suggested replacement",
        relationship: "curated_metadata",
      })),
      manage_inventory: variant.manage_inventory as boolean | undefined,
      allow_backorder: variant.allow_backorder as boolean | undefined,
      metadata: {
        inventory_item_id: stock.inventoryItemId,
        stock_location_id: stock.stockLocationId,
      },
    } as AvailabilityResult & { metadata?: Record<string, unknown> }
  })

  for (const result of results) {
    result.alternatives = result.alternatives.flatMap(alternative => {
      const variant = state.variants.get(alternative.variant_id)
      if (!variant) return []
      const product = variantProduct(variant)
      const stock = variantStockQuantity(variant)
      if (isInternalCatalogRecord(variant) || isInternalCatalogProduct(product)
        || BLOCKING_LIFECYCLES.has(lifecycleFromMetadata(variant.metadata, product.metadata))
        || !stock.ready || state.mappingUnverified || unmirroredVariantUnits(stock, state.unmatched) > 0) return []
      const safety = Math.max(0, Math.floor(metadataNumber(variant.metadata, product.metadata, SAFETY_STOCK_KEYS, 0)))
      return [{ ...alternative,
        product_id: textValue(variant.product_id) || textValue(product.id),
        title: textValue(product.title) || textValue(variant.title) || alternative.title,
        sku: textValue(variant.sku), available_to_promise_quantity: Math.max(0, stock.quantity - safety),
      }]
    })
  }

  await recordAvailabilitySnapshots(input.db, input, results, requestedDate)

  return input.include_internal
    ? results
    : results.map((result) => ({
        ...result,
        qbd_list_id: undefined,
      }))
}

function allocationStatusForDecision(
  result: AvailabilityResult
): AllocationStatus {
  if (result.decision === "future_allowed") return "future_committed"
  if (result.decision === "available") return "reserved"
  return "blocked"
}

function allocationReasonForDecision(result: AvailabilityResult): string {
  if (result.decision === "future_allowed") return "future_window"
  if (result.decision === "available") return "in_stock"
  if (result.decision === "inactive") return "inactive_lifecycle"
  return "insufficient_atp"
}

async function insertAudit(
  db: DbConnection,
  input: {
    allocation_id: string
    event_type: string
    previous_status?: string | null
    next_status?: string | null
    previous_quantity?: number | null
    next_quantity?: number | null
    actor_type?: string
    actor_id?: string | null
    actor_email?: string | null
    reason?: string | null
    note?: string | null
    metadata?: Record<string, unknown> | null
  }
) {
  const now = new Date()
  await db("gp_inventory_allocation_audit").insert({
    id: prefixedId("iallocaud"),
    allocation_id: input.allocation_id,
    event_type: input.event_type,
    previous_status: input.previous_status || null,
    next_status: input.next_status || null,
    previous_quantity: input.previous_quantity ?? null,
    next_quantity: input.next_quantity ?? null,
    actor_type: input.actor_type || "system",
    actor_id: input.actor_id || null,
    actor_email: input.actor_email || null,
    reason: input.reason || null,
    note: input.note || null,
    metadata: input.metadata || null,
    created_at: now,
    updated_at: now,
  })
}

export function requestedFulfillmentDateFromMetadata(
  metadata: unknown
): string | undefined {
  const record = objectRecord(metadata)
  return (
    textValue(record.scheduledDate) ||
    textValue(record.requestedDeliveryDate) ||
    textValue(record.requested_fulfillment_date) ||
    textValue(record.fulfillment_date)
  )
}

function fulfillmentTypeFromMetadata(metadata: unknown): string | undefined {
  const record = objectRecord(metadata)
  return (
    textValue(record.fulfillmentType) ||
    textValue(record.fulfillment_type) ||
    textValue(record.deliveryMethod)
  )
}

function orderSourceFromMetadata(metadata: unknown): AllocationSource {
  const record = objectRecord(metadata)
  if (booleanValue(record.staff_phone_order)) return "staff_phone_order"
  if (textValue(record.source) === "staff_phone_order") return "staff_phone_order"
  return "customer_web"
}

const ORDER_ALLOCATION_FIELDS = [
  "id",
  "display_id",
  "email",
  "customer_id",
  // cart_id is read at insert time (cart attribution); without it in the query
  // the allocation row's cart_id always falls back to metadata.cart_id (usually
  // null), silently losing the cart→order linkage.
  "cart_id",
  "metadata",
  "items.*",
  "items.detail.*",
  "items.metadata",
  "items.variant.*",
  "items.variant.metadata",
  "items.variant.product.*",
  "items.variant.product.metadata",
  "items.variant.inventory_items.*",
  "items.variant.inventory_items.required_quantity",
  "items.variant.inventory_items.inventory.*",
  "items.variant.inventory_items.inventory.location_levels.*",
]

async function fetchOrderForAllocation(
  query: QueryGraph,
  orderId: string
): Promise<Record<string, unknown> | null> {
  const { data } = await query.graph({
    entity: "order",
    fields: ORDER_ALLOCATION_FIELDS,
    filters: { id: orderId },
  })
  return data?.[0] || null
}

function lineQuantity(item: Record<string, unknown>): number {
  const detail = objectRecord(item.detail)
  return normalizeQuantity(
    item.raw_quantity ||
      detail.raw_quantity ||
      detail.quantity ||
      item.quantity,
    1
  )
}

function lineVariantId(item: Record<string, unknown>): string | undefined {
  return textValue(item.variant_id) || textValue(objectRecord(item.variant).id)
}

function lineProductId(item: Record<string, unknown>): string | undefined {
  const variant = objectRecord(item.variant)
  return (
    textValue(item.product_id) ||
    textValue(variant.product_id) ||
    textValue(objectRecord(variant.product).id)
  )
}

function lineCustomerTitle(item: Record<string, unknown>): string | undefined {
  const metadata = objectRecord(item.metadata)
  const variant = objectRecord(item.variant)
  const product = objectRecord(variant.product)
  return (
    textValue(metadata.strapi_title) ||
    textValue(metadata.customer_title) ||
    textValue(product.title) ||
    textValue(item.product_title) ||
    textValue(item.title)
  )
}

function lineSku(item: Record<string, unknown>): string | undefined {
  const metadata = objectRecord(item.metadata)
  const variant = objectRecord(item.variant)
  return (
    textValue(metadata.sku) ||
    textValue(metadata.staff_line_sku) ||
    textValue(variant.sku) ||
    textValue(item.sku)
  )
}

function lineQbdListId(item: Record<string, unknown>): string | undefined {
  const metadata = objectRecord(item.metadata)
  const variant = objectRecord(item.variant)
  const product = objectRecord(variant.product)
  return qbdListIdFromMetadata(metadata, variant.metadata, product.metadata)
}

function lineOverrideReason(item: Record<string, unknown>): string | undefined {
  const metadata = objectRecord(item.metadata)
  return textValue(metadata.inventory_override_reason)
}

function lineOverrideNote(item: Record<string, unknown>): string | undefined {
  const metadata = objectRecord(item.metadata)
  return textValue(metadata.inventory_override_note)
}

async function existingAllocationForLine(
  db: DbConnection,
  orderId: string,
  lineItemId: string
): Promise<Record<string, unknown> | null> {
  const rows = await db("gp_inventory_allocation")
    .select("id", "status")
    .whereNull("deleted_at")
    .where({ order_id: orderId, line_item_id: lineItemId })
    .limit(1)
  return rows?.[0] || null
}

async function withLockedInventoryOrder<T>(
  db: DbConnection, orderId: string,
  work: (trx: DbConnection, order: Record<string, any>) => Promise<T>
): Promise<T> {
  if (!db.transaction) throw new Error("Inventory order transaction is unavailable")
  return db.transaction(async trx => {
    const order = await trx("order").where({ id: orderId }).whereNull("deleted_at").forUpdate().first("id", "status", "canceled_at")
    if (!order) throw new Error("Inventory order was not found")
    return work(trx, order)
  })
}

export async function createAllocationsForOrder(input: Parameters<typeof createAllocationsForLockedOrder>[0]) {
  return withLockedInventoryOrder(input.db, input.orderId, async (db, order) => {
    if (order.status === "canceled" || order.canceled_at) return { created: 0, skipped: 0, blocked: 0 }
    return createAllocationsForLockedOrder({ ...input, db })
  })
}

async function createAllocationsForLockedOrder({
  db,
  query,
  orderId,
  source,
  now,
}: {
  db: DbConnection
  query: QueryGraph
  orderId: string
  source?: AllocationSource
  now?: Date
}): Promise<{ created: number; skipped: number; blocked: number }> {
  const order = await fetchOrderForAllocation(query, orderId)
  if (!order) return { created: 0, skipped: 0, blocked: 0 }

  const metadata = objectRecord(order.metadata)
  const requestedDate = requestedFulfillmentDateFromMetadata(metadata)
  const fulfillmentType = fulfillmentTypeFromMetadata(metadata)
  const orderSource = source || orderSourceFromMetadata(metadata)
  const items = Array.isArray(order.items) ? order.items : []
  let created = 0
  let skipped = 0
  let blocked = 0

  for (const rawItem of items) {
    const item = objectRecord(rawItem)
    const lineItemId = textValue(item.id)
    const variantId = lineVariantId(item)
    if (!lineItemId || !variantId) {
      skipped += 1
      continue
    }

    const existing = await existingAllocationForLine(db, orderId, lineItemId)
    if (existing) {
      skipped += 1
      continue
    }

    const line: AvailabilityLineInput = {
      variant_id: variantId,
      product_id: lineProductId(item),
      qbd_list_id: lineQbdListId(item),
      sku: lineSku(item),
      title: lineCustomerTitle(item),
      quantity: lineQuantity(item),
      reservation_line_id: lineItemId,
      metadata: objectRecord(item.metadata),
    }

    const [availability] = await checkInventoryAvailability({
      db,
      query,
      lines: [line],
      requested_fulfillment_date: requestedDate,
      fulfillment_type: fulfillmentType,
      customer_id: textValue(order.customer_id),
      order_id: orderId,
      source: orderSource,
      include_internal: true,
      record_snapshots: true,
      now,
    })

    if (!availability) {
      skipped += 1
      continue
    }

    const status = allocationStatusForDecision(availability)
    const allocationId = prefixedId("ialloc")
    const current = new Date()
    const variant = objectRecord(item.variant)
    const inventory = variantStockQuantity(variant)

    await db("gp_inventory_allocation").insert({
      id: allocationId,
      order_id: orderId,
      line_item_id: lineItemId,
      cart_id: textValue(metadata.cart_id) || textValue(order.cart_id) || null,
      customer_id: textValue(order.customer_id) || null,
      customer_email: textValue(order.email) || null,
      product_id: availability.product_id || line.product_id || "",
      variant_id: variantId,
      inventory_item_id: inventory.inventoryItemId || null,
      stock_location_id: inventory.stockLocationId || null,
      qbd_list_id: availability.qbd_list_id || line.qbd_list_id || null,
      sku: availability.sku || line.sku || null,
      customer_title: availability.title || line.title || null,
      quantity: line.quantity,
      requested_fulfillment_date: normalizeFulfillmentDate(requestedDate),
      fulfillment_type: fulfillmentType || null,
      source: orderSource,
      status,
      allocation_reason: availability.reason,
      override_reason: status === "blocked" ? lineOverrideReason(item) || null : null,
      override_note: status === "blocked" ? lineOverrideNote(item) || null : null,
      staff_actor_customer_id: textValue(metadata.staff_actor_customer_id) || null,
      staff_actor_email: textValue(metadata.staff_actor_email) || null,
      metadata: {
        availability,
        display_id: order.display_id,
        substitution_preference: textValue(
          objectRecord(item.metadata).line_substitution_preference
        ),
      },
      created_at: current,
      updated_at: current,
    })

    await insertAudit(db, {
      allocation_id: allocationId,
      event_type: "created",
      next_status: status,
      next_quantity: line.quantity,
      actor_type: orderSource === "staff_phone_order" ? "staff" : "system",
      actor_id: textValue(metadata.staff_actor_customer_id),
      actor_email: textValue(metadata.staff_actor_email),
      reason: availability.reason,
      note: status === "blocked" ? lineOverrideNote(item) : undefined,
      metadata: {
        order_id: orderId,
        line_item_id: lineItemId,
        override_reason: status === "blocked" ? lineOverrideReason(item) : undefined,
      },
    })

    created += 1
    if (status === "blocked") blocked += 1
  }

  return { created, skipped, blocked }
}

export async function releaseAllocationsForOrder(input: Parameters<typeof releaseAllocationsForLockedOrder>[0]) {
  return withLockedInventoryOrder(input.db, input.orderId, db => releaseAllocationsForLockedOrder({ ...input, db }))
}

async function releaseAllocationsForLockedOrder({
  db,
  orderId,
  reason,
  actorType = "system",
  actorId,
  actorEmail,
  note,
  nextStatus = "released",
}: {
  db: DbConnection
  orderId: string
  reason: string
  actorType?: string
  actorId?: string | null
  actorEmail?: string | null
  note?: string | null
  nextStatus?: AllocationStatus
}): Promise<number> {
  const rows = await db("gp_inventory_allocation")
    .select("id", "status", "quantity")
    .whereNull("deleted_at")
    .where({ order_id: orderId })
    .whereIn("status", ACTIVE_ALLOCATION_STATUSES as unknown as string[])

  const now = new Date()
  for (const row of rows || []) {
    await db("gp_inventory_allocation")
      .where({ id: row.id })
      .update({
        status: nextStatus,
        allocation_reason: reason,
        released_at: nextStatus === "released" ? now : null,
        fulfilled_at: nextStatus === "fulfilled" ? now : null,
        updated_at: now,
      })
    await insertAudit(db, {
      allocation_id: row.id,
      event_type: nextStatus === "fulfilled" ? "fulfilled" : "released",
      previous_status: row.status,
      next_status: nextStatus,
      previous_quantity: normalizeQuantity(row.quantity, 0),
      next_quantity: normalizeQuantity(row.quantity, 0),
      actor_type: actorType,
      actor_id: actorId,
      actor_email: actorEmail,
      reason,
      note,
    })
  }

  return rows?.length || 0
}

export async function releaseAllocationLineQuantities({
  db,
  orderId,
  lines,
  reason,
  actorType = "staff",
  actorId,
  actorEmail,
  note,
}: {
  db: DbConnection
  orderId: string
  lines: Array<{ line_item_id: string; quantity: number }>
  reason: string
  actorType?: string
  actorId?: string | null
  actorEmail?: string | null
  note?: string | null
}): Promise<number> {
  let changed = 0
  const now = new Date()

  for (const releaseLine of lines) {
    const rows = await db("gp_inventory_allocation")
      .select("id", "status", "quantity")
      .whereNull("deleted_at")
      .where({ order_id: orderId, line_item_id: releaseLine.line_item_id })
      .whereIn("status", ACTIVE_ALLOCATION_STATUSES as unknown as string[])
      .limit(1)
    const row = rows?.[0]
    if (!row) continue

    const currentQuantity = normalizeQuantity(row.quantity, 0)
    const releaseQuantity = Math.min(
      currentQuantity,
      normalizeQuantity(releaseLine.quantity, 0)
    )
    if (releaseQuantity <= 0) continue

    const remaining = currentQuantity - releaseQuantity
    if (remaining <= 0) {
      await db("gp_inventory_allocation")
        .where({ id: row.id })
        .update({
          status: "released",
          allocation_reason: reason,
          released_at: now,
          updated_at: now,
        })
    } else {
      await db("gp_inventory_allocation")
        .where({ id: row.id })
        .update({
          quantity: remaining,
          allocation_reason: reason,
          updated_at: now,
        })
    }

    await insertAudit(db, {
      allocation_id: row.id,
      event_type: remaining <= 0 ? "released" : "quantity_changed",
      previous_status: row.status,
      next_status: remaining <= 0 ? "released" : row.status,
      previous_quantity: currentQuantity,
      next_quantity: remaining,
      actor_type: actorType,
      actor_id: actorId,
      actor_email: actorEmail,
      reason,
      note,
      metadata: {
        released_quantity: releaseQuantity,
      },
    })
    changed += 1
  }

  return changed
}

export async function fulfillAllocationsForFulfillment({
  db,
  query,
  fulfillmentId,
}: {
  db: DbConnection
  query: QueryGraph
  fulfillmentId: string
}): Promise<number> {
  const { data: links } = await query.graph({
    entity: "order_fulfillment",
    fields: ["order_id", "fulfillment_id"],
    filters: { fulfillment_id: fulfillmentId },
  })
  const orderId = links?.[0]?.order_id
  if (!orderId) return 0

  const { data: fulfillments } = await query.graph({
    entity: "fulfillment",
    fields: ["id", "items.*", "items.line_item_id"],
    filters: { id: fulfillmentId },
  })
  const lineIds = new Set(
    (fulfillments?.[0]?.items || [])
      .map((item: Record<string, unknown>) => textValue(item.line_item_id))
      .filter(Boolean)
  )

  if (!lineIds.size) {
    return releaseAllocationsForOrder({
      db,
      orderId,
      reason: "fulfilled",
      nextStatus: "fulfilled",
    })
  }

  const rows = await db("gp_inventory_allocation")
    .select("id", "status", "quantity")
    .whereNull("deleted_at")
    .where({ order_id: orderId })
    .whereIn("line_item_id", Array.from(lineIds))
    .whereIn("status", ACTIVE_ALLOCATION_STATUSES as unknown as string[])
  const now = new Date()

  for (const row of rows || []) {
    await db("gp_inventory_allocation").where({ id: row.id }).update({
      status: "fulfilled",
      allocation_reason: "fulfilled",
      fulfilled_at: now,
      updated_at: now,
    })
    await insertAudit(db, {
      allocation_id: row.id,
      event_type: "fulfilled",
      previous_status: row.status,
      next_status: "fulfilled",
      previous_quantity: normalizeQuantity(row.quantity, 0),
      next_quantity: normalizeQuantity(row.quantity, 0),
      reason: "fulfilled",
      metadata: { fulfillment_id: fulfillmentId },
    })
  }

  return rows?.length || 0
}
