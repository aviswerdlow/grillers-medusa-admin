import Conductor from "conductor-node"
import mysql from "mysql2/promise"
import { XMLParser } from "fast-xml-parser"
import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  generateEntityId,
} from "@medusajs/framework/utils"
import {
  compact,
  getNumberArg,
  getStringArg,
  isoDate,
  loadFirstExistingEnvFile,
  normalizeEmail,
  parseArgs,
  requiredEnv,
  toNumber,
  toText,
  uniqueStrings,
  getBooleanArg,
} from "./lib/legacy-import-utils"

type NormalizedInvoice = {
  source: "quickbooks_desktop"
  sourceOrderId: string
  qbdTxnId: string | null
  refNumber: string | null
  qbdCustomerListId: string | null
  customerName: string | null
  placedAt: string | null
  shipDate: string | null
  status: string | null
  subtotal: number
  taxTotal: number
  total: number
  sourceUpdatedAt: string | null
  snapshot: Record<string, unknown>
  lines: NormalizedLine[]
}

type NormalizedLine = {
  sourceLineId: string
  qbdTxnLineId: string | null
  qbdItemListId: string | null
  qbdItemFullName: string | null
  lineKind: LegacyLineKind
  sku: string | null
  title: string | null
  description: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
  snapshot: Record<string, unknown>
}

type VariantMatch = {
  medusaProductId: string | null
  medusaVariantId: string | null
  medusaProductTitle: string | null
  medusaVariantTitle: string | null
  confidence: number
  mappingSource: string
}

type UnmappedProductSummary = {
  key: string
  qbdItemListId: string | null
  sku: string | null
  title: string | null
}

type LegacyLineKind =
  | "product"
  | "subtotal"
  | "fee"
  | "discount"
  | "fulfillment"
  | "note"
  | "adjustment"

const AMBIGUOUS = Symbol("ambiguous_variant_match")

type UniqueVariantIndex = Map<string, any | typeof AMBIGUOUS>

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

