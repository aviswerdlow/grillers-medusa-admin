function isPositiveAmount(input) {
  const value =
    input && typeof input === "object" ? input.value ?? input.numeric_ : input

  if (typeof value !== "number" && typeof value !== "string") return false
  if (typeof value === "string" && !value.trim()) return false

  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0
}

export function hasPositiveCartTotals(cart) {
  return isPositiveAmount(cart?.total) && isPositiveAmount(cart?.subtotal)
}
