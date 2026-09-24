import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Client } from "pg"

// Deliberately finite: adding a table requires review of its data class and
// references. These are catalog and checkout settings, never operational state.
export const CATALOG_TABLES = [
  "currency", "sales_channel", "stock_location_address", "stock_location",
  "fulfillment_provider", "fulfillment_set", "service_zone", "geo_zone",
  "location_fulfillment_provider", "location_fulfillment_set",
  "shipping_profile", "shipping_option_type", "payment_provider",
  "region", "region_country", "region_payment_provider",
  "tax_provider", "tax_region", "tax_rate", "tax_rate_rule",
  "store", "store_currency", "sales_channel_stock_location",
  "product_collection", "product_type", "product_tag", "product_category",
  "product", "image", "product_option", "product_option_value",
  "product_variant", "product_variant_option", "product_sales_channel",
  "product_shipping_profile", "product_category_product", "product_tags",
  "inventory_item", "product_variant_inventory_item", "inventory_level",
  "price_list", "price_list_rule", "price_preference", "price_set", "price",
  "price_rule", "product_variant_price_set", "shipping_option",
  "shipping_option_price_set", "shipping_option_rule",
] as const

type Column = { name: string; type: string }
type Table = { columns: Column[]; rows: Record<string, any>[] }
export type CatalogSnapshot = {
  version: 1
  sales_channel_id: string
  tables: Record<string, Table>
  export_counts: Record<string, number>
  excluded_counts: Record<string, 0>
}
type Queryable = Pick<Client, "query">

const textIds = (rows: Record<string, any>[], key = "id") => rows.map(row => String(row[key])).filter(Boolean)
const unique = (items: string[]) => [...new Set(items)]
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

export function isExcludedTable(name: string): boolean {
  if ((CATALOG_TABLES as readonly string[]).includes(name)) return false
  // Migrations and provider registration can contain bootstrap rows. Every
  // other table, including newly added operational tables, must stay empty.
  return !["mikro_orm_migrations", "link_module_migrations", "script_migrations", "notification_provider"].includes(name)
}

export function assertSafeTarget(sourceUrl: string, targetUrl: string, sourceIdentity?: string, targetIdentity?: string) {
  const source = new URL(sourceUrl), target = new URL(targetUrl)
  if (!/^postgres(?:ql)?:$/.test(source.protocol) || !/^postgres(?:ql)?:$/.test(target.protocol)) throw new Error("Both database URLs must be PostgreSQL URLs.")
  if (!source.hostname || !target.hostname || !source.port || !target.port) throw new Error("Both database URLs require explicit hosts and ports.")
  if (source.host.toLowerCase() === target.host.toLowerCase()) throw new Error("The target endpoint is the production database endpoint.")
  if (sourceIdentity && targetIdentity && sourceIdentity === targetIdentity) throw new Error("The target resolves to the production database, despite its different URL.")
}

async function databaseIdentity(db: Queryable): Promise<string> {
  const { rows } = await db.query("SELECT inet_server_addr()::text AS host, inet_server_port() AS port, current_database() AS database")
  return JSON.stringify(rows[0])
}

async function tableNames(db: Queryable): Promise<string[]> {
  const { rows } = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
  return rows.map(row => row.table_name)
}

async function columns(db: Queryable, table: string): Promise<Column[]> {
  const { rows } = await db.query("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' AND is_identity='NO' ORDER BY ordinal_position", [table])
  return rows.map(row => ({ name: row.column_name, type: row.udt_name }))
}

async function ids(db: Queryable, sql: string, params: any[] = []): Promise<string[]> {
  return unique(textIds((await db.query(sql, params)).rows))
}

function assertNoSecretMetadata(value: unknown, path = "metadata") {
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:secret|password|private.?key|access.?token|api.?key|credential)/i.test(key)) throw new Error(`Potential credential field in catalog ${path}.${key}; export stopped.`)
    assertNoSecretMetadata(nested, `${path}.${key}`)
  }
}

