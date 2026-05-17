type KnexLike = any

export type LegacyOrderListQuery = {
  q?: string
  email?: string
  customerId?: string
  qbdCustomerListId?: string
  legacyCustomerId?: string
  limit?: number
  offset?: number
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  if (value && typeof (value as any).toNumber === "function") {
    return Number((value as any).toNumber())
  }
  return 0
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim()
  return normalized.length ? normalized : null
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function legacyLineKind(row: any): string | null {
  const metadata = row.metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const kind = normalizeText(metadata.line_kind)
    if (kind) {
      return kind
    }
  }

  if (row.mapping_status === "non_product") {
    return "non_product"
  }

  const sku = normalizeSearchText(row.sku)
  const title = normalizeSearchText(row.title)
  const description = normalizeSearchText(row.description)
  const text = [sku, title, description].filter(Boolean).join(" ")

  if (!text) return "note"
  if (sku === "subtotal" || title === "subtotal" || text.includes(" subtotal ")) return "subtotal"
  if (
    sku === "ccc" ||
    title === "ccc" ||
    text.includes("credit debit") ||
    text.includes("credit card") ||
    text.includes("processing recovery fee")
  ) {
    return "fee"
  }
  if (text.includes("discount") || text.includes("coupon")) return "discount"
  if (
    sku === "pick up" ||
    sku === "pickup" ||
    title === "pick up" ||
    title === "pickup" ||
    text.includes("customer pick up") ||
    text.includes("local pickup") ||
    text.includes("shipping") ||
    text.includes("delivery charge")
  ) {
    return "fulfillment"
  }

  return "product"
}

export function isCustomerVisibleLegacyLine(row: any): boolean {
  return legacyLineKind(row) === "product"
}

export function normalizeEmail(value: unknown): string | null {
  const normalized = normalizeText(value)?.toLowerCase() ?? null
  if (!normalized || !normalized.includes("@")) {
    return null
  }
  return normalized
}

export function clampPagination(limit?: number, offset?: number) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const safeOffset = Math.max(Number(offset) || 0, 0)
  return { limit: safeLimit, offset: safeOffset }
}

function applyLegacyOrderFilters(query: any, filters: LegacyOrderListQuery) {
  query.whereNull("lo.deleted_at")

  const q = normalizeText(filters.q)
  if (q) {
    const like = `%${q.toLowerCase()}%`
    query.andWhere((builder: any) => {
      builder
        .whereRaw("lower(coalesce(lo.searchable_text, '')) like ?", [like])
        .orWhereRaw("lower(coalesce(lo.ref_number, '')) like ?", [like])
        .orWhereRaw("lower(coalesce(lo.qbd_txn_id, '')) like ?", [like])
        .orWhereRaw("lower(coalesce(lo.customer_name, '')) like ?", [like])
        .orWhereRaw("lower(coalesce(lo.email_lower, '')) like ?", [like])
        .orWhereExists(function () {
          this.select(1)
            .from("legacy_order_line as lol")
            .whereRaw("lol.legacy_order_id = lo.id")
            .whereNull("lol.deleted_at")
            .andWhere((lineBuilder: any) => {
              lineBuilder
                .whereRaw("lower(coalesce(lol.title, '')) like ?", [like])
                .orWhereRaw("lower(coalesce(lol.description, '')) like ?", [
                  like,
                ])
                .orWhereRaw("lower(coalesce(lol.sku, '')) like ?", [like])
                .orWhereRaw(
                  "lower(coalesce(lol.qbd_item_list_id, '')) like ?",
                  [like]
                )
            })
        })
    })
  }

  const email = normalizeEmail(filters.email)
  if (email) {
    query.andWhere("lo.email_lower", email)
  }

  const customerId = normalizeText(filters.customerId)
  if (customerId) {
    query.andWhere("lo.medusa_customer_id", customerId)
  }

  const qbdCustomerListId = normalizeText(filters.qbdCustomerListId)
  if (qbdCustomerListId) {
    query.andWhere("lo.qbd_customer_list_id", qbdCustomerListId)
  }

  const legacyCustomerId = normalizeText(filters.legacyCustomerId)
  if (legacyCustomerId) {
    query.andWhere("lo.legacy_customer_id", legacyCustomerId)
  }
}

