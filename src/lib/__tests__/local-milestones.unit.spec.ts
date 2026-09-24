import { adminRouteCapability } from "../staff-route-capabilities"
import { staffCapabilities, staffRole } from "../staff-access-policy"
import { type StaffPrincipal } from "../staff-principal"
import { LocalMilestoneError, localMilestoneMode, localMilestonesEnabled, parseMilestoneCommand,
  requireLocalRelease, requireTransition } from "../local-milestones"
import { assignLocalDriver, recordLocalMilestone } from "../local-milestone-store"

const release = { payment_workflow: "setup_then_final_charge", final_charge_status: "succeeded",
  finalization_status: "charged_ready_to_ship", fulfillment_gate_status: "released" }
const office: StaffPrincipal = { id: "cus_office", kind: "customer", email: null, name: "Office",
  role: "office", capabilities: staffCapabilities({ id: "cus_office", metadata: { gp_staff_role: "office" } }),
  transport_id: "key", auth: {} }
const driver: StaffPrincipal = { id: "cus_driver", kind: "customer", email: null, name: "Driver",
  role: "driver", capabilities: staffCapabilities({ id: "cus_driver", metadata: { gp_staff_role: "driver" } }),
  transport_id: "key", auth: {} }

type Tables = Record<string, Record<string, any>[]>
function fakeDb(mode: "plant_pickup" | "atlanta_delivery" = "plant_pickup", metadata = release) {
  const tables: Tables = {
    order: [{ id: "order_fixture", status: "pending", metadata: { ...metadata, fulfillmentType: mode } }],
    order_fulfillment: [{ order_id: "order_fixture", fulfillment_id: "ful_fixture" }],
    fulfillment: [{ id: "ful_fixture", canceled_at: null }],
    gp_local_milestone_state: [], gp_local_milestone_event: [], gp_local_milestone_assignment: [],
  }
  const db: any = (table: string) => {
    let matches: Record<string, any> = {}, nullKeys: string[] = [], sort: { key: string; dir: string } | null = null
    const selected = () => {
      let rows = tables[table].filter(row => Object.entries(matches).every(([key, value]) => row[key] === value)
        && nullKeys.every(key => row[key] == null))
      if (sort) rows = [...rows].sort((a, b) => String(a[sort!.key]).localeCompare(String(b[sort!.key])) * (sort!.dir === "desc" ? -1 : 1))
      return rows
    }
    const query: any = {
      where(value: Record<string, any>) { matches = { ...matches, ...value }; return query },
      whereNull(key: string) { nullKeys.push(key); return query },
      forUpdate() { return query },
      orderBy(key: string, dir: string) { sort = { key, dir }; return query },
      async first() { return selected()[0] },
      async insert(value: Record<string, any>) { tables[table].push({ ...value }) },
      async update(value: Record<string, any>) { for (const row of selected()) Object.assign(row, value) },
    }
    return query
  }
  db.raw = jest.fn(async () => ({}))
  db.transaction = async (run: (transaction: any) => Promise<any>) => {
    const before = structuredClone(tables)
    try { return await run(db) } catch (error) {
      for (const key of Object.keys(before)) tables[key] = before[key]
      throw error
    }
  }
  return { db, tables }
}

function command(eventId: string, milestone: string, expectedVersion: number, extra = {}) {
  return { event_id: eventId, fulfillment_id: "ful_fixture", milestone, expected_version: expectedVersion, ...extra }
}

