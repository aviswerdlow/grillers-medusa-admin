import path from "node:path"
import { randomUUID } from "node:crypto"
import Redis from "ioredis"
import { Modules, toMikroOrmEntities } from "@medusajs/framework/utils"
import { checkInventoryAvailability, createAllocationsForOrder, releaseAllocationsForOrder } from "../../src/lib/inventory-allocation"
import { guardNativeCartInventory, guardNativePaymentInventory } from "../../src/api/middlewares/inventory-baseline"
import { Migration20260525170000 } from "../../src/modules/gp-inventory-allocation/migrations/Migration20260525170000"

jest.mock("../../src/lib/ops-alert", () => ({ emitOpsAlert: jest.fn().mockResolvedValue(undefined) }))
const utilsPath = path.dirname(require.resolve("@medusajs/test-utils"))
const { getMikroOrmWrapper } = require(path.join(utilsPath, "database"))
const { initModules } = require(path.join(utilsPath, "init-modules"))
const inventoryPath = path.dirname(require.resolve("@medusajs/inventory"))
const models = require(path.join(inventoryPath, "models"))
const { RedisLockingProvider } = require(path.join(path.dirname(require.resolve("@medusajs/locking-redis")), "services/redis-lock"))
const knex = require("knex")
// Medusa's inventory DML emits unqualified indexes. A database reserved only
// for this fixture lets those indexes resolve in public without exposing any
// application or shared test tables to schema refresh/cleanup.
const schema = "public"
const lockNamespace = `gp_inventory_${randomUUID().replace(/-/g, "")}`
let db: any, inventory: any, wrapper: any, shutdown: any
let clients: Redis[] = [], locks: any[] = []
let nativeReserve: any, nativeCompensate: any
const variants = new Map<string, any>(), orders = new Map<string, any>(), carts = new Map<string, any>()

// Capture the installed step's actual handlers while preserving its normal
// registration. Assertions below run them against the real inventory module,
// PostgreSQL and two independent native Redis providers, not a stock-service mock.
beforeAll(async () => {
  const url = process.env.INVENTORY_TEST_DATABASE_URL
  const redisUrl = process.env.INVENTORY_TEST_REDIS_URL
  if (!url || !redisUrl || ![new URL(url), new URL(redisUrl)].every(u => ["localhost", "127.0.0.1"].includes(u.hostname)) || new URL(url).pathname !== "/gp_inventory_fixture") {
    throw new Error("Supply loopback gp_inventory_fixture database and Redis; never production or shared test variables")
  }
  db = knex({ client: "pg", connection: url, searchPath: [schema] })
  wrapper = getMikroOrmWrapper({ mikroOrmEntities: toMikroOrmEntities(Object.values(models)), clientUrl: url, schema })
  await wrapper.setupDatabase()
  const result = await initModules({
    databaseConfig: { clientUrl: url, schema },
    modulesConfig: { [Modules.INVENTORY]: { resolve: "@medusajs/inventory", options: {
      database: { clientUrl: url, schema },
    } } },
    injectedDependencies: { __pg_connection__: db, event_bus: { emit: async () => {} }, logger: { info() {}, warn() {}, error() {}, debug() {} } },
    preventConnectionDestroyWarning: true,
  })
  inventory = result.medusaApp.modules[Modules.INVENTORY]; shutdown = result.shutdown
  await db.schema.createTable("order", (t: any) => { t.text("id").primary(); t.text("status"); t.timestamp("canceled_at"); t.timestamp("deleted_at") })
  const sql: string[] = []
  const migration: any = Object.create(Migration20260525170000.prototype)
  migration.addSql = (statement: string) => sql.push(statement)
  await migration.up()
  for (const statement of sql) await db.raw(statement)

  clients = [new Redis(redisUrl), new Redis(redisUrl)]
  await Promise.all(clients.map(client => client.ping()))
  locks = clients.map(redisClient => new RedisLockingProvider({ redisClient, prefix: `${lockNamespace}:` }, {}))
  const composer = require(path.join(path.dirname(require.resolve("@medusajs/workflows-sdk")), "utils/composer/create-step"))
  const original = composer.createStep
  const spy = jest.spyOn(composer, "createStep").mockImplementation((name: any, invoke: any, compensate: any) => {
    if (name === "reserve-inventory-step") { nativeReserve = invoke; nativeCompensate = compensate }
    return original(name, invoke, compensate)
  })
  try { require(path.join(path.dirname(require.resolve("@medusajs/core-flows")), "cart/steps/reserve-inventory")) } finally { spy.mockRestore() }
  if (!nativeReserve || !nativeCompensate) throw new Error("Installed native reservation step was not captured")
}, 30000)

