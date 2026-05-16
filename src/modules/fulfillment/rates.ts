export const FREE_DELIVERY_ELIGIBLE_METADATA_KEY = "free_delivery_eligible"

type LineItemLike = {
  unit_price?: number | null
  quantity?: number | null
  subtotal?: number | null
  total?: number | null
  metadata?: Record<string, unknown> | null
}

export type AtlantaDeliveryZoneRate = {
  FreeDeliveryThresholdCents?: number | null
  Rate250PlusCents?: number | null
  Rate150To249Cents?: number | null
  Rate100To149Cents?: number | null
  Rate50To99Cents?: number | null
  Rate0To49Cents?: number | null
}

function metadataFlagIsFalse(value: unknown) {
  return value === false || value === "false" || value === 0 || value === "0"
}

export function lineItemQualifiesForFreeDelivery(item: LineItemLike): boolean {
  return !metadataFlagIsFalse(
    item.metadata?.[FREE_DELIVERY_ELIGIBLE_METADATA_KEY]
  )
}

export function lineItemSubtotalCents(item: LineItemLike): number {
  const direct = item.subtotal ?? item.total
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return Math.max(0, direct)
  }
  const unit = typeof item.unit_price === "number" ? item.unit_price : 0
  const quantity = typeof item.quantity === "number" ? item.quantity : 0
  return Math.max(0, unit * quantity)
}

export function eligibleSubtotalCents(items: LineItemLike[] = []): number {
  return items.reduce(
    (sum, item) =>
      lineItemQualifiesForFreeDelivery(item)
        ? sum + lineItemSubtotalCents(item)
        : sum,
    0
  )
}

export function atlantaDeliveryRateCents(
  zone: AtlantaDeliveryZoneRate,
  eligibleSubtotal: number
): number {
  const freeThreshold = zone.FreeDeliveryThresholdCents ?? 25000
  if (eligibleSubtotal >= freeThreshold) {
    return zone.Rate250PlusCents ?? 0
  }
  if (eligibleSubtotal >= 15000) return zone.Rate150To249Cents ?? 0
  if (eligibleSubtotal >= 10000) return zone.Rate100To149Cents ?? 0
  if (eligibleSubtotal >= 5000) return zone.Rate50To99Cents ?? 0
  return zone.Rate0To49Cents ?? 0
}
