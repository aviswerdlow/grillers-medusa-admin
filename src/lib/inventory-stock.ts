import { MathBN } from "@medusajs/framework/utils"

type Row = Record<string, any>
export type NativeStock = {
  quantity: number
  ready: boolean
  reason?: string
  inventoryItemId?: string
  stockLocationId?: string
  components: Array<{ inventoryItemId: string; requiredQuantity: number; available: number; locationIds: string[] }>
}

export function stockNumber(value: unknown): number | undefined {
  if (value && typeof value === "object" && "value" in value) return stockNumber((value as any).value)
  if (value && typeof value === "object" && typeof (value as any).toNumber === "function") {
    const number = (value as any).toNumber()
    return typeof number === "number" && Number.isFinite(number) ? number : undefined
  }
  if (typeof value !== "number" && typeof value !== "string") return undefined
  if (typeof value === "string" && !value.trim()) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** A cached QBD quantity or an unmanaged variant is never a native stock baseline. */
export function variantNativeStock(variant: Row): NativeStock {
  const unavailable = (reason: string): NativeStock => ({ quantity: 0, ready: false, reason, components: [] })
  if (variant.manage_inventory !== true || variant.allow_backorder !== false) return unavailable("inventory_baseline_required")
  if (!Array.isArray(variant.inventory_items) || !variant.inventory_items.length) return unavailable("inventory_baseline_required")
  const components: NativeStock["components"] = []
  const seen = new Set<string>()
  for (const link of variant.inventory_items) {
    const id = link?.inventory_item_id || link?.inventory?.id
    const required = stockNumber(link?.required_quantity)
    const levels = link?.inventory?.location_levels
    if (typeof id !== "string" || !id || seen.has(id) || required === undefined || required <= 0 || !Array.isArray(levels) || !levels.length) {
      return unavailable("inventory_baseline_required")
    }
    seen.add(id)
    const locations = new Set<string>()
    let available = MathBN.convert(0)
    for (const level of levels) {
      const stocked = stockNumber(level?.stocked_quantity), reserved = stockNumber(level?.reserved_quantity)
      if (typeof level?.location_id !== "string" || !level.location_id || locations.has(level.location_id)
        || stocked === undefined || reserved === undefined || stocked < 0 || reserved < 0) {
        return unavailable("inventory_baseline_required")
      }
      locations.add(level.location_id)
      // Preserve negative availability until all levels are summed; a deficit at
      // one location must not create phantom supply by being clamped individually.
      available = MathBN.add(available, MathBN.sub(stocked, reserved))
    }
    components.push({ inventoryItemId: id, requiredQuantity: required, available: available.toNumber(), locationIds: [...locations] })
  }
  const quantity = Math.max(0, Math.min(...components.map(c => Math.floor(MathBN.div(c.available, c.requiredQuantity).toNumber()))))
  return { ready: true, quantity, components, inventoryItemId: components[0].inventoryItemId, stockLocationId: components[0].locationIds[0] }
}

export type NativeReservation = { line_item_id: string; inventory_item_id: string; location_id: string; quantity: number | string }
export type AdvisoryCommitment = { id: string; variant_id: string; line_item_id?: string | null; quantity: number | string }

/** Return ONLY demand not already deducted by Medusa's native reservation ledger.
 * The caller blocks affected stock until unmirrored demand is reconciled: a
 * read-time subtraction is not an atomic replacement for a native reservation.
 */
export function unmirroredInventoryDemand(
  commitments: AdvisoryCommitment[], stocks: Map<string, NativeStock>, reservations: NativeReservation[]
): Map<string, number> {
  const remainingNative = new Map<string, number>()
  const key = (line: string, item: string, location: string) => JSON.stringify([line, item, location])
  for (const r of reservations) {
    const quantity = stockNumber(r.quantity)
    if (quantity === undefined || quantity <= 0) throw new Error("Native reservation requires reconciliation")
    const k = key(r.line_item_id, r.inventory_item_id, r.location_id)
    remainingNative.set(k, MathBN.add(remainingNative.get(k) || 0, quantity).toNumber())
  }
  const unmatched = new Map<string, number>()
  for (const row of commitments) {
    const stock = stocks.get(row.variant_id)
    const quantity = stockNumber(row.quantity)
    if (!stock?.ready || quantity === undefined || quantity <= 0) throw new Error("Advisory commitment requires a verified stock mapping")
    for (const component of stock.components) {
      let needed = MathBN.mult(quantity, component.requiredQuantity).toNumber()
      for (const location of component.locationIds) {
        if (!row.line_item_id) break
        const k = key(row.line_item_id, component.inventoryItemId, location)
        const covered = Math.min(needed, remainingNative.get(k) || 0)
        needed = MathBN.sub(needed, covered).toNumber()
        remainingNative.set(k, MathBN.sub(remainingNative.get(k) || 0, covered).toNumber())
      }
      if (needed > 0) unmatched.set(component.inventoryItemId, MathBN.add(unmatched.get(component.inventoryItemId) || 0, needed).toNumber())
    }
  }
  return unmatched
}

export function unmirroredVariantUnits(stock: NativeStock, unmatched: Map<string, number>): number {
  // Any unmet component limits the complete sellable unit, including shared
  // stock committed through another variant. Round demand up, never down.
  return Math.max(0, ...stock.components.map(c => Math.ceil(MathBN.div(unmatched.get(c.inventoryItemId) || 0, c.requiredQuantity).toNumber())))
}

export function nativeReservedUnitsForLine(stock: NativeStock, reservations: NativeReservation[], lineItemId: string): number {
  if (!stock.ready) return 0
  return Math.max(0, Math.min(...stock.components.map(component => {
    const quantity = reservations.filter(r => r.line_item_id === lineItemId && r.inventory_item_id === component.inventoryItemId
      && component.locationIds.includes(r.location_id)).reduce((sum, r) => MathBN.add(sum, stockNumber(r.quantity) || 0).toNumber(), 0)
    return Math.floor(MathBN.div(quantity, component.requiredQuantity).toNumber())
  })))
}