afterAll(async () => {
  await Promise.all(clients.map(client => client.quit()))
  if (shutdown) await shutdown()
  if (wrapper?.orm) await wrapper.clearDatabase()
  if (db) await db.destroy()
})
beforeEach(async () => {
  await db("gp_inventory_allocation_audit").delete()
  await db("gp_inventory_allocation").delete()
  await db("gp_inventory_availability_snapshot").delete()
  await db("order").delete()
  variants.clear(); orders.clear(); carts.clear()
})

async function fixture(quantity = 1, required = 1) {
  const item = await inventory.createInventoryItems({ sku: `fixture-${randomUUID()}` })
  await inventory.createInventoryLevels({ inventory_item_id: item.id, location_id: "fixture_location", stocked_quantity: quantity })
  const id = `variant_${randomUUID()}`
  variants.set(id, { id, product_id: "product", manage_inventory: true, allow_backorder: false,
    metadata: { qbd_list_id: `list_${id}` }, product: { id: "product", title: "Fixture product", metadata: {} }, itemId: item.id, required })
  return { id, itemId: item.id, required }
}
async function hydrated(id: string) {
  const v = variants.get(id)
  if (!v) return undefined
  const item = await inventory.retrieveInventoryItem(v.itemId, { relations: ["location_levels"] })
  return { ...v, inventory_items: [{ inventory_item_id: item.id, required_quantity: v.required, inventory: item }] }
}
const query: any = { graph: async ({ entity, filters }: any) => {
  if (entity === "product_variant") return { data: (await Promise.all(filters.id.map(hydrated))).filter(Boolean) }
  if (entity === "order") {
    const order = orders.get(filters.id)
    return { data: order ? [{ ...order, items: await Promise.all(order.items.map(async (line: any) => ({ ...line, variant: await hydrated(line.variant_id) }))) }] : [] }
  }
  if (entity === "cart") return { data: carts.has(filters.id) ? [carts.get(filters.id)] : [] }
  if (entity === "cart_payment_collection") return { data: [{ cart_id: filters.payment_collection_id }] }
  return { data: [] }
} }
function scope(lock = 0) { return { resolve: (key: string) => {
  if (key === Modules.INVENTORY) return inventory
  if (key === Modules.LOCKING) return locks[lock]
  if (key === "query") return query
  if (key === "logger") return { warn() {} }
  if (key === "__pg_connection__") return db
  throw new Error(`Unexpected fixture service ${key}`)
} } }
async function reserve(v: any, lineId: string, quantity = 1, lock = 0) {
  return nativeReserve({ items: [{ id: lineId, inventory_item_id: v.itemId, required_quantity: v.required,
    quantity, allow_backorder: false, location_ids: ["fixture_location"] }] }, { container: scope(lock) })
}
async function orderFor(v: any, line = `line_${randomUUID()}`) {
  const id = `order_${randomUUID()}`
  await db("order").insert({ id, status: "pending" })
  orders.set(id, { id, items: [{ id: line, variant_id: v.id, quantity: 1 }], metadata: {} })
  return { id, line }
}
async function available(v: any) {
  return (await checkInventoryAvailability({ db, query, lines: [{ variant_id: v.id, quantity: 1 }] }))[0]
}

