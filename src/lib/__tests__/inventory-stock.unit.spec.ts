import { variantNativeStock, unmirroredInventoryDemand, unmirroredVariantUnits, nativeReservedUnitsForLine } from "../inventory-stock"
import { checkInventoryAvailability } from "../inventory-allocation"

const originalNativeFlag = process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED
beforeEach(() => { process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED = "true" })
afterAll(() => {
  if (originalNativeFlag === undefined) delete process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED
  else process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED = originalNativeFlag
})

function variant(id = "variant", stocked = 5, reserved = 0, required = 1): any {
  return { id, manage_inventory: true, allow_backorder: false, metadata: {}, product: { id: "product", metadata: {} },
    inventory_items: [{ inventory_item_id: "item", required_quantity: required,
      inventory: { id: "item", location_levels: [{ location_id: "location", stocked_quantity: stocked, reserved_quantity: reserved }] } }] }
}
const reservation = (quantity = 3, line = "line") => ({ line_item_id: line, inventory_item_id: "item", location_id: "location", quantity })
const commitment = (quantity = 3, line = "line", variant_id = "variant") => ({ id: "allocation", variant_id, line_item_id: line, quantity, status: "reserved" })
function dependencies(variants: any[], commitments: any[] = [], reservations: any[] = []) {
  const db: any = (name: string) => {
    const rows = name === "gp_inventory_allocation" ? commitments : name === "reservation_item" ? reservations : []
    let filtered = rows
    const chain: any = { select: () => chain, whereNull: () => chain,
      whereIn: (field: string, ids: string[]) => { filtered = filtered.filter(row => !row[field] || ids.includes(row[field])); return chain },
      then: (resolve: any) => resolve(filtered) }
    return chain
  }
  const query = { graph: jest.fn(async ({ entity, filters }: any) => ({ data: entity === "product_variant_inventory_items"
    ? variants.flatMap(v => (v.inventory_items || []).filter((item: any) => filters.inventory_item_id.includes(item.inventory_item_id))
      .map((item: any) => ({ variant_id: v.id, inventory_item_id: item.inventory_item_id })))
    : variants.filter(v => filters.id.includes(v.id)) })) }
  return { db, query }
}
const check = (deps: any, extras = {}) => checkInventoryAvailability({ ...deps, lines: [{ variant_id: "variant", quantity: 2 }],
  now: new Date("2026-09-19T12:00:00Z"), ...extras })

it.each([
  { manage_inventory: false }, { manage_inventory: undefined }, { allow_backorder: true }, { allow_backorder: undefined },
  { inventory_items: [] }, { inventory_items: [{ inventory_item_id: "item", required_quantity: 1 }] },
])("refuses an unverified baseline even with positive cache fields: %p", async override => {
  const v = { ...variant(), ...override, inventory_quantity: 999, metadata: { qbd_quantity_on_hand: 999, future_order_eligible: true } }
  const [line] = await check(dependencies([v]), { requested_fulfillment_date: "2026-10-19" })
  expect(line).toMatchObject({ decision: "blocked", reason: "inventory_baseline_required", current_stock_quantity: 0 })
})

it("uses all kit components and decimal unit conversions without rounding pounds to packs", () => {
  const v = variant("variant", 0.3, 0, 0.1)
  expect(variantNativeStock(v).quantity).toBe(3)
  const limited = variant("other", 1, 0, 0.5).inventory_items[0]
  limited.inventory_item_id = "other_item"
  v.inventory_items.push(limited)
  expect(variantNativeStock(v).quantity).toBe(2)
  v.inventory_items[1].required_quantity = 0
  expect(variantNativeStock(v).ready).toBe(false)
})

it("does not replace a missing component or malformed native level with the direct inventory_quantity", () => {
  const v = variant(); v.inventory_quantity = 100
  v.inventory_items[0].inventory.location_levels[0].stocked_quantity = null
  expect(variantNativeStock(v).ready).toBe(false)
})

it("subtracts a native reservation once when the same line is in the advisory ledger", async () => {
  const [line] = await check(dependencies([variant("variant", 5, 3)], [commitment()], [reservation()]))
  expect(line).toMatchObject({ decision: "available", current_stock_quantity: 2, allocated_quantity: 0, available_to_promise_quantity: 2 })
})

it("blocks an unmirrored commitment rather than treating a read-time deduction as an atomic reservation", async () => {
  const [line] = await check(dependencies([variant()], [commitment()], [reservation(3, "unrelated_line")]))
  expect(line).toMatchObject({ decision: "blocked", reason: "inventory_reconciliation_required", allocated_quantity: 3 })
})

