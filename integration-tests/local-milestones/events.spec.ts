import { applyMigration, withMigrationFixture } from "../migration-fixture"
import { Migration20260924210000 } from "../../src/modules/gp-catch-weight/migrations/Migration20260924210000"
import { assignLocalDriver, listLocalOrders, readLocalOrder, recordLocalMilestone } from "../../src/lib/local-milestone-store"
import { staffCapabilities } from "../../src/lib/staff-access-policy"
import type { StaffPrincipal } from "../../src/lib/staff-principal"

const office: StaffPrincipal = { id: "cus_office", kind: "customer", role: "office", email: null,
  name: "Office", capabilities: staffCapabilities({ id: "cus_office", metadata: { gp_staff_role: "office" } }),
  transport_id: "test", auth: {} }
const driver: StaffPrincipal = { id: "cus_driver", kind: "customer", role: "driver", email: null,
  name: "Driver", capabilities: staffCapabilities({ id: "cus_driver", metadata: { gp_staff_role: "driver" } }),
  transport_id: "test", auth: {} }
const release = { payment_workflow: "setup_then_final_charge", final_charge_status: "succeeded",
  fulfillment_gate_status: "released", finalization_status: "charged_ready_to_ship" }

async function nativeFixture(db: any, mode: "plant_pickup" | "atlanta_delivery") {
  await db.raw('create table "order" (id text primary key, display_id integer, shipping_address_id text, status text, canceled_at timestamptz, deleted_at timestamptz, is_draft_order boolean, metadata jsonb)')
  await db.raw('create table order_address (id text primary key, first_name text, last_name text, address_1 text, address_2 text, city text, province text, postal_code text, phone text)')
  await db.raw('create table fulfillment (id text primary key, canceled_at timestamptz, deleted_at timestamptz)')
  await db.raw('create table order_fulfillment (order_id text, fulfillment_id text)')
  await applyMigration(db, Migration20260924210000)
  await db("order").insert({ id: "order_fixture", display_id: 367, shipping_address_id: "addr_fixture", status: "pending", is_draft_order: false,
    metadata: JSON.stringify({ ...release, fulfillmentType: mode }) })
  await db("order_address").insert({ id: "addr_fixture", first_name: "Case", last_name: "Recipient",
    address_1: "10 Test St", city: "Atlanta", province: "GA", postal_code: "30301", phone: "4045550100" })
  await db("fulfillment").insert({ id: "ful_fixture" })
  await db("order_fulfillment").insert({ order_id: "order_fixture", fulfillment_id: "ful_fixture" })
}

const body = (eventId: string, milestone: string, version: number, rest = {}) =>
  ({ event_id: eventId, fulfillment_id: "ful_fixture", milestone, expected_version: version, ...rest })

const fixture = (run: (db: any) => Promise<void>) =>
  withMigrationFixture(process.env.LOCAL_MILESTONE_TEST_DATABASE_URL, run)

test("pickup completion, concurrent retry and correction preserve one immutable version chain", async () => {
  await fixture(async db => {
    await nativeFixture(db, "plant_pickup")
    const ready = await Promise.all([0, 1].map(() => recordLocalMilestone(db, { orderId: "order_fixture",
      actor: office, kind: "record", body: body("evt_ready_01", "pickup_ready", 0) })))
    expect(ready.map(row => row.duplicate).sort()).toEqual([false, true])
    expect(ready[0].event.version).toBe(1)
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: body("evt_collected_01", "pickup_collected", 1) })
    const corrected = await recordLocalMilestone(db, { orderId: "order_fixture", actor: office,
      kind: "correction", body: body("evt_correct_01", "pickup_ready", 2,
        { correction_of_event_id: "evt_collected_01", reason: "Collection was recorded in error" }) })
    expect(corrected.event.version).toBe(3)
    expect(corrected.event.correction_of_event_id).toBe("evt_collected_01")
    const events = await db("gp_local_milestone_event").orderBy("version", "asc")
    expect(events).toHaveLength(3)
    expect(events.map((row: any) => row.version)).toEqual([1, 2, 3])
    expect(new Date(events[2].occurred_at).toISOString()).toBe(new Date(events[1].occurred_at).toISOString())
    await expect(db("gp_local_milestone_event").where({ event_id: "evt_ready_01" }).delete())
      .rejects.toThrow(/history is immutable/)
    await expect(db("gp_local_milestone_event").where({ event_id: "evt_ready_01" }).update({ note: "rewritten" }))
      .rejects.toThrow(/history is immutable/)
  })
})