export async function listLegacyOrders(db: KnexLike, filters: LegacyOrderListQuery) {
  const { limit, offset } = clampPagination(filters.limit, filters.offset)

  const base = db("legacy_order as lo")
  applyLegacyOrderFilters(base, filters)

  const countQuery = base
    .clone()
    .clearSelect()
    .count({ count: "*" })
    .first()

  const orderRows = await base
    .clone()
    .select([
      "lo.id",
      "lo.source",
      "lo.source_order_id",
      "lo.qbd_txn_id",
      "lo.ref_number",
      "lo.legacy_order_id",
      "lo.legacy_customer_id",
      "lo.qbd_customer_list_id",
      "lo.medusa_customer_id",
      "lo.email_lower",
      "lo.customer_name",
      "lo.placed_at",
      "lo.ship_date",
      "lo.status",
      "lo.subtotal",
      "lo.tax_total",
      "lo.shipping_total",
      "lo.discount_total",
      "lo.total",
      "lo.currency_code",
      "lo.line_count",
      "lo.imported_at",
    ])
    .orderBy("lo.placed_at", "desc")
    .orderBy("lo.created_at", "desc")
    .limit(limit)
    .offset(offset)

  const ids = orderRows.map((row: any) => row.id)
  const lines = ids.length
    ? await db("legacy_order_line")
        .select([
          "id",
          "legacy_order_id",
          "qbd_item_list_id",
          "sku",
          "title",
          "quantity",
          "unit_price",
          "line_total",
          "medusa_product_id",
          "medusa_variant_id",
          "mapping_status",
        ])
        .whereIn("legacy_order_id", ids)
        .whereNull("deleted_at")
        .orderBy("created_at", "asc")
    : []

  const linesByOrder = new Map<string, any[]>()
  for (const line of lines) {
    const bucket = linesByOrder.get(line.legacy_order_id) ?? []
    if (bucket.length < 8) {
      bucket.push(serializeLegacyOrderLine(line))
    }
    linesByOrder.set(line.legacy_order_id, bucket)
  }

  const countRow = await countQuery
  return {
    orders: orderRows.map((row: any) => ({
      ...serializeLegacyOrder(row),
      lines: linesByOrder.get(row.id) ?? [],
    })),
    count: asNumber(countRow?.count),
    limit,
    offset,
  }
}

export async function retrieveLegacyOrder(db: KnexLike, id: string) {
  const order = await db("legacy_order as lo")
    .select("lo.*")
    .where("lo.id", id)
    .whereNull("lo.deleted_at")
    .first()

  if (!order) {
    return null
  }

  const lines = await db("legacy_order_line")
    .select("*")
    .where("legacy_order_id", id)
    .whereNull("deleted_at")
    .orderBy("created_at", "asc")

  return {
    ...serializeLegacyOrder(order),
    source_snapshot: order.source_snapshot ?? null,
    metadata: order.metadata ?? null,
    lines: lines.map(serializeLegacyOrderLine),
  }
}

