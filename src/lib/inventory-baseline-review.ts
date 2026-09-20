import { createHash } from "node:crypto"
import { isInternalCatalogProduct } from "./public-catalog"
import { qbdListIdFromMetadata } from "./inventory-allocation"

type Row = Record<string, any>
export type InventoryBaselineSnapshot = {
  origin: string
  started_at: string
  completed_at: string
  store_products: Row[]
  admin_products: Row[]
  inventory_items: Row[]
  stock_locations: Row[]
  reservations: Row[]
  allocations: Row[]
}

function quantity(value: unknown): number | null {
  if (value && typeof value === "object" && "value" in value) return quantity((value as any).value)
  if (typeof value !== "number" && typeof value !== "string") return null
  if (typeof value === "string" && !value.trim()) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function listId(record: Row | undefined): string | null {
  return qbdListIdFromMetadata(record?.metadata) || null
}
const active = new Set(["reserved", "future_committed", "blocked"])

/** Review only. No inferred quantity is an approved physical/QBD baseline. */
export function buildInventoryBaselineReview(snapshot: InventoryBaselineSnapshot) {
  const products = new Map(snapshot.admin_products.map(p => [p.id, p]))
  const items = new Map(snapshot.inventory_items.map(i => [i.id, i]))
  const locations = new Set(snapshot.stock_locations.map(l => l.id))
  const knownInternal = new Set(snapshot.admin_products.filter(isInternalCatalogProduct).map(p => p.id))
  const excluded: Array<{ product_id: string; variant_ids: string[]; reason: string }> = []
  const rows: Row[] = []

  for (const store of snapshot.store_products) {
    if (isInternalCatalogProduct(store) || knownInternal.has(store.id)) {
      excluded.push({ product_id: store.id, variant_ids: (store.variants || []).map((v: Row) => v.id), reason: "internal_catalog" })
      continue
    }
    const admin = products.get(store.id)
    for (const publicVariant of store.variants || []) {
      const variant = admin?.variants?.find((v: Row) => v.id === publicVariant.id)
      const issues = new Set<string>(["approved_baseline_required", "unit_and_location_review_required", "in_flight_order_review_required"])
      const qbdId = listId(variant) || listId(admin) || listId(publicVariant) || listId(store)
      if (!admin || !variant) issues.add("missing_admin_variant")
      if (!qbdId) issues.add("missing_qbd_list_id")
      const publicListId = listId(publicVariant) || listId(store)
      const adminListId = listId(variant) || listId(admin)
      if (publicListId && adminListId && publicListId !== adminListId) issues.add("catalog_identity_mismatch")
      if (variant?.manage_inventory !== true) issues.add("inventory_not_tracked")
      if (variant?.allow_backorder !== false) issues.add("backorder_policy_not_disabled")
      const links: Row[] = Array.isArray(variant?.inventory_items) ? variant.inventory_items : []
      if (!links.length) issues.add("missing_inventory_link")
      if (links.length > 1) issues.add("component_mapping_review_required")
      const inventory = links.map(link => {
        const inventoryId = link.inventory_item_id || link.inventory?.id
        const item = items.get(inventoryId)
        const required = quantity(link.required_quantity)
        if (!inventoryId || !item) issues.add("missing_inventory_item")
        if (required === null || required <= 0) issues.add("invalid_required_quantity")
        const levels: Row[] = Array.isArray(item?.location_levels) ? item.location_levels : []
        if (!levels.length) issues.add("missing_inventory_location_level")
        const itemReservations = snapshot.reservations.filter(r => r.inventory_item_id === inventoryId)
        return {
          inventory_item_id: inventoryId || null, required_quantity: required,
          locations: levels.map(level => {
            const stocked = quantity(level.stocked_quantity), reserved = quantity(level.reserved_quantity)
            const available = quantity(level.available_quantity)
            if (!locations.has(level.location_id)) issues.add("unknown_stock_location")
            if (stocked === null || reserved === null) issues.add("missing_native_quantity")
            if (stocked !== null && stocked < 0) issues.add("negative_stocked_quantity")
            if (reserved !== null && reserved < 0) issues.add("negative_reserved_quantity")
            const reservations = itemReservations.filter(r => r.location_id === level.location_id)
            if (reservations.some(r => quantity(r.quantity) === null || quantity(r.quantity)! <= 0)) issues.add("invalid_reservation_quantity")
            const reservationTotal = reservations.reduce((sum, r) => sum + (quantity(r.quantity) ?? 0), 0)
            if (reserved !== null && reserved !== reservationTotal) issues.add("reservation_total_mismatch")
            return { location_id: level.location_id, stocked_quantity: stocked, reserved_quantity: reserved,
              available_quantity: available, reservation_quantity: reservationTotal,
              reservation_count: reservations.length }
          }),
        }
      })
      const allocations = snapshot.allocations.filter(a => a.variant_id === publicVariant.id && active.has(a.status))
      if (allocations.some(a => quantity(a.quantity) === null || quantity(a.quantity)! <= 0)) issues.add("invalid_allocation_quantity")
      const demand: Record<string, number> = { reserved: 0, future_committed: 0, blocked: 0 }
      for (const a of allocations) demand[a.status] += quantity(a.quantity) ?? 0
      const allocationReview = allocations.map(a => {
        const matching = snapshot.reservations.filter(r => a.line_item_id && r.line_item_id === a.line_item_id)
        if (!matching.length) issues.add("advisory_without_native_reservation")
        const mismatched = matching.some(r => !inventory.some(link => link.inventory_item_id === r.inventory_item_id))
        if (mismatched) issues.add("advisory_native_item_mismatch")
        return { allocation_id: a.id, order_id: a.order_id || null, line_item_id: a.line_item_id || null,
          status: a.status, quantity: quantity(a.quantity),
          native_reservations: matching.map(r => ({ reservation_id: r.id, inventory_item_id: r.inventory_item_id,
            location_id: r.location_id, quantity: quantity(r.quantity) })) }
      })
      // Present the two ledgers separately. Their overlap is not an additional
      // subtraction, and a future commitment is not proof of incoming supply.
      const cachedQbdQuantity = quantity(variant?.metadata?.qbd_quantity_on_hand ?? admin?.metadata?.qbd_quantity_on_hand)
      rows.push({ product_id: store.id, variant_id: publicVariant.id, qbd_list_id: qbdId,
        sku: variant?.sku || publicVariant.sku || null,
        manage_inventory: variant?.manage_inventory ?? null,
        allow_backorder: variant?.allow_backorder ?? null,
        inventory, advisory_demand: demand, advisory_row_count: allocations.length, allocation_review: allocationReview,
        cached_qbd_on_hand: cachedQbdQuantity,
        proposed_baseline_quantity: null, approved_usable_units: null,
        source_kind: null, source_company: null, source_as_of: null,
        approved_stock_location_id: null, approved_by: null, approved_at: null,
        unit_definition: null, in_flight_order_disposition: null,
        exceptions: [...issues].sort(),
      })
    }
  }
  const ids = new Map<string, number>()
  const itemOwners = new Map<string, Set<string>>()
  for (const row of rows) for (const link of row.inventory) {
    if (!link.inventory_item_id) continue
    const owners = itemOwners.get(link.inventory_item_id) || new Set<string>()
    owners.add(row.variant_id)
    itemOwners.set(link.inventory_item_id, owners)
  }
  for (const row of rows) if (row.qbd_list_id) ids.set(row.qbd_list_id, (ids.get(row.qbd_list_id) || 0) + 1)
  for (const row of rows) {
    if (row.qbd_list_id && ids.get(row.qbd_list_id)! > 1) row.exceptions.push("duplicate_qbd_list_id")
    if (row.inventory.some((link: Row) => (itemOwners.get(link.inventory_item_id)?.size || 0) > 1)) {
      row.exceptions.push("shared_inventory_item_review_required")
    }
    row.current_state_sha256 = createHash("sha256").update(JSON.stringify({
      variant_id: row.variant_id, qbd_list_id: row.qbd_list_id, manage_inventory: row.manage_inventory,
      allow_backorder: row.allow_backorder, inventory: row.inventory, allocation_review: row.allocation_review,
    })).digest("hex")
  }
  const exceptionCounts: Record<string, number> = {}
  for (const row of rows) for (const issue of row.exceptions) exceptionCounts[issue] = (exceptionCounts[issue] || 0) + 1
  return {
    schema_version: 1, mode: "review_only", writes_performed: 0,
    origin: snapshot.origin, started_at: snapshot.started_at, completed_at: snapshot.completed_at,
    consistency: "sequential_read_not_quiesced", approved_for_write: false,
    stock_locations: snapshot.stock_locations.map(l => ({ id: l.id, name: l.name })),
    summary: { retail_candidates: rows.length, excluded_internal_products: excluded.length,
      admin_products: snapshot.admin_products.length, inventory_items: items.size, native_reservations: snapshot.reservations.length,
      active_allocations: snapshot.allocations.filter(a => active.has(a.status)).length,
      exceptions: exceptionCounts },
    rows, excluded,
  }
}

export function baselineReviewCsv(review: ReturnType<typeof buildInventoryBaselineReview>) {
  const columns = ["product_id", "variant_id", "qbd_list_id", "sku", "manage_inventory", "allow_backorder",
    "inventory", "advisory_demand", "allocation_review", "cached_qbd_on_hand", "approved_usable_units", "source_kind", "source_company",
    "source_as_of", "unit_definition", "in_flight_order_disposition", "approved_stock_location_id", "approved_by", "approved_at", "exceptions", "current_state_sha256"]
  const cell = (value: any) => {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)
    if (/^[\u0000-\u0020]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return [columns.join(","), ...review.rows.map(row => columns.map(key => cell(row[key])).join(","))].join("\n") + "\n"
}