test("pickup readiness precedes native fulfillment but collection requires that handoff", async () => {
  await fixture(async db => {
    await nativeFixture(db, "plant_pickup")
    await db("order_fulfillment").delete()
    await db("fulfillment").delete()
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: { event_id: "evt_ready_before_handoff", milestone: "pickup_ready", expected_version: 0 } })
    const state = await db("gp_local_milestone_state").first()
    expect(state.fulfillment_id).toBeNull()
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: body("evt_collected_before_handoff", "pickup_collected", 1) })).rejects.toThrow("fulfillment_not_on_order")
    await db("fulfillment").insert({ id: "ful_fixture" })
    await db("order_fulfillment").insert({ order_id: "order_fixture", fulfillment_id: "ful_fixture" })
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: body("evt_collected_after_handoff", "pickup_collected", 1) })
    expect((await db("gp_local_milestone_state").first()).fulfillment_id).toBe("ful_fixture")
  })
})

test("local driver cannot bypass release, assignment or failed-delivery office handoff", async () => {
  await fixture(async db => {
    await nativeFixture(db, "atlanta_delivery")
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: body("evt_leave_01", "local_dispatched", 0) })).rejects.toThrow("local_milestone_order_not_assigned")
    await assignLocalDriver(db, { orderId: "order_fixture", fulfillmentId: "ful_fixture",
      assignmentId: "assignment_01", driverCustomerId: driver.id, actor: office })
    await db("order").where({ id: "order_fixture" }).update({ metadata: JSON.stringify({ ...release,
      fulfillmentType: "atlanta_delivery", final_charge_status: "failed" }) })
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: body("evt_leave_01", "local_dispatched", 0) })).rejects.toThrow("payment_not_complete")
    await db("order").where({ id: "order_fixture" }).update({ metadata: JSON.stringify({ ...release,
      fulfillmentType: "atlanta_delivery" }) })
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: body("evt_leave_01", "local_dispatched", 0) })
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: body("evt_failed_01", "local_failed", 1, { reason: "Customer unavailable" }) })
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: body("evt_return_01", "local_returned", 2, { reason: "Back at office" }) })).rejects.toThrow("local_milestone_order_not_assigned")
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: body("evt_return_01", "local_returned", 2, { reason: "Back at office" }) })
    expect((await db("gp_local_milestone_state").where({ order_id: "order_fixture" }).first()).milestone).toBe("local_returned")
  })
})

test("the assigned driver sees the delivery address but no other order", async () => {
  await fixture(async db => {
    await nativeFixture(db, "atlanta_delivery")
    await assignLocalDriver(db, { orderId: "order_fixture", fulfillmentId: "ful_fixture",
      assignmentId: "assignment_summary_01", driverCustomerId: driver.id, actor: office })
    const visible = await listLocalOrders(db, driver)
    expect(visible).toHaveLength(1)
    expect(visible[0].summary).toMatchObject({ display_id: 367, recipient: "Case Recipient", address_1: "10 Test St" })
    expect((await readLocalOrder(db, "order_fixture", driver)).state.summary.phone).toBe("4045550100")
    const other: StaffPrincipal = { ...driver, id: "cus_other" }
    expect(await listLocalOrders(db, other)).toHaveLength(0)
    await expect(readLocalOrder(db, "order_fixture", other)).rejects.toThrow("local_milestone_order_not_assigned")
  })
})
