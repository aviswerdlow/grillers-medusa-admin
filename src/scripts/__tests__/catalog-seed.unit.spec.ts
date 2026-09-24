import {
  assertSafeTarget, CATALOG_TABLES, importCatalogRows, isExcludedTable, sanitizeCatalogRow,
  type CatalogSnapshot,
} from "../catalog-seed"

const excluded = ["customer", "order", "cart", "payment_session", "user", "invite", "api_key", "notification", "gp_communications_profile"]

function fixture() {
  const names = [...CATALOG_TABLES, ...excluded, "notification_provider"]
  const tables = Object.fromEntries(names.map(name => [name, [] as { id: string }[]])) as Record<string, { id: string }[]>
  tables.store = [{ id: "bootstrap_store" }]
  tables.notification_provider = [{ id: "rehearsal_provider" }]
  const snapshot: CatalogSnapshot = {
    version: 1,
    sales_channel_id: "sc_storefront",
    tables: Object.fromEntries(CATALOG_TABLES.map(name => [name, {
      columns: [{ name: "id", type: "text" }],
      rows: ["product", "product_variant", "price"].includes(name) ? [{ id: `${name}_original` }] : [],
    }])),
    export_counts: Object.fromEntries(CATALOG_TABLES.map(name => [name, ["product", "product_variant", "price"].includes(name) ? 1 : 0])),
    excluded_counts: Object.fromEntries(excluded.map(name => [name, 0])) as Record<string, 0>,
  }
  const writes: string[] = []
  const db: any = { async query(sql: string, params: any[] = []) {
    if (sql.startsWith("SELECT table_name FROM information_schema.tables")) return { rows: names.map(table_name => ({ table_name })) }
    if (sql.startsWith("SELECT column_name, udt_name FROM information_schema.columns")) return { rows: [{ column_name: "id", udt_name: "text" }] }
    const table = sql.match(/public\."([a-z_]+)"/)?.[1]
    if (!table) throw new Error(`Unexpected SQL: ${sql}`)
    if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: tables[table].length }] }
    if (sql.startsWith("SELECT id FROM")) return { rows: [...tables[table]].sort((a, b) => a.id.localeCompare(b.id)) }
    if (sql.startsWith("DELETE FROM")) { writes.push(table); tables[table] = []; return { rows: [] } }
    if (sql.startsWith("INSERT INTO")) { writes.push(table); tables[table].push(...params.map(id => ({ id }))); return { rows: [] } }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
  return { snapshot, db, tables, writes }
}

describe("P09 catalog-only seed boundary", () => {
  it("imports original catalog IDs and leaves every excluded table empty", async () => {
    const { snapshot, db, tables, writes } = fixture()
    const receipt = await importCatalogRows(db, snapshot)
    expect(receipt.seeded_counts).toMatchObject({ product: 1, product_variant: 1, price: 1 })
    expect(Object.values(receipt.excluded_counts)).toEqual(excluded.map(() => 0))
    expect(tables.product).toEqual([{ id: "product_original" }])
    expect(tables.product_variant).toEqual([{ id: "product_variant_original" }])
    expect(tables.price).toEqual([{ id: "price_original" }])
    expect(tables.notification_provider).toEqual([{ id: "rehearsal_provider" }])
    expect(writes.some(name => excluded.includes(name) || name === "notification_provider")).toBe(false)
  })

  it("refuses a target with preexisting customer state before any write", async () => {
    const { snapshot, db, tables, writes } = fixture()
    tables.customer.push({ id: "existing_customer" })
    await expect(importCatalogRows(db, snapshot)).rejects.toThrow("customer")
    expect(writes).toEqual([])
  })

  it("refuses production as target by endpoint or resolved server identity", () => {
    const production = "postgresql://reader@production.example:6432/railway"
    expect(() => assertSafeTarget(production, "postgresql://writer@production.example:6432/other")).toThrow("production database endpoint")
    expect(() => assertSafeTarget(production, "postgresql://writer@alias.example:6433/railway", "server-1", "server-1")).toThrow("resolves to the production database")
  })

  it("removes live reservations from inventory rows while keeping stock", () => {
    expect(sanitizeCatalogRow("inventory_level", { stocked_quantity: 25, reserved_quantity: 3,
      raw_reserved_quantity: { value: "3", precision: 20 } })).toMatchObject({ stocked_quantity: 25,
      reserved_quantity: 0, raw_reserved_quantity: { value: "0", precision: 20 } })
    expect(isExcludedTable("notification_provider")).toBe(false)
    expect(isExcludedTable("script_migrations")).toBe(false)
    expect(isExcludedTable("notification")).toBe(true)
    expect(isExcludedTable("gp_campaign")).toBe(true)
  })
})
