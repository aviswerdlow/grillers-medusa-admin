// Medusa 2.10.3's reserve-step compensation hard-deletes the reservation row
// without decrementing inventory_level.reserved_quantity. Keep this narrowly
// pinned until the upstream package has a counter-safe compensation path.
const fs = require("node:fs")
const path = require("node:path")

const dist = path.dirname(require.resolve("@medusajs/core-flows"))
const packageRoot = path.resolve(dist, "..")
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version
if (version !== "2.10.3") throw new Error(`Review reservation compensation for Medusa ${version}`)

const file = path.join(dist, "cart/steps/reserve-inventory.js")
const source = fs.readFileSync(file, "utf8")
const unsafe = "await inventoryService.deleteReservationItems(data.reservations);"
const safe = "await inventoryService.softDeleteReservationItems(data.reservations);"
if (source.includes(safe)) {
  if (source.includes(unsafe)) throw new Error("Ambiguous Medusa reservation compensation")
} else {
  if (source.split(unsafe).length !== 2) throw new Error("Unknown Medusa reservation compensation")
  fs.writeFileSync(file, source.replace(unsafe, safe))
}