export function sanitizeCatalogRow(table: string, original: Record<string, any>): Record<string, any> {
  const row = { ...original }
  if (row.metadata) assertNoSecretMetadata(row.metadata)
  if (table === "inventory_level") {
    // Live reservations belong to production orders and cannot enter rehearsal.
    row.reserved_quantity = 0
    row.raw_reserved_quantity = { ...(row.raw_reserved_quantity || { precision: 20 }), value: "0" }
  }
  return row
}

async function selectChannel(db: Queryable, requested?: string): Promise<string> {
  const channels = await ids(db, "SELECT id FROM sales_channel WHERE deleted_at IS NULL")
  const defaults = await ids(db, "SELECT DISTINCT default_sales_channel_id AS id FROM store WHERE deleted_at IS NULL AND default_sales_channel_id IS NOT NULL")
  const selected = requested || (defaults.length === 1 ? defaults[0] : channels.length === 1 ? channels[0] : "")
  if (!selected || !channels.includes(selected)) throw new Error("The storefront sales channel must be selected explicitly.")
  return selected
}

export async function buildCatalogSnapshot(db: Queryable, requestedChannel?: string): Promise<CatalogSnapshot> {
  const names = await tableNames(db)
  for (const table of CATALOG_TABLES) if (!names.includes(table)) throw new Error(`Source catalog table is missing: ${table}`)
  const salesChannelId = await selectChannel(db, requestedChannel)
  const productIds = await ids(db, `SELECT DISTINCT p.id FROM product p JOIN product_sales_channel psc ON psc.product_id=p.id
    WHERE psc.sales_channel_id=$1 AND psc.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status='published'`, [salesChannelId])
  if (!productIds.length) throw new Error("No published storefront products were found; refusing a partial export.")
  const variantIds = await ids(db, "SELECT id FROM product_variant WHERE product_id=ANY($1::text[]) AND deleted_at IS NULL", [productIds])
  const optionIds = await ids(db, "SELECT id FROM product_option WHERE product_id=ANY($1::text[])", [productIds])
  const inventoryItemIds = await ids(db, "SELECT inventory_item_id AS id FROM product_variant_inventory_item WHERE variant_id=ANY($1::text[]) AND deleted_at IS NULL", [variantIds])
  const variantPriceSetIds = await ids(db, "SELECT price_set_id AS id FROM product_variant_price_set WHERE variant_id=ANY($1::text[]) AND deleted_at IS NULL", [variantIds])
  const shippingPriceSetIds = await ids(db, "SELECT price_set_id AS id FROM shipping_option_price_set WHERE deleted_at IS NULL")
  const priceSetIds = unique([...variantPriceSetIds, ...shippingPriceSetIds])
  const priceRows = (await db.query("SELECT id, price_list_id FROM price WHERE price_set_id=ANY($1::text[]) AND deleted_at IS NULL", [priceSetIds])).rows
  const priceIds = textIds(priceRows)
  const priceListIds = unique(priceRows.map(row => row.price_list_id).filter(Boolean))

  const filters: Record<string, { where: string; params: any[] }> = {
    product: { where: "id=ANY($1::text[])", params: [productIds] },
    image: { where: "product_id=ANY($1::text[])", params: [productIds] },
    product_option: { where: "product_id=ANY($1::text[])", params: [productIds] },
    product_option_value: { where: "option_id=ANY($1::text[])", params: [optionIds] },
    product_variant: { where: "id=ANY($1::text[])", params: [variantIds] },
    product_variant_option: { where: "variant_id=ANY($1::text[])", params: [variantIds] },
    product_sales_channel: { where: "product_id=ANY($1::text[]) AND sales_channel_id=$2 AND deleted_at IS NULL", params: [productIds, salesChannelId] },
    product_shipping_profile: { where: "product_id=ANY($1::text[])", params: [productIds] },
    product_category_product: { where: "product_id=ANY($1::text[])", params: [productIds] },
    product_tags: { where: "product_id=ANY($1::text[])", params: [productIds] },
    inventory_item: { where: "id=ANY($1::text[])", params: [inventoryItemIds] },
    product_variant_inventory_item: { where: "variant_id=ANY($1::text[])", params: [variantIds] },
    inventory_level: { where: "inventory_item_id=ANY($1::text[])", params: [inventoryItemIds] },
    price_list: { where: "id=ANY($1::text[])", params: [priceListIds] },
    price_list_rule: { where: "price_list_id=ANY($1::text[])", params: [priceListIds] },
    price_set: { where: "id=ANY($1::text[])", params: [priceSetIds] },
    price: { where: "id=ANY($1::text[])", params: [priceIds] },
    price_rule: { where: "price_id=ANY($1::text[])", params: [priceIds] },
    product_variant_price_set: { where: "variant_id=ANY($1::text[])", params: [variantIds] },
  }

  const tables: Record<string, Table> = {}
  for (const table of CATALOG_TABLES) {
    const tableColumns = await columns(db, table)
    if (!tableColumns.length) throw new Error(`No readable columns on ${table}`)
    const filter = filters[table]
    const sql = `SELECT ${tableColumns.map(c => quoted(c.name)).join(", ")} FROM public.${quoted(table)}` + (filter ? ` WHERE ${filter.where}` : "") + " ORDER BY 1"
    const rows = (await db.query(sql, filter?.params || [])).rows.map(row => sanitizeCatalogRow(table, row))
    tables[table] = { columns: tableColumns, rows }
  }
  const exportCounts = Object.fromEntries(CATALOG_TABLES.map(table => [table, tables[table].rows.length]))
  const excludedCounts = Object.fromEntries(names.filter(isExcludedTable).map(table => [table, 0])) as Record<string, 0>
  return { version: 1, sales_channel_id: salesChannelId, tables, export_counts: exportCounts, excluded_counts: excludedCounts }
}

