import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { buildInventoryBaselineReview, baselineReviewCsv, type InventoryBaselineSnapshot } from "../lib/inventory-baseline-review"

type Fetcher = typeof fetch
// Only this class contains printable diagnostics. Never expose an exception from
// a transport, URL parser or provider response, which may include credentials.
export class InventoryBaselineReadError extends Error {}
export async function collectInventoryBaselineSnapshot(input: {
  origin: string; publishableKey: string; adminReadToken: string; fetcher?: Fetcher
}): Promise<InventoryBaselineSnapshot> {
  let url: URL
  try { url = new URL(input.origin) } catch { throw new InventoryBaselineReadError("Invalid Medusa origin") }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new InventoryBaselineReadError("Use the exact HTTPS Medusa origin without credentials or a path")
  }
  if (!input.publishableKey || !input.adminReadToken) throw new InventoryBaselineReadError("Public and read credentials are required")
  const started_at = new Date().toISOString()
  const fetcher = input.fetcher || fetch
  const all = async (route: string, key: string, fields?: string, query: Record<string, string> = {}, counted = true) => {
    const rows: Record<string, any>[] = [], seen = new Set<string>()
    let expectedCount: number | undefined
    for (let page = 0; page < 1000; page++) {
      const offset = page * 100
      const queryString = new URLSearchParams({ ...query, limit: "100", offset: String(offset), ...(fields ? { fields } : {}) })
      const headers: Record<string, string> = route.startsWith("/store/")
        ? { "x-publishable-api-key": input.publishableKey }
        : { Authorization: `Basic ${input.adminReadToken}` }
      let response: Response
      try {
        response = await fetcher(url.origin + route + "?" + queryString, {
          method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(25000),
        })
      } catch { throw new InventoryBaselineReadError(`${route} read failed; no complete review was produced`) }
      if (!response.ok) throw new InventoryBaselineReadError(`${route} returned HTTP ${response.status}; no complete review was produced`)
      let body: any
      try { body = await response.json() } catch { throw new InventoryBaselineReadError(`${route} returned invalid JSON`) }
      if (!body || !Array.isArray(body[key])) throw new InventoryBaselineReadError(`${route} returned an invalid collection`)
      if (counted) {
        if (!Number.isSafeInteger(body.count) || body.count < 0) throw new InventoryBaselineReadError(`${route} omitted its total`)
        if (expectedCount !== undefined && body.count !== expectedCount) throw new InventoryBaselineReadError(`${route} changed during pagination`)
        expectedCount = body.count
      }
      const batch = body[key]
      if (batch.length > 100 || (body.offset !== undefined && body.offset !== offset) || (body.limit !== undefined && body.limit !== 100)) {
        throw new InventoryBaselineReadError(`${route} did not honor pagination`)
      }
      for (const row of batch) {
        if (typeof row?.id !== "string" || !row.id || seen.has(row.id)) throw new InventoryBaselineReadError(`${route} returned missing or repeated identity`)
        seen.add(row.id); rows.push(row)
      }
      if (counted && rows.length === expectedCount) return rows
      if (counted && (rows.length > expectedCount! || batch.length < 100)) throw new InventoryBaselineReadError(`${route} returned an incomplete collection`)
      if (!counted && batch.length < 100) return rows
    }
    throw new InventoryBaselineReadError(`${route} exceeded the page limit; no complete review was produced`)
  }
  // Keep reads sequential and fail the whole review if any collection is incomplete.
  const store_products = await all("/store/products", "products", "id,status,metadata,*variants")
  const admin_products = await all("/admin/products", "products", "id,status,metadata,variants.id,variants.sku,variants.manage_inventory,variants.allow_backorder,variants.metadata,variants.inventory_items.inventory_item_id,variants.inventory_items.required_quantity")
  const inventory_items = await all("/admin/inventory-items", "inventory_items", "id,metadata,*location_levels")
  const stock_locations = await all("/admin/stock-locations", "stock_locations", "id,name")
  const reservations = await all("/admin/reservations", "reservations", "id,line_item_id,inventory_item_id,location_id,quantity")
  const allocations = (await all("/admin/grillers/inventory/allocations", "allocations", undefined, { status: "active" }, false))
    .map(({ id, order_id, line_item_id, variant_id, inventory_item_id, stock_location_id, quantity, status, requested_fulfillment_date }) =>
      ({ id, order_id, line_item_id, variant_id, inventory_item_id, stock_location_id, quantity, status, requested_fulfillment_date }))
  return { origin: url.origin, started_at, completed_at: new Date().toISOString(),
    store_products, admin_products, inventory_items, stock_locations, reservations, allocations }
}

async function main() {
  const output = process.argv[2]
  if (!output || !path.isAbsolute(output)) throw new Error("Supply a new absolute protected output directory")
  process.umask(0o077)
  // Refuse an existing directory so an old review/approval cannot be overwritten.
  await mkdir(output, { mode: 0o700 })
  const snapshot = await collectInventoryBaselineSnapshot({
    origin: process.env.MEDUSA_BACKEND_URL || "",
    publishableKey: process.env.MEDUSA_PUBLISHABLE_KEY || "",
    adminReadToken: process.env.MEDUSA_ADMIN_READ_TOKEN || "",
  })
  const review = buildInventoryBaselineReview(snapshot)
  await writeFile(path.join(output, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  await writeFile(path.join(output, "review.json"), JSON.stringify(review, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  await writeFile(path.join(output, "review.csv"), baselineReviewCsv(review), { mode: 0o600, flag: "wx" })
  console.log(JSON.stringify({ mode: review.mode, writes_performed: 0, approved_for_write: false, ...review.summary }))
}
if (require.main === module) main().catch((error) => {
  // Never print a request object, credentials, provider payload or customer data.
  console.error(error instanceof InventoryBaselineReadError ? error.message : "Inventory review failed; no complete approved baseline exists. Inspect the read-only inputs and retry once after correcting the cause.")
  process.exitCode = 1
})
