import { buildInventoryBaselineReview, baselineReviewCsv, InventoryBaselineSnapshot } from "../inventory-baseline-review"
import { collectInventoryBaselineSnapshot } from "../../scripts/inventory-baseline-review"

function snapshot(): InventoryBaselineSnapshot {
  const variant = { id: "variant", sku: "retail", metadata: { qbd_list_id: "stable" },
    manage_inventory: false, allow_backorder: false,
    inventory_items: [{ inventory_item_id: "item", required_quantity: 2 }] }
  return {
    origin: "https://commerce.example", started_at: "2026-09-19T00:00:00Z", completed_at: "2026-09-19T00:01:00Z",
    store_products: [{ id: "product", variants: [variant] }],
    admin_products: [{ id: "product", variants: [variant] }],
    inventory_items: [{ id: "item", location_levels: [{ location_id: "location", stocked_quantity: 10,
      reserved_quantity: 4, available_quantity: 6 }] }],
    stock_locations: [{ id: "location", name: "Fixture warehouse" }],
    reservations: [{ id: "reservation", inventory_item_id: "item", location_id: "location", quantity: 4, line_item_id: "line" }],
    allocations: [{ id: "allocation", variant_id: "variant", line_item_id: "line", quantity: 2, status: "reserved" }],
  }
}

it("keeps native reservations and advisory demand separate; no inferred stock is approved", () => {
  const review = buildInventoryBaselineReview(snapshot())
  expect(review).toMatchObject({ mode: "review_only", writes_performed: 0, approved_for_write: false,
    summary: { retail_candidates: 1, native_reservations: 1, active_allocations: 1 } })
  expect(review.rows[0]).toMatchObject({ qbd_list_id: "stable", manage_inventory: false,
    approved_usable_units: null, cached_qbd_on_hand: null, approved_stock_location_id: null,
    advisory_demand: { reserved: 2 }, inventory: [{ required_quantity: 2, locations: [{
      stocked_quantity: 10, available_quantity: 6, reserved_quantity: 4, reservation_quantity: 4 }] }],
    exceptions: expect.arrayContaining(["inventory_not_tracked", "approved_baseline_required", "in_flight_order_review_required"]) })
  expect(review.rows[0].exceptions).not.toContain("reservation_total_mismatch")
})

it("excludes whole mixed/internal products from either authoritative catalog surface", () => {
  for (const scope of ["store_products", "admin_products"] as const) {
    const input = snapshot()
    input[scope] = [{ id: "product", variants: [{ id: "variant", sku: "retail" }, { id: "raw", sku: " rm-stock " }] }]
    expect(buildInventoryBaselineReview(input).summary).toMatchObject({ retail_candidates: 0, excluded_internal_products: 1 })
  }
})

it("flags identity, units, reservation and location exceptions instead of silently setting zero", () => {
  const input = snapshot()
  input.store_products = [{ id: "product", variants: [{ id: "variant", metadata: { qbd_list_id: "wrong" } }] }]
  input.admin_products[0].variants[0].inventory_items[0].required_quantity = false
  input.inventory_items[0].location_levels[0].reserved_quantity = 3
  input.stock_locations = []
  input.reservations[0].quantity = false
  const row = buildInventoryBaselineReview(input).rows[0]
  expect(row.inventory[0].required_quantity).toBeNull()
  expect(row.exceptions).toEqual(expect.arrayContaining(["catalog_identity_mismatch", "invalid_required_quantity",
    "invalid_reservation_quantity", "reservation_total_mismatch", "unknown_stock_location"]))
})

it("reports duplicate stable identities and changes the review fingerprint when native stock changes", () => {
  const input = snapshot()
  const first = buildInventoryBaselineReview(input).rows[0].current_state_sha256
  input.inventory_items[0].location_levels[0].stocked_quantity = 11
  expect(buildInventoryBaselineReview(input).rows[0].current_state_sha256).not.toBe(first)
  input.store_products[0].variants.push({ id: "variant2", metadata: { qbd_list_id: "stable" } })
  const review = buildInventoryBaselineReview(input)
  expect(review.summary.exceptions.duplicate_qbd_list_id).toBe(2)
})

it("identifies unmirrored demand, shared stock, and mismatched reservation items for operator reconciliation", () => {
  const input = snapshot()
  input.allocations.push({ id: "unmatched", variant_id: "variant", quantity: 1, status: "reserved", line_item_id: "other_line" })
  input.store_products[0].variants.push({ id: "variant2", metadata: { QuickBooksListId: "stable2" } })
  input.admin_products[0].variants.push({ id: "variant2", metadata: { QuickBooksListId: "stable2" },
    inventory_items: [{ inventory_item_id: "item", required_quantity: 0.5 }] })
  input.reservations[0].inventory_item_id = "other_item"
  const report = buildInventoryBaselineReview(input)
  expect(report.rows[0].exceptions).toEqual(expect.arrayContaining([
    "shared_inventory_item_review_required", "advisory_without_native_reservation", "advisory_native_item_mismatch",
  ]))
  expect(report.rows[1].qbd_list_id).toBe("stable2")
  expect(report.rows[1].inventory[0].required_quantity).toBe(0.5)
})