function snapshotIsValid(value: any): asserts value is CatalogSnapshot {
  if (value?.version !== 1 || !value.sales_channel_id || !value.tables || !value.export_counts || !value.excluded_counts) throw new Error("Invalid catalog snapshot version or manifest.")
  if (JSON.stringify(Object.keys(value.tables)) !== JSON.stringify([...CATALOG_TABLES])) throw new Error("Catalog snapshot has missing, reordered, or extra tables.")
  for (const table of CATALOG_TABLES) {
    const entry = value.tables[table]
    if (!Array.isArray(entry?.columns) || !Array.isArray(entry?.rows) || value.export_counts[table] !== entry.rows.length) throw new Error(`Invalid count or shape for ${table}.`)
    for (const row of entry.rows) {
      if (!row || typeof row !== "object" || Object.keys(row).some(name => !entry.columns.some((c: Column) => c.name === name))) throw new Error(`Unexpected column in ${table}.`)
      if (row.metadata) assertNoSecretMetadata(row.metadata)
    }
  }
  if (Object.values(value.excluded_counts).some(count => count !== 0)) throw new Error("Excluded table count in the snapshot is nonzero.")
}

export async function excludedTableCounts(db: Queryable, expected: string[]): Promise<Record<string, number>> {
  const names = await tableNames(db)
  for (const name of expected) if (!names.includes(name)) throw new Error(`Rehearsal schema lacks excluded table ${name}.`)
  const excluded = unique([...expected, ...names.filter(isExcludedTable)]).sort()
  const result: Record<string, number> = {}
  for (const table of excluded) result[table] = Number((await db.query(`SELECT count(*)::int AS count FROM public.${quoted(table)}`)).rows[0].count)
  return result
}

export function assertExcludedEmpty(counts: Record<string, number>) {
  const occupied = Object.entries(counts).filter(([, count]) => count !== 0)
  if (occupied.length) throw new Error(`Excluded rehearsal tables are not empty: ${occupied.map(([table]) => table).join(", ")}.`)
}