export async function listLegacyPurchaseHistoryForCustomer(
  db: KnexLike,
  medusaCustomerId: string
) {
  const customerMaps = await db("legacy_customer_map")
    .select([
      "legacy_customer_id",
      "qbd_customer_list_id",
      "email_lower",
    ])
    .where("medusa_customer_id", medusaCustomerId)
    .whereNull("deleted_at")

  const qbdCustomerListIds = customerMaps
    .map((row: any) => normalizeText(row.qbd_customer_list_id))
    .filter(Boolean)
  const legacyCustomerIds = customerMaps
    .map((row: any) => normalizeText(row.legacy_customer_id))
    .filter(Boolean)
  const emailLowers = customerMaps
    .map((row: any) => normalizeEmail(row.email_lower))
    .filter(Boolean)

  const rows = await db("legacy_order_line as lol")
    .join("legacy_order as lo", "lo.id", "lol.legacy_order_id")
    .select([
      "lol.id",
      "lol.legacy_order_id",
      "lol.qbd_item_list_id",
      "lol.sku",
      "lol.title",
      "lol.description",
      "lol.quantity",
      "lol.unit_price",
      "lol.line_total",
      "lol.currency_code",
      "lol.medusa_product_id",
      "lol.medusa_variant_id",
      "lol.medusa_product_title",
      "lol.medusa_variant_title",
      "lol.mapping_status",
      "lol.metadata",
      "lo.placed_at",
      "lo.ref_number",
      "lo.qbd_txn_id",
    ])
    .where((builder: any) => {
      builder.where("lo.medusa_customer_id", medusaCustomerId)
      if (qbdCustomerListIds.length) {
        builder.orWhereIn("lo.qbd_customer_list_id", qbdCustomerListIds)
      }
      if (legacyCustomerIds.length) {
        builder.orWhereIn("lo.legacy_customer_id", legacyCustomerIds)
      }
      if (emailLowers.length) {
        builder.orWhereIn("lo.email_lower", emailLowers)
      }
    })
    .whereNull("lo.deleted_at")
    .whereNull("lol.deleted_at")

  const grouped = new Map<string, any>()

  for (const row of rows) {
    if (!isCustomerVisibleLegacyLine(row)) {
      continue
    }

    const key =
      row.medusa_variant_id ||
      row.qbd_item_list_id ||
      row.sku ||
      `legacy-line:${row.id}`

    const placedAt = row.placed_at
      ? new Date(row.placed_at).toISOString()
      : new Date(0).toISOString()
    const quantity = asNumber(row.quantity)
    const existing = grouped.get(key)

    if (existing) {
      existing.timesOrdered += 1
      existing.totalQuantity += quantity
      existing.orderRefs.add(row.legacy_order_id)
      if (placedAt > existing.lastOrderedAt) {
        existing.lastOrderedAt = placedAt
        existing.unitPrice = asNumber(row.unit_price)
        existing.lastOrderRef = row.ref_number || row.qbd_txn_id || null
      }
      continue
    }

    grouped.set(key, {
      source: "legacy",
      key,
      variantId: row.medusa_variant_id ?? "",
      productId: row.medusa_product_id ?? "",
      legacyItemId: row.qbd_item_list_id ?? null,
      sku: row.sku ?? null,
      title: row.medusa_variant_title || row.title || row.description || "Legacy item",
      productTitle:
        row.medusa_product_title || row.title || row.description || "Legacy item",
      thumbnail: null,
      lastOrderedAt: placedAt,
      timesOrdered: 1,
      totalQuantity: quantity,
      unitPrice: asNumber(row.unit_price),
      currencyCode: row.currency_code || "usd",
      reorderable: !!row.medusa_variant_id,
      mappingStatus: row.mapping_status || (row.medusa_variant_id ? "mapped" : "unmapped"),
      lastOrderRef: row.ref_number || row.qbd_txn_id || null,
      orderRefs: new Set([row.legacy_order_id]),
    })
  }

  return Array.from(grouped.values())
    .map((item) => {
      const { orderRefs, ...rest } = item
      return {
        ...rest,
        orderCount: orderRefs.size,
      }
    })
    .sort(
      (a, b) =>
        new Date(b.lastOrderedAt).getTime() -
        new Date(a.lastOrderedAt).getTime()
    )
}

export function serializeLegacyOrder(row: any) {
  return {
    id: row.id,
    source: row.source,
    source_order_id: row.source_order_id,
    qbd_txn_id: row.qbd_txn_id,
    ref_number: row.ref_number,
    legacy_order_id: row.legacy_order_id,
    legacy_customer_id: row.legacy_customer_id,
    qbd_customer_list_id: row.qbd_customer_list_id,
    medusa_customer_id: row.medusa_customer_id,
    email_lower: row.email_lower,
    customer_name: row.customer_name,
    placed_at: row.placed_at ? new Date(row.placed_at).toISOString() : null,
    ship_date: row.ship_date ? new Date(row.ship_date).toISOString() : null,
    status: row.status,
    subtotal: asNumber(row.subtotal),
    tax_total: asNumber(row.tax_total),
    shipping_total: asNumber(row.shipping_total),
    discount_total: asNumber(row.discount_total),
    total: asNumber(row.total),
    currency_code: row.currency_code || "usd",
    line_count: asNumber(row.line_count),
    imported_at: row.imported_at ? new Date(row.imported_at).toISOString() : null,
  }
}

export function serializeLegacyOrderLine(row: any) {
  return {
    id: row.id,
    legacy_order_id: row.legacy_order_id,
    qbd_txn_line_id: row.qbd_txn_line_id,
    qbd_item_list_id: row.qbd_item_list_id,
    sku: row.sku,
    title: row.title,
    description: row.description,
    quantity: asNumber(row.quantity),
    unit_price: asNumber(row.unit_price),
    line_total: asNumber(row.line_total),
    currency_code: row.currency_code || "usd",
    medusa_product_id: row.medusa_product_id,
    medusa_variant_id: row.medusa_variant_id,
    medusa_product_title: row.medusa_product_title,
    medusa_variant_title: row.medusa_variant_title,
    mapping_status: row.mapping_status,
    metadata: row.metadata ?? null,
  }
}
