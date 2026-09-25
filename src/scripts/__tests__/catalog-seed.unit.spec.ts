import {
  assertSafeTarget, CATALOG_TABLES, importCatalogRows, isExcludedTable, orderedRows, sanitizeCatalogRow, serializeCatalogValue,
  type CatalogSnapshot,
} from "../catalog-seed"

const excluded = ["customer", "order", "cart", "payment_session", "user", "invite", "api_key", "notification", "gp_communications_profile"]

function fixture() {
  const names = [...CATALOG_TABLES, ...excluded, "notification_provider"]
  const tables = Object.fromEntries(names.map(name => [name, [] as Record<string, any>[]])) as Record<string, Record<string, any>[]>
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
    if (sql.startsWith("SELECT column_name, udt_name FROM information_schema.columns")) return { rows: snapshot.tables[params[0]].columns.map(c => ({ column_name: c.name, udt_name: c.type })) }
    const table = sql.match(/public\."([a-z_]+)"/)?.[1]
    if (!table) throw new Error(`Unexpected SQL: ${sql}`)
    if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: tables[table].length }] }
    if (sql.startsWith("SELECT id FROM")) return { rows: [...tables[table]].sort((a, b) => a.id.localeCompare(b.id)) }
    if (sql.startsWith("SELECT ")) return { rows: [...tables[table]] }
    if (sql.startsWith("DELETE FROM")) { writes.push(table); tables[table] = []; return { rows: [] } }
    if (sql.startsWith("INSERT INTO")) {
      writes.push(table)
      const columns = snapshot.tables[table].columns
      for (let i = 0; i < params.length; i += columns.length) {
        tables[table].push(Object.fromEntries(columns.map((column, j) => [column.name,
          ["json", "jsonb"].includes(column.type) && params[i + j] !== null ? JSON.parse(params[i + j]) : params[i + j]])))
      }
      return { rows: [] }
    }
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
    expect(() => assertSafeTarget(production, "postgresql://writer@rehearsal.example:6433/railway?host=production.example")).toThrow("query parameters")
    expect(() => assertSafeTarget(`${production}?sslmode=disable`, "postgresql://writer@rehearsal.example:6433/railway")).toThrow("query parameters")
  })

  it("preserves JSON string and array types and verifies seeded row content", async () => {
    const { snapshot, db, tables } = fixture()
    snapshot.tables.shipping_option_rule = { columns: [{ name: "id", type: "text" }, { name: "value", type: "jsonb" }],
      rows: [{ id: "sor_1", value: "true" }] }
    snapshot.tables.price_list_rule = { columns: [{ name: "id", type: "text" }, { name: "value", type: "jsonb" }],
      rows: [{ id: "plr_1", value: ["store", "web"] }] }
    snapshot.export_counts.shipping_option_rule = 1
    snapshot.export_counts.price_list_rule = 1
    const receipt = await importCatalogRows(db, snapshot)
    expect(tables.shipping_option_rule[0].value).toBe("true")
    expect(tables.price_list_rule[0].value).toEqual(["store", "web"])
    expect(receipt.verified_row_hashes.shipping_option_rule).toMatch(/^[a-f0-9]{64}$/)
    expect(serializeCatalogValue("json", "true")).toBe('"true"')
  })

  it("orders category parents before children and rejects catalog credentials outside metadata", () => {
    expect(orderedRows("product_category", [
      { id: "child", parent_category_id: "parent" }, { id: "parent", parent_category_id: null },
    ]).map(row => row.id)).toEqual(["parent", "child"])
    expect(() => sanitizeCatalogRow("shipping_option_rule", { value: { apiKey: "fixture" } })).toThrow("credential field")
    expect(() => sanitizeCatalogRow("product", { metadata: { note: "sk_live_examplefixture" } })).toThrow("credential value")
  })

  it("removes live reservations from inventory rows while keeping stock", () => {
    expect(sanitizeCatalogRow("inventory_level", { stocked_quantity: 25, reserved_quantity: 3,
      raw_reserved_quantity: { value: "3", precision: 20 } })).toMatchObject({ stocked_quantity: 25,
      reserved_quantity: "0", raw_reserved_quantity: { value: "0", precision: 20 } })
    expect(isExcludedTable("notification_provider")).toBe(false)
    expect(isExcludedTable("script_migrations")).toBe(false)
    expect(isExcludedTable("notification")).toBe(true)
    expect(isExcludedTable("gp_campaign")).toBe(true)
  })
})