it("accounts for partial native coverage, shared inventory and component units", () => {
  const stocks = new Map([["variant", variantNativeStock(variant())], ["two_pack", variantNativeStock(variant("two_pack", 10, 1, 2))]])
  const remaining = unmirroredInventoryDemand([commitment(2, "line", "two_pack")], stocks, [reservation(1)])
  expect(remaining.get("item")).toBe(3)
  expect(unmirroredVariantUnits(stocks.get("variant")!, remaining)).toBe(3)
  expect(unmirroredVariantUnits(stocks.get("two_pack")!, remaining)).toBe(2)
})

it("does not reuse native coverage for duplicate advisory rows or a different location", () => {
  const stocks = new Map([["variant", variantNativeStock(variant())]])
  expect(unmirroredInventoryDemand([commitment(), { ...commitment(), id: "duplicate" }], stocks, [reservation()]).get("item")).toBe(3)
  expect(unmirroredInventoryDemand([commitment()], stocks, [{ ...reservation(), location_id: "wrong" }]).get("item")).toBe(3)
})

it("recognizes an order's already reserved last unit without exposing that credit to another shopper", async () => {
  const deps = dependencies([variant("variant", 1, 1)], [], [reservation(1)])
  const [shopper] = await check(deps, { lines: [{ variant_id: "variant", quantity: 1 }] })
  const [placed] = await check(deps, { lines: [{ variant_id: "variant", quantity: 1, reservation_line_id: "line" }] })
  expect(shopper).toMatchObject({ decision: "blocked", available_to_promise_quantity: 0 })
  expect(placed).toMatchObject({ decision: "available", reason: "native_reservation", current_stock_quantity: 0 })
  expect(nativeReservedUnitsForLine(variantNativeStock(variant()), [reservation(1)], "different_line")).toBe(0)
})

it("preserves the existing future-dated ordering window", async () => {
  const [line] = await check(dependencies([variant("variant", 0)]), { requested_fulfillment_date: "2026-10-19" })
  expect(line).toMatchObject({ decision: "future_allowed", reason: "future_window" })
  expect(line.earliest_available_date).toBeUndefined()
})

it("keeps the future window ahead of current availability and restores earliest dates", async () => {
  const [future] = await check(dependencies([variant()]), { requested_fulfillment_date: "2026-10-19" })
  expect(future).toMatchObject({ decision: "future_allowed", reason: "future_window" })
  const [partial] = await check(dependencies([variant("variant", 1)]), {
    lines: [{ variant_id: "variant", quantity: 2 }], requested_fulfillment_date: "2026-09-20",
  })
  expect(partial).toMatchObject({ decision: "partial", earliest_available_date: "2026-10-04" })
  const [blocked] = await check(dependencies([variant("variant", 0)]))
  expect(blocked).toMatchObject({ decision: "blocked", earliest_available_date: "2026-10-03" })
})

it("uses the legacy stock and advisory allocation path while the native flag is off", async () => {
  process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED = "false"
  const legacy = { id: "variant", manage_inventory: true, allow_backorder: false,
    inventory_quantity: 5, inventory_items: [], product: { id: "product", metadata: {} }, metadata: {} }
  const [line] = await check(dependencies([legacy], [commitment(2)]))
  expect(line).toMatchObject({ decision: "available", current_stock_quantity: 5,
    allocated_quantity: 2, available_to_promise_quantity: 3 })
})

it("keeps inactive/internal products and unverified alternatives out even with native stock", async () => {
  const main = variant(); main.metadata.alternative_variant_ids = ["raw", "missing_baseline", "retail"]
  const raw = variant("raw"); raw.sku = " rm-1 "
  const missing = variant("missing_baseline"); missing.manage_inventory = false
  const [line] = await check(dependencies([main, raw, missing, variant("retail")]))
  expect(line.alternatives.map(a => a.variant_id)).toEqual(["retail"])
  main.product.metadata.availability_lifecycle = "seasonal_inactive"
  expect((await check(dependencies([main])))[0].decision).toBe("inactive")
})

it("combines repeated variant demand and refuses unresolved shared-stock mappings", async () => {
  const [line] = await check(dependencies([variant("variant", 1)]), { lines: [
    { variant_id: "variant", quantity: 1 }, { variant_id: "variant", quantity: 1 },
  ] })
  expect(line.decision).toBe("partial")
  const shared = variant("shared"); shared.manage_inventory = false
  expect((await check(dependencies([variant(), shared], [commitment(1, "line", "shared")])))[0].reason).toBe("inventory_reconciliation_required")
  const [unrelated] = await check(dependencies([variant()], [commitment(1, "line", "unrelated")]))
  expect(unrelated).toMatchObject({ decision: "available", allocated_quantity: 0 })
})