function orderedRows(table: string, rows: Record<string, any>[]) {
  if (table !== "product_category" && table !== "tax_region") return rows
  const pending = [...rows], ordered: Record<string, any>[] = [], seen = new Set<string>()
  while (pending.length) {
    const index = pending.findIndex(row => !row.parent_id || seen.has(String(row.parent_id)))
    if (index < 0) throw new Error(`Circular or missing parent in ${table}.`)
    const [row] = pending.splice(index, 1)
    ordered.push(row)
    seen.add(String(row.id))
  }
  return ordered
}

async function insertRows(db: Queryable, table: string, entry: Table) {
  const rows = orderedRows(table, entry.rows)
  const names = entry.columns.map(column => column.name)
  for (let offset = 0; offset < rows.length; offset += 40) {
    const batch = rows.slice(offset, offset + 40)
    const values = batch.flatMap(row => names.map(name => row[name] ?? null))
    const tuples = batch.map((_, rowIndex) => `(${names.map((_, colIndex) => `$${rowIndex * names.length + colIndex + 1}`).join(",")})`)
    await db.query(`INSERT INTO public.${quoted(table)} (${names.map(quoted).join(",")}) VALUES ${tuples.join(",")}`, values)
  }
}

async function tableIdHash(db: Queryable, table: string): Promise<string> {
  const rows = (await db.query(`SELECT id FROM public.${quoted(table)} ORDER BY id`)).rows
  return sha256(rows.map(row => String(row.id)).join("\n"))
}

export async function importCatalogRows(target: Queryable, snapshot: CatalogSnapshot) {
  snapshotIsValid(snapshot)
  const targetNames = await tableNames(target)
  for (const table of CATALOG_TABLES) if (!targetNames.includes(table)) throw new Error(`Rehearsal catalog table is missing: ${table}`)
  const beforeExcluded = await excludedTableCounts(target, Object.keys(snapshot.excluded_counts))
  assertExcludedEmpty(beforeExcluded)
  for (const table of ["product", "product_variant", "price", "inventory_level"]) {
    const count = Number((await target.query(`SELECT count(*)::int AS count FROM public.${quoted(table)}`)).rows[0].count)
    if (count !== 0) throw new Error(`Rehearsal ${table} is not empty; refusing a repeat or overwrite.`)
  }
  for (const table of CATALOG_TABLES) {
    const targetColumns = await columns(target, table)
    if (JSON.stringify(targetColumns) !== JSON.stringify(snapshot.tables[table].columns)) throw new Error(`Rehearsal schema differs for ${table}.`)
  }
  // The finite reverse order clears only bootstrapped catalog/settings rows.
  // No CASCADE, excluded-table DELETE, or cross-database mutation is allowed.
  for (const table of [...CATALOG_TABLES].reverse()) await target.query(`DELETE FROM public.${quoted(table)}`)
  for (const table of CATALOG_TABLES) await insertRows(target, table, snapshot.tables[table])
  const seededCounts: Record<string, number> = {}
  for (const table of CATALOG_TABLES) {
    seededCounts[table] = Number((await target.query(`SELECT count(*)::int AS count FROM public.${quoted(table)}`)).rows[0].count)
    if (seededCounts[table] !== snapshot.export_counts[table]) throw new Error(`Seeded row count differs for ${table}.`)
  }
  for (const table of ["product", "product_variant", "price"]) {
    const expected = sha256(snapshot.tables[table].rows.map(row => String(row.id)).sort().join("\n"))
    if (await tableIdHash(target, table) !== expected) throw new Error(`Original ${table} IDs were not preserved.`)
  }
  const afterExcluded = await excludedTableCounts(target, Object.keys(snapshot.excluded_counts))
  assertExcludedEmpty(afterExcluded)
  return { seeded_counts: seededCounts, excluded_counts: afterExcluded }
}

