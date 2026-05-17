import path from "path"
import { readFile } from "fs/promises"
import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  generateEntityId,
} from "@medusajs/framework/utils"
import {
  getBooleanArg,
  getStringArg,
  parseArgs,
  toNumber,
  toText,
} from "./lib/legacy-import-utils"

type CsvRow = Record<string, string>

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim())
      current = ""
      continue
    }

    current += char
  }

  cells.push(current.trim())
  return cells
}

function parseCsv(content: string): CsvRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))

  if (!lines.length) {
    return []
  }

  const headers = parseCsvLine(lines[0]).map((header) =>
    header.trim().toLowerCase()
  )

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line)
    return headers.reduce<CsvRow>((row, header, index) => {
      row[header] = cells[index]?.trim() ?? ""
      return row
    }, {})
  })
}

function rowValue(row: CsvRow, keys: string[]) {
  for (const key of keys) {
    const value = toText(row[key])
    if (value) {
      return value
    }
  }
  return null
}

async function findVariant(db: any, input: { variantId: string | null; sku: string | null }) {
  const query = db("product_variant as pv")
    .leftJoin("product as p", "p.id", "pv.product_id")
    .select([
      "pv.id as variant_id",
      "pv.sku as sku",
      "pv.title as variant_title",
      "pv.product_id as product_id",
      "p.title as product_title",
    ])
    .whereNull("pv.deleted_at")
    .where((builder: any) => {
      builder.whereNull("p.deleted_at").orWhereNull("p.id")
    })

  if (input.variantId) {
    return query.clone().where("pv.id", input.variantId).first()
  }

  if (input.sku) {
    return query
      .clone()
      .whereRaw("lower(pv.sku) = lower(?)", [input.sku])
      .first()
  }

  return null
}

async function upsertItemMap({
  db,
  row,
  variant,
  apply,
  sourceFile,
}: {
  db: any
  row: CsvRow
  variant: any
  apply: boolean
  sourceFile: string
}) {
  const qbdItemListId = rowValue(row, [
    "qbd_item_list_id",
    "qbditemlistid",
    "quickbooks_item_id",
    "quickbooksitemid",
  ])
  const qbdName = rowValue(row, ["qbd_name", "quickbooks_name", "name"])
  const sku = rowValue(row, ["sku", "qbd_sku", "legacy_sku"]) || variant.sku
  const confidence = toNumber(rowValue(row, ["confidence"])) || 1
  const mappingSource =
    rowValue(row, ["mapping_source", "source"]) || "manual_csv"
  const now = new Date()

  if (!qbdItemListId && !sku) {
    throw new Error("row requires qbd_item_list_id or sku")
  }

  if (!apply) {
    return {
      qbdItemListId,
      sku,
      lineRowsBackfilled: 0,
      itemMapUpserted: Boolean(qbdItemListId),
    }
  }

  if (qbdItemListId) {
    const existing = await db("legacy_item_map")
      .select("id")
      .where("qbd_item_list_id", qbdItemListId)
      .whereNull("deleted_at")
      .first()

    const mapRow = {
      qbd_name: qbdName,
      sku,
      medusa_product_id: variant.product_id,
      medusa_variant_id: variant.variant_id,
      medusa_product_title: variant.product_title,
      medusa_variant_title: variant.variant_title,
      confidence,
      mapping_source: mappingSource,
      last_seen_at: now,
      metadata: {
        imported_from: path.basename(sourceFile),
        imported_by: "import-legacy-item-maps",
      },
      updated_at: now,
    }

    if (existing) {
      await db("legacy_item_map").where({ id: existing.id }).update(mapRow)
    } else {
      await db("legacy_item_map").insert({
        id: generateEntityId(undefined, "lgimap"),
        qbd_item_list_id: qbdItemListId,
        ...mapRow,
        created_at: now,
      })
    }
  }

  const lineQuery = db("legacy_order_line").whereNull("deleted_at")
  lineQuery.andWhere((builder: any) => {
    if (qbdItemListId) {
      builder.orWhere("qbd_item_list_id", qbdItemListId)
    }
    if (sku) {
      builder.orWhereRaw("lower(sku) = lower(?)", [sku])
    }
  })

  const lineRowsBackfilled = await lineQuery.update({
    medusa_product_id: variant.product_id,
    medusa_variant_id: variant.variant_id,
    medusa_product_title: variant.product_title,
    medusa_variant_title: variant.variant_title,
    mapping_status: "mapped",
    metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
      JSON.stringify({
        line_kind: "product",
        mapping_confidence: confidence,
        mapping_source: mappingSource,
        mapping_imported_from: path.basename(sourceFile),
      }),
    ]),
    updated_at: now,
  })

  return {
    qbdItemListId,
    sku,
    lineRowsBackfilled: Number(lineRowsBackfilled) || 0,
    itemMapUpserted: Boolean(qbdItemListId),
  }
}

export default async function importLegacyItemMaps({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const args = parseArgs()
  const apply = getBooleanArg(args, ["apply"], false)
  const file = getStringArg(args, ["file", "csv"])

  if (!file) {
    throw new Error("Missing --file path to legacy item mapping CSV")
  }

  const sourceFile = path.resolve(process.cwd(), file)
  const rows = parseCsv(await readFile(sourceFile, "utf8"))
  const stats = {
    seen: rows.length,
    valid: 0,
    failed: 0,
    itemMapsUpserted: 0,
    lineRowsBackfilled: 0,
  }

  for (const row of rows) {
    try {
      const medusaVariantId = rowValue(row, [
        "medusa_variant_id",
        "variant_id",
      ])
      const medusaSku = rowValue(row, [
        "medusa_sku",
        "variant_sku",
        "target_sku",
      ])
      const variant = await findVariant(db, {
        variantId: medusaVariantId,
        sku: medusaSku,
      })

      if (!variant) {
        throw new Error(
          `variant not found for ${medusaVariantId || medusaSku || "blank target"}`
        )
      }

      const result = await upsertItemMap({
        db,
        row,
        variant,
        apply,
        sourceFile,
      })
      stats.valid += 1
      stats.itemMapsUpserted += result.itemMapUpserted ? 1 : 0
      stats.lineRowsBackfilled += result.lineRowsBackfilled
    } catch (error) {
      stats.failed += 1
      logger.error(
        `[legacy-item-maps] failed row: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  logger.info(
    `[legacy-item-maps] ${apply ? "applied" : "dry-run"} ${JSON.stringify(stats)}`
  )
}