it("neutralizes a spreadsheet formula in a mutable SKU", () => {
  const input = snapshot()
  input.admin_products[0].variants[0].sku = '=HYPERLINK("https://invalid")'
  const csv = baselineReviewCsv(buildInventoryBaselineReview(input))
  expect(csv).toContain('"\'=HYPERLINK(""https://invalid"")"')
  input.admin_products[0].variants[0].sku = '\t =1+1'
  expect(baselineReviewCsv(buildInventoryBaselineReview(input))).toContain('"\'\t =1+1"')
})

const inputs = { origin: "https://commerce.example", publishableKey: "public-key", adminReadToken: "private-read-token" }
const keys: Record<string, string> = { "/store/products": "products", "/admin/products": "products",
  "/admin/inventory-items": "inventory_items", "/admin/stock-locations": "stock_locations",
  "/admin/reservations": "reservations", "/admin/grillers/inventory/allocations": "allocations" }
function fixtureFetcher(change?: (url: URL, body: any) => any) {
  return jest.fn(async (request, options) => {
    const url = new URL(request), key = keys[url.pathname]
    const offset = Number(url.searchParams.get("offset"))
    const count = url.pathname === "/store/products" || key === "allocations" ? 101 : 0
    const body = { [key]: Array.from({ length: Math.max(0, Math.min(100, count - offset)) }, (_, i) => ({
      id: `${key}_${i + offset}`, customer_email: "private@example.invalid" })),
      ...(key === "allocations" ? {} : { count }), offset, limit: 100 }
    return new Response(JSON.stringify(change ? change(url, body) : body), { status: 200 })
  })
}

it("reads every page with GET, scoped headers and no redirects, including the uncounted ledger", async () => {
  const fetcher = fixtureFetcher()
  const result = await collectInventoryBaselineSnapshot({ ...inputs, fetcher })
  expect(result.store_products).toHaveLength(101)
  expect(result.allocations).toHaveLength(101)
  expect(JSON.stringify(result.allocations)).not.toContain("private@example.invalid")
  for (const [url, options] of fetcher.mock.calls) {
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" })
    expect(options.headers).toEqual(new URL(url).pathname.startsWith("/store/")
      ? { "x-publishable-api-key": "public-key" } : { Authorization: "Basic private-read-token" })
  }
})

it.each([
  ["changed during pagination", (url: URL, body: any) => url.searchParams.get("offset") === "100" ? { ...body, count: 102 } : body],
  ["omitted its total", (_url: URL, body: any) => ({ ...body, count: undefined })],
  ["incomplete collection", (_url: URL, body: any) => ({ ...body, products: [] })],
  ["repeated identity", (url: URL, body: any) => url.searchParams.get("offset") === "100" ? { ...body, products: [{ id: "products_0" }] } : body],
  ["did not honor pagination", (_url: URL, body: any) => ({ ...body, offset: 50 })],
])("rejects a partial review: %s", async (message, change) => {
  await expect(collectInventoryBaselineSnapshot({ ...inputs, fetcher: fixtureFetcher(change as any) })).rejects.toThrow(String(message))
})

it("rejects a later provider failure without exposing its body", async () => {
  const good = fixtureFetcher()
  const fetcher = jest.fn(async (url, options) => new URL(url).pathname === "/admin/reservations"
    ? new Response("private provider diagnostic", { status: 403 }) : good(url, options))
  await expect(collectInventoryBaselineSnapshot({ ...inputs, fetcher })).rejects.toThrow("/admin/reservations returned HTTP 403")
})

it("redacts transport errors and rejects credential-bearing or non-HTTPS origins before access", async () => {
  const fetcher = jest.fn().mockRejectedValue(new Error("private-read-token"))
  await expect(collectInventoryBaselineSnapshot({ ...inputs, fetcher })).rejects.toThrow("/store/products read failed")
  for (const origin of ["http://commerce.example", "https://secret@commerce.example", "https://commerce.example?token=secret"]) {
    await expect(collectInventoryBaselineSnapshot({ ...inputs, origin, fetcher })).rejects.toThrow("exact HTTPS")
  }
  expect(fetcher).toHaveBeenCalledTimes(1)
})