function databaseClient(url: string) {
  const parsed = new URL(url)
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
  const ca = process.env.GP_CATALOG_DB_CA_PEM
  if (!local && !ca && process.env.GP_CATALOG_ALLOW_RAILWAY_SELF_SIGNED_SSL !== "yes") {
    throw new Error("Remote database TLS needs GP_CATALOG_DB_CA_PEM or an explicit Railway self-signed TLS opt-in.")
  }
  return new Client({ connectionString: url, ssl: local ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } })
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

export async function runCatalogSeedCli(command = process.argv[2]) {
  if (command !== "catalog-export" && command !== "catalog-import") throw new Error("Use catalog-export or catalog-import.")
  const sourceUrl = required("GP_CATALOG_SOURCE_DATABASE_URL")
  const file = required("GP_CATALOG_EXPORT_FILE")
  if (command === "catalog-export") {
    if (existsSync(file) || existsSync(`${file}.manifest.json`)) throw new Error("The export or manifest path already exists.")
    const source = databaseClient(sourceUrl)
    try {
      await source.connect()
      await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      const readonly = await source.query("SHOW transaction_read_only")
      if (readonly.rows[0]?.transaction_read_only !== "on") throw new Error("Source transaction is not read-only.")
      const snapshot = await buildCatalogSnapshot(source, process.env.GP_CATALOG_SOURCE_SALES_CHANNEL_ID)
      snapshotIsValid(snapshot)
      await source.query("ROLLBACK")
      const payload = JSON.stringify(snapshot)
      const hash = sha256(payload)
      writeFileSync(file, payload, { flag: "wx", mode: 0o600 })
      writeFileSync(`${file}.manifest.json`, JSON.stringify({ sha256: hash, sales_channel_id: snapshot.sales_channel_id,
        export_counts: snapshot.export_counts, excluded_counts: snapshot.excluded_counts }, null, 2), { flag: "wx", mode: 0o600 })
      console.log(JSON.stringify({ sha256: hash, export_counts: snapshot.export_counts, excluded_counts: snapshot.excluded_counts }))
    } finally {
      await source.query("ROLLBACK").catch(() => {})
      await source.end().catch(() => {})
    }
    return
  }

  const targetUrl = required("GP_CATALOG_TARGET_DATABASE_URL")
  if (required("GP_CATALOG_TARGET_ENVIRONMENT_ID") !== "6484cbf0-661c-4bfb-a4ca-6bfef1e090cd") throw new Error("The target is not the approved gp-launch-r1 environment.")
  assertSafeTarget(sourceUrl, targetUrl)
  const payload = readFileSync(file)
  const hash = sha256(payload)
  if (hash !== required("GP_CATALOG_EXPECTED_SHA256")) throw new Error("The protected export hash does not match the approved manifest.")
  const snapshot = JSON.parse(payload.toString())
  snapshotIsValid(snapshot)
  if (existsSync(`${file}.seed-receipt.json`)) throw new Error("A seed receipt already exists; refusing repeat import.")
  const source = databaseClient(sourceUrl), target = databaseClient(targetUrl)
  try {
    await source.connect()
    await source.query("BEGIN READ ONLY")
    const sourceIdentity = await databaseIdentity(source)
    await target.connect()
    assertSafeTarget(sourceUrl, targetUrl, sourceIdentity, await databaseIdentity(target))
    await source.query("ROLLBACK")
    await target.query("BEGIN")
    await target.query("SET LOCAL lock_timeout = '10s'")
    const result = await importCatalogRows(target, snapshot)
    await target.query("COMMIT")
    const receipt = { sha256: hash, ...result }
    writeFileSync(`${file}.seed-receipt.json`, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 })
    console.log(JSON.stringify(receipt))
  } catch (error) {
    await target.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    await source.query("ROLLBACK").catch(() => {})
    await source.end().catch(() => {})
    await target.end().catch(() => {})
  }
}