function parseDate(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`)
}

function addDays(date: Date, days: number) {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function buildMonthlyRanges(startStr: string, endStr: string) {
  const start = parseDate(startStr)
  const end = parseDate(endStr)
  const ranges: Array<{ startDate: string; endDate: string }> = []

  if (start > end) {
    throw new Error(`Invalid date range: ${startStr} > ${endStr}`)
  }

  let cursor = new Date(start.getTime())
  while (cursor <= end) {
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)
    )
    const rangeEnd = monthEnd < end ? monthEnd : end
    ranges.push({ startDate: dateOnly(cursor), endDate: dateOnly(rangeEnd) })
    cursor = addDays(rangeEnd, 1)
  }

  return ranges
}

function midpointDate(startStr: string, endStr: string) {
  return dateOnly(
    new Date(Math.floor((parseDate(startStr).getTime() + parseDate(endStr).getTime()) / 2))
  )
}

function isTimeoutError(error: unknown) {
  const message = String((error as any)?.message || "")
  return (
    message.includes("QBD_REQUEST_TIMEOUT") ||
    message.includes("Request timed out after 90 seconds")
  )
}

async function collectAllPages(fetchFirstPage: () => Promise<any>, maxPages: number) {
  const rows: any[] = []
  let page = await fetchFirstPage()
  let pageCount = 1

  rows.push(...(page.data ?? []))
  while (page.hasNextPage?.()) {
    if (pageCount >= maxPages) {
      throw new Error(`Exceeded max pages per request (${maxPages})`)
    }
    page = await page.getNextPage()
    pageCount += 1
    rows.push(...(page.data ?? []))
  }

  return rows
}

async function fetchRangeWithSplit(
  fetchForRange: (startDate: string, endDate: string) => Promise<any>,
  rangeStart: string,
  rangeEnd: string,
  maxPages: number
): Promise<any[]> {
  try {
    return await collectAllPages(
      () => fetchForRange(rangeStart, rangeEnd),
      maxPages
    )
  } catch (error) {
    if (!isTimeoutError(error) || rangeStart === rangeEnd) {
      throw error
    }

    const mid = midpointDate(rangeStart, rangeEnd)
    const rightStart = dateOnly(addDays(parseDate(mid), 1))
    if (parseDate(rightStart) > parseDate(rangeEnd)) {
      throw error
    }

    const left = await fetchRangeWithSplit(
      fetchForRange,
      rangeStart,
      mid,
      maxPages
    )
    const right = await fetchRangeWithSplit(
      fetchForRange,
      rightStart,
      rangeEnd,
      maxPages
    )
    return left.concat(right)
  }
}

function lastNameSegment(value: unknown) {
  const text = toText(value)
  if (!text) {
    return null
  }

  const segments = text.split(":").map((part) => part.trim()).filter(Boolean)
  return segments[segments.length - 1] ?? text
}

function normalizeLookupValue(value: unknown) {
  return toText(value)?.toLowerCase() ?? null
}

function normalizeSkuValue(value: unknown) {
  return normalizeLookupValue(value)?.replace(/[^a-z0-9]/g, "") ?? null
}

function normalizeSearchText(value: unknown) {
  return normalizeLookupValue(value)
    ?.replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? null
}

function addUniqueVariant(index: UniqueVariantIndex, key: string | null, row: any) {
  if (!key) {
    return
  }

  const existing = index.get(key)
  if (!existing) {
    index.set(key, row)
    return
  }

  if (existing !== AMBIGUOUS && existing.variant_id === row.variant_id) {
    return
  }

  index.set(key, AMBIGUOUS)
}

function lookupUniqueVariant(index: UniqueVariantIndex, key: string | null) {
  if (!key) {
    return null
  }

  const row = index.get(key)
  return row && row !== AMBIGUOUS ? row : null
}

function extractMetadataValues(metadata: unknown, keys: string[]) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return []
  }

  const record = metadata as Record<string, unknown>
  return keys.flatMap((key) => {
    const value = record[key]
    return Array.isArray(value) ? value : [value]
  }).map(toText).filter(Boolean) as string[]
}

function extractSkuLikeValues(value: unknown) {
  const text = toText(value)
  if (!text) {
    return []
  }

  return text.match(/\b[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,8}){1,5}\b/gi) ?? []
}

function classifyLegacyLine(input: {
  qbdItemListId?: string | null
  sku?: string | null
  title?: string | null
  description?: string | null
  qbdItemFullName?: string | null
  lineTotal?: number
}): LegacyLineKind {
  const sku = normalizeSearchText(input.sku)
  const title = normalizeSearchText(input.title)
  const description = normalizeSearchText(input.description)
  const qbdName = normalizeSearchText(input.qbdItemFullName)
  const blob = [sku, title, description, qbdName].filter(Boolean).join(" ")

  if (!blob) {
    return "note"
  }

  if (
    sku === "subtotal" ||
    title === "subtotal" ||
    blob.includes(" subtotal ")
  ) {
    return "subtotal"
  }

  if (
    sku === "ccc" ||
    title === "ccc" ||
    blob.includes("credit debit") ||
    blob.includes("credit card") ||
    blob.includes("processing recovery fee") ||
    blob.includes("card processing")
  ) {
    return "fee"
  }

  if (
    blob.includes("discount") ||
    blob.includes("coupon") ||
    blob.includes("refund adjustment")
  ) {
    return "discount"
  }

  if (
    sku === "pick up" ||
    sku === "pickup" ||
    title === "pick up" ||
    title === "pickup" ||
    blob.includes("customer pick up") ||
    blob.includes("local pickup") ||
    blob.includes("shipping") ||
    blob.includes("delivery charge")
  ) {
    return "fulfillment"
  }

  if (!input.qbdItemListId && Number(input.lineTotal || 0) === 0) {
    return "note"
  }

  if (!extractSkuLikeValues(input.sku).length && !input.qbdItemListId) {
    return "adjustment"
  }

  return "product"
}

function lineSkuCandidates(line: NormalizedLine) {
  return uniqueStrings([
    line.sku,
    lastNameSegment(line.qbdItemFullName),
    line.title,
    ...extractSkuLikeValues(line.description),
  ])
}

async function loadVariantIndexes(db: any) {
  const rows = await db("product_variant as pv")
    .leftJoin("product as p", "p.id", "pv.product_id")
    .select([
      "pv.id as variant_id",
      "pv.sku as sku",
      "pv.barcode as barcode",
      "pv.ean as ean",
      "pv.upc as upc",
      "pv.metadata as variant_metadata",
      "pv.title as variant_title",
      "pv.product_id as product_id",
      "p.external_id as product_external_id",
      "p.metadata as product_metadata",
      "p.title as product_title",
    ])
    .whereNull("pv.deleted_at")
    .where((builder: any) => {
      builder.whereNull("p.deleted_at").orWhereNull("p.id")
    })

  const variantCounts = new Map<string, number>()
  for (const row of rows) {
    if (row.product_id) {
      variantCounts.set(row.product_id, (variantCounts.get(row.product_id) ?? 0) + 1)
    }
  }

  const indexedRows = rows.map((row: any) => ({
    ...row,
    product_variant_count: row.product_id
      ? variantCounts.get(row.product_id) ?? 1
      : 1,
  }))

  const bySku: UniqueVariantIndex = new Map()
  const byNormalizedSku: UniqueVariantIndex = new Map()
  const byLegacyValue: UniqueVariantIndex = new Map()
  const byVariantTitle: UniqueVariantIndex = new Map()
  const byProductTitle: UniqueVariantIndex = new Map()
  const titleContainmentRows: Array<{ key: string; row: any }> = []

  const legacyMetadataKeys = [
    "qbd_item_list_id",
    "qbdItemListId",
    "quickbooks_item_id",
    "quickbooksItemId",
    "quickbooks_list_id",
    "quickbooksListId",
    "legacy_item_id",
    "legacyItemId",
    "legacy_sku",
    "legacySku",
    "item_code",
    "itemCode",
    "Sku",
    "sku",
  ]

  for (const row of indexedRows) {
    addUniqueVariant(bySku, normalizeLookupValue(row.sku), row)
    addUniqueVariant(byNormalizedSku, normalizeSkuValue(row.sku), row)
    addUniqueVariant(byLegacyValue, normalizeLookupValue(row.barcode), row)
    addUniqueVariant(byLegacyValue, normalizeLookupValue(row.ean), row)
    addUniqueVariant(byLegacyValue, normalizeLookupValue(row.upc), row)
    addUniqueVariant(byLegacyValue, normalizeLookupValue(row.product_external_id), row)
    addUniqueVariant(byVariantTitle, normalizeSearchText(row.variant_title), row)

    if (row.product_variant_count === 1) {
      const productTitle = normalizeSearchText(row.product_title)
      addUniqueVariant(byProductTitle, productTitle, row)
      if (productTitle && productTitle.length >= 10) {
        titleContainmentRows.push({ key: productTitle, row })
      }
    }

    for (const value of [
      ...extractMetadataValues(row.variant_metadata, legacyMetadataKeys),
      ...extractMetadataValues(row.product_metadata, legacyMetadataKeys),
    ]) {
      addUniqueVariant(byLegacyValue, normalizeLookupValue(value), row)
      addUniqueVariant(byLegacyValue, normalizeSkuValue(value), row)
    }
  }

  titleContainmentRows.sort((a, b) => b.key.length - a.key.length)

  return {
    bySku,
    byNormalizedSku,
    byLegacyValue,
    byVariantTitle,
    byProductTitle,
    titleContainmentRows,
  }
}

async function loadExistingItemMap(db: any) {
  const rows = await db("legacy_item_map")
    .select("*")
    .whereNotNull("qbd_item_list_id")
    .whereNull("deleted_at")

  return new Map<string, any>(
    rows.map((row: any) => [row.qbd_item_list_id, row])
  )
}

function variantMatchFromRow(row: any, confidence: number, mappingSource: string): VariantMatch {
  return {
    medusaProductId: row.product_id ?? row.medusa_product_id ?? null,
    medusaVariantId: row.variant_id ?? row.medusa_variant_id ?? null,
    medusaProductTitle: row.product_title ?? row.medusa_product_title ?? null,
    medusaVariantTitle: row.variant_title ?? row.medusa_variant_title ?? null,
    confidence,
    mappingSource,
  }
}

function resolveVariantMatch(
  line: NormalizedLine,
  variantIndexes: Awaited<ReturnType<typeof loadVariantIndexes>>,
  existingItemMap: Map<string, any>
): VariantMatch {
  if (line.lineKind !== "product") {
    return {
      medusaProductId: null,
      medusaVariantId: null,
      medusaProductTitle: null,
      medusaVariantTitle: null,
      confidence: 0,
      mappingSource: `non_product:${line.lineKind}`,
    }
  }

  const mapped = line.qbdItemListId
    ? existingItemMap.get(line.qbdItemListId)
    : null
  if (mapped?.medusa_variant_id) {
    return variantMatchFromRow(mapped, toNumber(mapped.confidence) || 1, "legacy_item_map")
  }

  const legacyValueCandidates = uniqueStrings([
    line.qbdItemListId,
    line.qbdItemFullName,
    line.sku,
    ...lineSkuCandidates(line),
  ])
  for (const candidate of legacyValueCandidates) {
    const variant =
      lookupUniqueVariant(variantIndexes.byLegacyValue, normalizeLookupValue(candidate)) ||
      lookupUniqueVariant(variantIndexes.byLegacyValue, normalizeSkuValue(candidate))
    if (variant) {
      return variantMatchFromRow(variant, 0.98, "legacy_metadata_exact")
    }
  }

  for (const candidate of lineSkuCandidates(line)) {
    const variant =
      lookupUniqueVariant(variantIndexes.bySku, normalizeLookupValue(candidate)) ||
      lookupUniqueVariant(variantIndexes.byNormalizedSku, normalizeSkuValue(candidate))
    if (variant) {
      return variantMatchFromRow(variant, 0.95, "sku_exact_or_normalized")
    }
  }

  for (const titleCandidate of [line.title, line.description]) {
    const title = normalizeSearchText(titleCandidate)
    const variant =
      lookupUniqueVariant(variantIndexes.byVariantTitle, title) ||
      lookupUniqueVariant(variantIndexes.byProductTitle, title)
    if (variant) {
      return variantMatchFromRow(variant, 0.7, "title_exact_normalized")
    }
  }

  const description = normalizeSearchText(line.description)
  if (description) {
    const matches = variantIndexes.titleContainmentRows.filter(({ key }) =>
      description.includes(key)
    )
    if (matches.length === 1 || (matches[0] && matches[0].key.length > matches[1]?.key.length)) {
      return variantMatchFromRow(matches[0].row, 0.72, "product_title_contained")
    }
  }

  return {
    medusaProductId: null,
    medusaVariantId: null,
    medusaProductTitle: null,
    medusaVariantTitle: null,
    confidence: 0,
    mappingSource: "unmapped",
  }
}

async function resolveCustomerProjection(db: any, qbdCustomerListId: string | null) {
  if (!qbdCustomerListId) {
    return null
  }

  return db("legacy_customer_map")
    .select(["medusa_customer_id", "email_lower", "legacy_customer_id"])
    .where("qbd_customer_list_id", qbdCustomerListId)
    .whereNull("deleted_at")
    .first()
}

async function upsertLegacyItemMap(
  db: any,
  line: NormalizedLine,
  match: VariantMatch,
  apply: boolean
) {
  if (!apply || !line.qbdItemListId) {
    return
  }

  const now = new Date()
  const existing = await db("legacy_item_map")
    .select("id")
    .where("qbd_item_list_id", line.qbdItemListId)
    .whereNull("deleted_at")
    .first()

  const row = {
    qbd_name: line.qbdItemFullName,
    sku: line.sku,
    medusa_product_id: match.medusaProductId,
    medusa_variant_id: match.medusaVariantId,
    medusa_product_title: match.medusaProductTitle,
    medusa_variant_title: match.medusaVariantTitle,
    confidence: match.confidence,
    mapping_source: match.mappingSource,
    last_seen_at: now,
    metadata: {
      line_kind: line.lineKind,
      last_line_title: line.title,
      last_line_description: line.description,
    },
    updated_at: now,
  }

  if (existing) {
    await db("legacy_item_map").where({ id: existing.id }).update(row)
    return
  }

  await db("legacy_item_map").insert({
    id: generateEntityId(undefined, "lgimap"),
    qbd_item_list_id: line.qbdItemListId,
    ...row,
    created_at: now,
  })
}

function buildSearchableText(
  invoice: NormalizedInvoice,
  customerProjection: any,
  lines: NormalizedLine[]
) {
  return compact([
    invoice.refNumber,
    invoice.qbdTxnId,
    invoice.qbdCustomerListId,
    invoice.customerName,
    customerProjection?.email_lower,
    customerProjection?.legacy_customer_id,
    ...lines.flatMap((line) => [
      line.qbdItemListId,
      line.qbdItemFullName,
      line.sku,
      line.title,
      line.description,
    ]),
  ]).join(" ")
}

function summarizeUnmappedProduct(line: NormalizedLine): UnmappedProductSummary {
  const key =
    line.qbdItemListId ||
    line.sku ||
    line.title ||
    line.description ||
    line.sourceLineId

  return {
    key,
    qbdItemListId: line.qbdItemListId,
    sku: line.sku,
    title: line.title || line.description,
  }
}

async function upsertInvoiceProjection({
  db,
  invoice,
  variantIndexes,
  existingItemMap,
  apply,
}: {
  db: any
  invoice: NormalizedInvoice
  variantIndexes: Awaited<ReturnType<typeof loadVariantIndexes>>
  existingItemMap: Map<string, any>
  apply: boolean
}) {
  const now = new Date()
  const customerProjection = await resolveCustomerProjection(
    db,
    invoice.qbdCustomerListId
  )
  const existing = await db("legacy_order")
    .select("id")
    .where("source", invoice.source)
    .where("source_order_id", invoice.sourceOrderId)
    .whereNull("deleted_at")
    .first()

  const orderId = existing?.id ?? generateEntityId(undefined, "lgord")
  const orderRow = {
    source: invoice.source,
    source_order_id: invoice.sourceOrderId,
    qbd_txn_id: invoice.qbdTxnId,
    ref_number: invoice.refNumber,
    legacy_order_id: null,
    legacy_customer_id: customerProjection?.legacy_customer_id ?? null,
    qbd_customer_list_id: invoice.qbdCustomerListId,
    medusa_customer_id: customerProjection?.medusa_customer_id ?? null,
    email_lower: normalizeEmail(customerProjection?.email_lower),
    customer_name: invoice.customerName,
    placed_at: invoice.placedAt,
    ship_date: invoice.shipDate,
    status: invoice.status,
    subtotal: invoice.subtotal,
    tax_total: invoice.taxTotal,
    shipping_total: 0,
    discount_total: 0,
    total: invoice.total,
    currency_code: "usd",
    line_count: invoice.lines.length,
    searchable_text: buildSearchableText(invoice, customerProjection, invoice.lines),
    source_updated_at: invoice.sourceUpdatedAt,
    imported_at: now,
    source_snapshot: invoice.snapshot,
    metadata: {
      projection_version: 1,
    },
    updated_at: now,
  }

  if (!apply) {
    let productLines = 0
    let mappedLines = 0
    const unmappedProductItems: UnmappedProductSummary[] = []

    for (const line of invoice.lines) {
      if (line.lineKind !== "product") {
        continue
      }

      productLines += 1
      const match = resolveVariantMatch(line, variantIndexes, existingItemMap)
      if (match.medusaVariantId) {
        mappedLines += 1
      } else {
        unmappedProductItems.push(summarizeUnmappedProduct(line))
      }
    }

    return {
      orderId,
      lines: invoice.lines.length,
      productLines,
      nonProductLines: invoice.lines.length - productLines,
      mappedLines,
      unmappedProductItems,
    }
  }

  if (existing) {
    await db("legacy_order").where({ id: orderId }).update(orderRow)
  } else {
    await db("legacy_order").insert({
      id: orderId,
      ...orderRow,
      created_at: now,
    })
  }

  const activeSourceLineIds: string[] = []
  let mappedLines = 0
  let productLines = 0
  let nonProductLines = 0
  const unmappedProductItems: UnmappedProductSummary[] = []

  for (const line of invoice.lines) {
    const match = resolveVariantMatch(line, variantIndexes, existingItemMap)
    if (line.lineKind === "product") {
      productLines += 1
    } else {
      nonProductLines += 1
    }
    if (line.lineKind === "product" && match.medusaVariantId) {
      mappedLines += 1
    } else if (line.lineKind === "product") {
      unmappedProductItems.push(summarizeUnmappedProduct(line))
    }
    await upsertLegacyItemMap(db, line, match, apply)
    if (line.qbdItemListId) {
      existingItemMap.set(line.qbdItemListId, {
        qbd_item_list_id: line.qbdItemListId,
        qbd_name: line.qbdItemFullName,
        medusa_product_id: match.medusaProductId,
        medusa_variant_id: match.medusaVariantId,
        medusa_product_title: match.medusaProductTitle,
        medusa_variant_title: match.medusaVariantTitle,
        confidence: match.confidence,
      })
    }

    activeSourceLineIds.push(line.sourceLineId)
    const existingLine = await db("legacy_order_line")
      .select("id")
      .where("source", invoice.source)
      .where("source_line_id", line.sourceLineId)
      .whereNull("deleted_at")
      .first()

    const lineRow = {
      legacy_order_id: orderId,
      source: invoice.source,
      source_line_id: line.sourceLineId,
      qbd_txn_line_id: line.qbdTxnLineId,
      qbd_item_list_id: line.qbdItemListId,
      sku: line.sku,
      title: line.title,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      line_total: line.lineTotal,
      currency_code: "usd",
      medusa_product_id: match.medusaProductId,
      medusa_variant_id: match.medusaVariantId,
      medusa_product_title: match.medusaProductTitle,
      medusa_variant_title: match.medusaVariantTitle,
      mapping_status:
        line.lineKind === "product"
          ? match.medusaVariantId ? "mapped" : "unmapped"
          : "non_product",
      imported_at: now,
      source_snapshot: line.snapshot,
      metadata: {
        line_kind: line.lineKind,
        mapping_confidence: match.confidence,
        mapping_source: match.mappingSource,
      },
      updated_at: now,
    }

    if (existingLine) {
      await db("legacy_order_line").where({ id: existingLine.id }).update(lineRow)
    } else {
      await db("legacy_order_line").insert({
        id: generateEntityId(undefined, "lgline"),
        ...lineRow,
        created_at: now,
      })
    }
  }

  if (activeSourceLineIds.length) {
    await db("legacy_order_line")
      .where("legacy_order_id", orderId)
      .where("source", invoice.source)
      .whereNotIn("source_line_id", activeSourceLineIds)
      .whereNull("deleted_at")
      .update({ deleted_at: now, updated_at: now })
  }

  return {
    orderId,
    lines: invoice.lines.length,
    productLines,
    nonProductLines,
    mappedLines,
    unmappedProductItems,
  }
}

function normalizeConductorLine(
  invoiceId: string,
  line: any,
  index: number
): NormalizedLine {
  const qbdItemFullName = toText(line.item?.fullName)
  const title = lastNameSegment(qbdItemFullName) || toText(line.description)
  const quantity = toNumber(line.quantity || 1)
  const lineTotal = toNumber(line.amount)
  const unitPrice = toNumber(line.rate) || (quantity ? lineTotal / quantity : lineTotal)
  const sku = lastNameSegment(qbdItemFullName)
  const description = toText(line.description)
  const lineKind = classifyLegacyLine({
    qbdItemListId: toText(line.item?.id),
    qbdItemFullName,
    sku,
    title,
    description,
    lineTotal,
  })

  return {
    sourceLineId: `${invoiceId}:${line.id || index}`,
    qbdTxnLineId: toText(line.id),
    qbdItemListId: toText(line.item?.id),
    qbdItemFullName,
    lineKind,
    sku,
    title,
    description,
    quantity,
    unitPrice,
    lineTotal,
    snapshot: {
      objectType: line.objectType,
      unitOfMeasure: line.unitOfMeasure ?? null,
      itemFullName: qbdItemFullName,
    },
  }
}

function normalizeConductorInvoice(invoice: any): NormalizedInvoice | null {
  const sourceOrderId = toText(invoice.id)
  if (!sourceOrderId) {
    return null
  }

  const lines = (invoice.lines ?? []).map((line: any, index: number) =>
    normalizeConductorLine(sourceOrderId, line, index)
  )
  const subtotal = toNumber(invoice.subtotal)
  const taxTotal = toNumber(invoice.salesTaxTotal)

  return {
    source: "quickbooks_desktop",
    sourceOrderId,
    qbdTxnId: sourceOrderId,
    refNumber: toText(invoice.refNumber),
    qbdCustomerListId: toText(invoice.customer?.id),
    customerName: toText(invoice.customer?.fullName),
    placedAt: isoDate(invoice.transactionDate),
    shipDate: isoDate(invoice.shippingDate),
    status: invoice.isPaid ? "paid" : "open",
    subtotal,
    taxTotal,
    total: subtotal + taxTotal,
    sourceUpdatedAt: isoDate(invoice.updatedAt),
    snapshot: {
      refNumber: toText(invoice.refNumber),
      customerId: toText(invoice.customer?.id),
      transactionDate: toText(invoice.transactionDate),
      updatedAt: toText(invoice.updatedAt),
      lineCount: lines.length,
      subtotal,
      taxTotal,
      isPaid: invoice.isPaid ?? null,
    },
    lines,
  }
}

async function fetchConductorInvoices({
  startDate,
  endDate,
  maxRecords,
  pageLimit,
  maxPages,
}: {
  startDate: string
  endDate: string
  maxRecords: number
  pageLimit: number
  maxPages: number
}) {
  loadFirstExistingEnvFile([
    process.env.CONDUCTOR_ENV_FILE,
    process.env.ENV_FILE,
    ".env",
  ])

  let apiKey = process.env.CONDUCTOR_SECRET_KEY || process.env.CONDUCTOR_API_KEY
  if (!apiKey || !process.env.CONDUCTOR_END_USER_ID) {
    loadFirstExistingEnvFile(["../grillerspride/.env"])
    apiKey = process.env.CONDUCTOR_SECRET_KEY || process.env.CONDUCTOR_API_KEY
  }

  if (!apiKey) {
    throw new Error("Missing CONDUCTOR_SECRET_KEY or CONDUCTOR_API_KEY")
  }

  const conductorEndUserId = requiredEnv("CONDUCTOR_END_USER_ID")
  const conductor = new Conductor({ apiKey })
  const ranges = buildMonthlyRanges(startDate, endDate)
  const byId = new Map<string, any>()

  for (const range of ranges) {
    const rows = await fetchRangeWithSplit(
      (rangeStart, rangeEnd) =>
        conductor.qbd.invoices.list({
          conductorEndUserId,
          transactionDateFrom: rangeStart,
          transactionDateTo: rangeEnd,
          includeLineItems: true,
          limit: pageLimit,
        }),
      range.startDate,
      range.endDate,
      maxPages
    )

    for (const row of rows) {
      if (row?.id) {
        byId.set(row.id, row)
      }
      if (maxRecords > 0 && byId.size >= maxRecords) {
        return Array.from(byId.values())
      }
    }
  }

  return Array.from(byId.values())
}

function findFirstKey(value: any, key: string): any {
  if (!value || typeof value !== "object") {
    return null
  }

  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return value[key]
  }

  for (const child of Object.values(value)) {
    const found = findFirstKey(child, key)
    if (found) {
      return found
    }
  }

  return null
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function normalizeXmlLine(invoiceId: string, line: any, index: number): NormalizedLine {
  const itemRef = line.ItemRef ?? {}
  const qbdItemFullName = toText(itemRef.FullName)
  const title = lastNameSegment(qbdItemFullName) || toText(line.Desc)
  const quantity = toNumber(line.Quantity || 1)
  const lineTotal = toNumber(line.Amount)
  const unitPrice = toNumber(line.Rate) || (quantity ? lineTotal / quantity : lineTotal)
  const sku = lastNameSegment(qbdItemFullName)
  const description = toText(line.Desc)
  const lineKind = classifyLegacyLine({
    qbdItemListId: toText(itemRef.ListID),
    qbdItemFullName,
    sku,
    title,
    description,
    lineTotal,
  })

  return {
    sourceLineId: `${invoiceId}:${toText(line.TxnLineID) || index}`,
    qbdTxnLineId: toText(line.TxnLineID),
    qbdItemListId: toText(itemRef.ListID),
    qbdItemFullName,
    lineKind,
    sku,
    title,
    description,
    quantity,
    unitPrice,
    lineTotal,
    snapshot: {
      itemFullName: qbdItemFullName,
    },
  }
}

function normalizeLegacyMysqlInvoice(row: any, parser: XMLParser): NormalizedInvoice | null {
  const sourceOrderId = toText(row.TXNID) || String(row.ID)
  if (!sourceOrderId) {
    return null
  }

  let invoiceRet: any = null
  try {
    invoiceRet = row.INVOICEXML ? findFirstKey(parser.parse(row.INVOICEXML), "InvoiceRet") : null
  } catch {
    invoiceRet = null
  }

  const customerRef = invoiceRet?.CustomerRef ?? {}
  const lineRows = asArray(invoiceRet?.InvoiceLineRet)
  const lines = lineRows.map((line, index) =>
    normalizeXmlLine(sourceOrderId, line, index)
  )
  const subtotal = toNumber(row.SUBTOTAL ?? invoiceRet?.Subtotal)
  const taxTotal = toNumber(row.SALESTAXTOT ?? invoiceRet?.SalesTaxTotal)

  return {
    source: "quickbooks_desktop",
    sourceOrderId,
    qbdTxnId: toText(row.TXNID),
    refNumber: toText(row.REFNMBR ?? invoiceRet?.RefNumber),
    qbdCustomerListId: toText(row.CUSTLID ?? customerRef.ListID),
    customerName: toText(row.CUSTNAME ?? customerRef.FullName),
    placedAt: isoDate(row.TXNDATE ?? invoiceRet?.TxnDate),
    shipDate: isoDate(row.SHIPDATE ?? invoiceRet?.ShipDate),
    status: "imported",
    subtotal,
    taxTotal,
    total: subtotal + taxTotal,
    sourceUpdatedAt: isoDate(row.TIMEMODIFIED),
    snapshot: {
      legacyInvoiceRowId: row.ID,
      refNumber: toText(row.REFNMBR),
      customerId: toText(row.CUSTLID),
      transactionDate: toText(row.TXNDATE),
      lineCount: lines.length,
      subtotal,
      taxTotal,
    },
    lines,
  }
}

async function fetchLegacyMysqlInvoices({
  startDate,
  endDate,
  maxRecords,
  offset,
  envFile,
}: {
  startDate: string
  endDate: string
  maxRecords: number
  offset: number
  envFile?: string
}) {
  loadFirstExistingEnvFile([
    envFile,
    process.env.LEGACY_ENV_FILE,
    process.env.ENV_FILE,
    ".env.legacy",
    "../grillerspride/.env.legacy",
  ])

  const connection = await mysql.createConnection({
    host: requiredEnv("LEGACY_DB_HOST"),
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    database: requiredEnv("LEGACY_DB_NAME"),
    user: requiredEnv("LEGACY_DB_USER"),
    password: requiredEnv("LEGACY_DB_PASSWORD"),
    connectTimeout: 20000,
    ssl: process.env.LEGACY_DB_SSL === "1" ? {} : undefined,
  })

  const limitClause = maxRecords > 0 ? ` LIMIT ${maxRecords} OFFSET ${offset}` : ""
  const parser = new XMLParser({ ignoreAttributes: false })

  try {
    const [rows] = await connection.query(
      `
        SELECT ID, TIMEMODIFIED, TXNID, CUSTLID, CUSTNAME, TXNDATE, REFNMBR,
               SHIPDATE, SUBTOTAL, SALESTAXTOT, INVOICEXML
        FROM INVOICES
        WHERE TXNDATE BETWEEN ? AND ?
        ORDER BY TXNDATE ASC, ID ASC
        ${limitClause}
      `,
      [startDate, endDate]
    )

    return (rows as any[])
      .map((row) => normalizeLegacyMysqlInvoice(row, parser))
      .filter((invoice): invoice is NormalizedInvoice => !!invoice)
  } finally {
    await connection.end()
  }
}

export default async function importQbdOrderHistory({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const args = parseArgs()
  const apply = getBooleanArg(args, ["apply"], false)
  const source = getStringArg(args, ["source"], "conductor")
  const startDate = getStringArg(args, ["start-date"], "2016-01-01")!
  const endDate = getStringArg(args, ["end-date"], dateOnly(new Date()))!
  const maxRecords = getNumberArg(args, ["max-records", "limit"], apply ? 0 : 200)
  const offset = getNumberArg(args, ["offset"], 0)
  const pageLimit = Math.min(getNumberArg(args, ["page-limit"], 150), 150)
  const maxPages = getNumberArg(args, ["max-pages-per-request"], 1000)

  const variantIndexes = await loadVariantIndexes(db)
  const existingItemMap = await loadExistingItemMap(db)
  const rawInvoices =
    source === "legacy-mysql"
      ? await fetchLegacyMysqlInvoices({
          startDate,
          endDate,
          maxRecords,
          offset,
          envFile: getStringArg(args, ["env-file", "legacy-env-file"]),
        })
      : (await fetchConductorInvoices({
          startDate,
          endDate,
          maxRecords,
          pageLimit,
          maxPages,
        }))
          .map(normalizeConductorInvoice)
          .filter((invoice): invoice is NormalizedInvoice => !!invoice)

  const stats = {
    source,
    seen: rawInvoices.length,
    imported: 0,
    failed: 0,
    lines: 0,
    productLines: 0,
    nonProductLines: 0,
    mappedLines: 0,
    uniqueUnmappedProductItems: 0,
    topUnmappedProductItems: [] as Array<{
      sku: string | null
      title: string | null
      qbdItemListId: string | null
      count: number
    }>,
  }
  const unmappedProducts = new Map<
    string,
    {
      sku: string | null
      title: string | null
      qbdItemListId: string | null
      count: number
    }
  >()

  for (const invoice of rawInvoices) {
    try {
      const result = await upsertInvoiceProjection({
        db,
        invoice,
        variantIndexes,
        existingItemMap,
        apply,
      })
      stats.imported += 1
      stats.lines += result.lines
      stats.productLines += result.productLines
      stats.nonProductLines += result.nonProductLines
      stats.mappedLines += result.mappedLines
      for (const item of result.unmappedProductItems) {
        const existing = unmappedProducts.get(item.key)
        if (existing) {
          existing.count += 1
        } else {
          unmappedProducts.set(item.key, {
            sku: item.sku,
            title: item.title,
            qbdItemListId: item.qbdItemListId,
            count: 1,
          })
        }
      }
    } catch (error) {
      stats.failed += 1
      logger.error(
        `[qbd-order-history] failed source_order_id=${invoice.sourceOrderId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  stats.uniqueUnmappedProductItems = unmappedProducts.size
  stats.topUnmappedProductItems = Array.from(unmappedProducts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  logger.info(
    `[qbd-order-history] ${apply ? "applied" : "dry-run"} ${JSON.stringify(stats)}`
  )
}