it("permits exactly one native last-unit reservation across independent Redis clients", async () => {
  const v = await fixture()
  const attempts = await Promise.allSettled([reserve(v, "shopper_one", 1, 0), reserve(v, "shopper_two", 1, 1)])
  expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(1)
  expect(attempts.filter(a => a.status === "rejected")).toHaveLength(1)
  const reservations = await inventory.listReservationItems({ inventory_item_id: v.itemId })
  expect(reservations).toHaveLength(1)
  const item = await inventory.retrieveInventoryItem(v.itemId, { relations: ["location_levels"] })
  expect(item.location_levels[0]).toMatchObject({ stocked_quantity: 1, reserved_quantity: 1 })
  expect(Number(item.location_levels[0].available_quantity)).toBe(0)
})

it("records one advisory allocation and audit on concurrent placement replay, without blocking its own last unit", async () => {
  const v = await fixture(); const order = await orderFor(v)
  await reserve(v, order.line)
  const results = await Promise.all([1, 2].map(() => createAllocationsForOrder({ db, query, orderId: order.id })))
  expect(results.reduce((n, r) => n + r.created, 0)).toBe(1)
  expect(results.reduce((n, r) => n + r.blocked, 0)).toBe(0)
  expect(await db("gp_inventory_allocation").where({ order_id: order.id })).toEqual([expect.objectContaining({
    status: "reserved", allocation_reason: "native_reservation", qbd_list_id: `list_${v.id}`, inventory_item_id: v.itemId,
  })])
  expect(await db("gp_inventory_allocation_audit").where({ event_type: "created" })).toHaveLength(1)
  expect(await available(v)).toMatchObject({ decision: "blocked", allocated_quantity: 0, available_to_promise_quantity: 0 })
})

it("releases native and advisory commitments once and ignores a late placement event after cancellation", async () => {
  const v = await fixture(); const order = await orderFor(v)
  const reservation = await reserve(v, order.line)
  await createAllocationsForOrder({ db, query, orderId: order.id })
  // The native compensation handler owns the reservation counter. The custom
  // subscriber only releases the advisory ledger after the order is canceled.
  await nativeCompensate(reservation.compensateInput, { container: scope() })
  expect(await inventory.listReservationItems({ inventory_item_id: v.itemId })).toHaveLength(0)
  const item = await inventory.retrieveInventoryItem(v.itemId, { relations: ["location_levels"] })
  expect(item.location_levels[0].reserved_quantity).toBe(0)
  await db("order").where({ id: order.id }).update({ status: "canceled", canceled_at: new Date() })
  const results = await Promise.all([1, 2].map(() => releaseAllocationsForOrder({ db, orderId: order.id, reason: "released_cancellation" })))
  expect(results.reduce((a, b) => a + b, 0)).toBe(1)
  expect(await db("gp_inventory_allocation_audit").where({ event_type: "released" })).toHaveLength(1)
  expect((await createAllocationsForOrder({ db, query, orderId: order.id })).created).toBe(0)
  expect(await available(v)).toMatchObject({ decision: "available", available_to_promise_quantity: 1 })
})

it("preserves decimal component quantities in native reservations and advisory overlap", async () => {
  const v = await fixture(0.3, 0.1); const order = await orderFor(v)
  await reserve(v, order.line)
  await createAllocationsForOrder({ db, query, orderId: order.id })
  expect(await available(v)).toMatchObject({ decision: "available", allocated_quantity: 0, available_to_promise_quantity: 2 })
  expect((await inventory.listReservationItems({ inventory_item_id: v.itemId }))[0].quantity).toBe(0.1)
})

it.each([guardNativeCartInventory, guardNativePaymentInventory])("refuses unmanaged native checkout/payment endpoints before their provider handler", async guard => {
  const v = await fixture(10); variants.get(v.id).manage_inventory = false
  carts.set("cart", { id: "cart", metadata: { scheduledDate: "2099-01-01" }, items: [{ id: "line", variant_id: v.id, quantity: 1 }] })
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn()
  await guard({ scope: scope(), params: { id: "cart" }, body: {} } as any, res, next)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(next).not.toHaveBeenCalled()
})