describe("#367 server milestone contract", () => {
  it("stays off unless the exact launch flag is enabled", () => {
    const prior = process.env.GP_LOCAL_MILESTONES_ENABLED
    try {
      delete process.env.GP_LOCAL_MILESTONES_ENABLED
      expect(localMilestonesEnabled()).toBe(false)
      process.env.GP_LOCAL_MILESTONES_ENABLED = "false"
      expect(localMilestonesEnabled()).toBe(false)
      process.env.GP_LOCAL_MILESTONES_ENABLED = "true"
      expect(localMilestonesEnabled()).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.GP_LOCAL_MILESTONES_ENABLED
      else process.env.GP_LOCAL_MILESTONES_ENABLED = prior
    }
  })

  it("keeps driver authority narrow on the #318 boundary", () => {
    expect(staffRole({ metadata: { gp_staff_role: "driver" } })).toBe("driver")
    expect([...driver.capabilities]).toEqual(["milestones.drive"])
    expect(driver.capabilities.has("orders.read")).toBe(false)
    expect(office.capabilities.has("milestones.correct")).toBe(true)
    expect(adminRouteCapability("/admin/grillers/local-milestones/orders/order_1/events", "POST")).toBe("milestones.drive")
    expect(adminRouteCapability("/admin/grillers/local-milestones/orders/order_1/corrections", "POST")).toBe("milestones.correct")
    expect(adminRouteCapability("/admin/grillers/local-milestones/orders/order_1/assign", "POST")).toBe("milestones.office")
    expect(adminRouteCapability("/admin/orders/order_1", "GET")).toBe("orders.read")
  })

  it("requires verified release and known local mode", () => {
    expect(localMilestoneMode({ metadata: { fulfillmentType: "southeast_pickup" } })).toBe("pickup")
    expect(localMilestoneMode({ metadata: { fulfillmentType: "atlanta_delivery" } })).toBe("local_delivery")
    expect(() => localMilestoneMode({ metadata: { fulfillmentType: "ups_shipping" } })).toThrow("not_a_local_or_pickup_order")
    for (const change of [{ final_charge_status: "failed" }, { fulfillment_gate_status: "blocked_until_final_charge" },
      { finalization_status: "packed_pending_charge" }, { payment_workflow: "unknown" }]) {
      expect(() => requireLocalRelease({ metadata: { ...release, ...change } })).toThrow(LocalMilestoneError)
    }
    expect(() => requireLocalRelease({ metadata: { payment_workflow: "invoice_ar", final_charge_status: "not_applicable_invoice",
      finalization_status: "released_to_fulfillment", fulfillment_gate_status: "released" } })).not.toThrow()
  })

  it("allows only the ordered pickup and local paths, with reasons for exceptions", () => {
    const valid = [
      ["pickup", "packed", "pickup_ready"], ["pickup", "pickup_ready", "pickup_collected"],
      ["local_delivery", "packed", "local_dispatched"], ["local_delivery", "local_dispatched", "local_delivered"],
    ] as const
    for (const [mode, from, to] of valid) expect(() => requireTransition({ mode, from, to, kind: "record" })).not.toThrow()
    expect(() => requireTransition({ mode: "local_delivery", from: "packed", to: "local_delivered", kind: "record" })).toThrow()
    expect(() => requireTransition({ mode: "local_delivery", from: "local_dispatched", to: "local_failed", kind: "record" })).toThrow("milestone_reason_required")
    expect(() => requireTransition({ mode: "local_delivery", from: "local_failed", to: "local_returned", kind: "record", reason: "Returned to office" })).not.toThrow()
    expect(() => requireTransition({ mode: "local_delivery", from: "local_failed", to: "local_delivered", kind: "correction", reason: "Proof reviewed" })).not.toThrow()
  })

  it("rejects malformed or unversioned commands before storage", () => {
    expect(() => parseMilestoneCommand(command("evt_fixture_1", "pickup_ready", 0), "record")).not.toThrow()
    expect(() => parseMilestoneCommand(command("evt_fixture_1", "pickup_ready", -1), "record")).toThrow()
    expect(() => parseMilestoneCommand(command("evt_fixture_1", "pickup_ready", 0, { correction_of_event_id: "evt_fixture_0" }), "record")).toThrow()
  })

  it("records pickup once, rejects stale versions and preserves a correction's source time", async () => {
    const { db, tables } = fakeDb()
    const first = await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_1", "pickup_ready", 0), now: new Date("2026-09-24T12:00:00Z") })
    expect(first.duplicate).toBe(false)
    expect(first.event.version).toBe(1)
    const replay = await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_1", "pickup_ready", 0) })
    expect(replay.duplicate).toBe(true)
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_1", "pickup_collected", 1) })).rejects.toThrow("local_milestone_idempotency_conflict")
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_2", "pickup_collected", 0) })).rejects.toThrow("local_milestone_version_changed")
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_2", "pickup_collected", 1) })
    const corrected = await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "correction",
      body: command("evt_fixture_3", "pickup_ready", 2, { correction_of_event_id: "evt_fixture_2", reason: "Collection recorded in error" }),
      now: new Date("2026-09-24T13:00:00Z") })
    expect(corrected.event.version).toBe(3)
    expect(corrected.event.occurred_at).toEqual(tables.gp_local_milestone_event[1].occurred_at)
    expect(corrected.event.recorded_at).toEqual(new Date("2026-09-24T13:00:00Z"))
    expect(tables.gp_local_milestone_event).toHaveLength(3)
  })

  it("blocks a held order and a driver not assigned to that order", async () => {
    const held = fakeDb("atlanta_delivery", { ...release, final_charge_status: "failed" })
    await expect(recordLocalMilestone(held.db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_4", "local_dispatched", 0) })).rejects.toThrow("payment_not_complete")
    expect(held.tables.gp_local_milestone_event).toHaveLength(0)
    const assigned = fakeDb("atlanta_delivery")
    assigned.tables.gp_local_milestone_state.push({ order_id: "order_fixture", fulfillment_id: "ful_fixture",
      attempt_id: "attempt_1", mode: "local_delivery", milestone: "packed", version: 0,
      current_event_id: null, driver_customer_id: "cus_other" })
    await expect(recordLocalMilestone(assigned.db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: command("evt_fixture_5", "local_dispatched", 0) })).rejects.toThrow("local_milestone_order_not_assigned")
    expect(assigned.tables.gp_local_milestone_event).toHaveLength(0)
  })

  it("retains assignment history and keeps failed delivery on the office path", async () => {
    const { db, tables } = fakeDb("atlanta_delivery")
    const first = await assignLocalDriver(db, { orderId: "order_fixture", fulfillmentId: "ful_fixture",
      assignmentId: "assignment_1", driverCustomerId: driver.id, actor: office })
    expect(first.duplicate).toBe(false)
    expect((await assignLocalDriver(db, { orderId: "order_fixture", fulfillmentId: "ful_fixture",
      assignmentId: "assignment_1", driverCustomerId: driver.id, actor: office })).duplicate).toBe(true)
    await assignLocalDriver(db, { orderId: "order_fixture", fulfillmentId: "ful_fixture",
      assignmentId: "assignment_2", driverCustomerId: driver.id, actor: office })
    expect(tables.gp_local_milestone_assignment[1].replaces_assignment_id).toBe("assignment_1")
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: command("evt_fixture_6", "local_dispatched", 0) })
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: command("evt_fixture_7", "local_failed", 1, { reason: "Customer unavailable" }) })
    expect(tables.gp_local_milestone_state[0].milestone).toBe("local_failed")
    await expect(recordLocalMilestone(db, { orderId: "order_fixture", actor: driver, kind: "record",
      body: command("evt_fixture_8", "local_returned", 2, { reason: "Returned to office" }) })).rejects.toThrow("local_milestone_order_not_assigned")
    await recordLocalMilestone(db, { orderId: "order_fixture", actor: office, kind: "record",
      body: command("evt_fixture_8", "local_returned", 2, { reason: "Returned to office" }) })
    expect(tables.gp_local_milestone_state[0].milestone).toBe("local_returned")
    expect(tables.gp_local_milestone_event).toHaveLength(3)
  })
})
