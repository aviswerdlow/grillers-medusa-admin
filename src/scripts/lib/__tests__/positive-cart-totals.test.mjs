import assert from "node:assert/strict"
import test from "node:test"
import { hasPositiveCartTotals } from "../positive-cart-totals.mjs"

test("accepts positive serialized Medusa cart totals", () => {
  assert.equal(hasPositiveCartTotals({ total: "11.49", subtotal: { value: "11.49" } }), true)
  assert.equal(hasPositiveCartTotals({ total: { numeric_: 11.49, raw_: {} }, subtotal: 11.49 }), true)
})

test("requires both cart totals to be positive and finite", () => {
  assert.equal(hasPositiveCartTotals({ total: 0, subtotal: 11.49 }), false)
  assert.equal(hasPositiveCartTotals({ total: 11.49, subtotal: { value: "0" } }), false)
  assert.equal(hasPositiveCartTotals({ total: "", subtotal: 11.49 }), false)
  assert.equal(hasPositiveCartTotals({ total: "Infinity", subtotal: 11.49 }), false)
  assert.equal(hasPositiveCartTotals({ total: 11.49 }), false)
})
