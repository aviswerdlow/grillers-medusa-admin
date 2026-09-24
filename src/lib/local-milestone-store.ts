import { randomUUID } from "node:crypto"
import type { StaffPrincipal } from "./staff-principal"
import {
  LocalMilestoneError, localMilestoneMode, milestoneRequestHash,
  parseMilestoneCommand, requireLocalRelease, requireTransition,
  type LocalMilestone, type LocalMilestoneMode, type MilestoneEventKind,
} from "./local-milestones"

export function isMilestoneOffice(actor: StaffPrincipal) {
  return actor.kind === "operator" || actor.capabilities.has("milestones.office")
}

export function requireMilestoneActor(actor: StaffPrincipal, capability: "milestones.drive" | "milestones.office" | "milestones.correct") {
  if (actor.kind === "service" || (actor.kind !== "operator" && !actor.capabilities.has(capability)))
    throw new LocalMilestoneError("local_milestone_access_denied", 403)
}

function requireCurrentAssignment(actor: StaffPrincipal, state: any, mode: LocalMilestoneMode, milestone: LocalMilestone) {
  if (isMilestoneOffice(actor)) return
  if (mode !== "local_delivery" || milestone === "local_returned" || state?.driver_customer_id !== actor.id)
    throw new LocalMilestoneError("local_milestone_order_not_assigned", 403)
}

async function currentState(trx: any, orderId: string, fulfillmentId: string, mode: LocalMilestoneMode) {
  let state = await trx("gp_local_milestone_state").where({ order_id: orderId }).first()
  if (!state) {
    state = { order_id: orderId, fulfillment_id: fulfillmentId,
      attempt_id: `gplma_${randomUUID()}`, mode, milestone: "packed", version: 0,
      current_event_id: null, driver_customer_id: null, updated_at: new Date() }
    await trx("gp_local_milestone_state").insert(state)
  }
  if (state.fulfillment_id !== fulfillmentId || state.mode !== mode)
    throw new LocalMilestoneError("local_milestone_order_changed")
  return state
}

export async function recordLocalMilestone(db: any, input: {
  orderId: string
  actor: StaffPrincipal
  kind: MilestoneEventKind
  body: unknown
  now?: Date
}) {
  requireMilestoneActor(input.actor, input.kind === "correction" ? "milestones.correct" : "milestones.drive")
  const command = parseMilestoneCommand(input.body, input.kind)
  const requestHash = milestoneRequestHash({ orderId: input.orderId, actorId: input.actor.id, kind: input.kind, ...command })
  return db.transaction(async (trx: any) => {
    // The order-scoped lock serializes assignment, completion and correction.
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [`gp-local-milestone:${input.orderId}`])
    const priorState = await trx("gp_local_milestone_state").where({ order_id: input.orderId }).first()
    if (!isMilestoneOffice(input.actor) && priorState?.driver_customer_id !== input.actor.id)
      throw new LocalMilestoneError("local_milestone_order_not_assigned", 403)
    const replay = await trx("gp_local_milestone_event").where({ event_id: command.eventId }).first()
    if (replay) {
      if (replay.order_id !== input.orderId || replay.request_hash !== requestHash)
        throw new LocalMilestoneError("local_milestone_idempotency_conflict")
      return { event: replay, duplicate: true }
    }
    const order = await trx("order").where({ id: input.orderId }).forUpdate().first()
    if (!order) throw new LocalMilestoneError("local_milestone_order_not_found", 404)
    const relation = await trx("order_fulfillment").where({ order_id: input.orderId, fulfillment_id: command.fulfillmentId }).first()
    if (!relation) throw new LocalMilestoneError("fulfillment_not_on_order", 422)
    const fulfillment = await trx("fulfillment").where({ id: command.fulfillmentId }).whereNull("canceled_at").whereNull("deleted_at").first()
    if (!fulfillment) throw new LocalMilestoneError("fulfillment_not_active", 422)
    const mode = localMilestoneMode(order)
    requireLocalRelease(order)
    const state = await currentState(trx, input.orderId, command.fulfillmentId, mode)
    requireCurrentAssignment(input.actor, state, mode, command.milestone)
    if (state.version !== command.expectedVersion)
      throw new LocalMilestoneError("local_milestone_version_changed")
    if (input.kind === "correction") {
      if (!isMilestoneOffice(input.actor) || state.current_event_id !== command.correctionOfEventId)
        throw new LocalMilestoneError("local_milestone_correction_not_current", 403)
    }
    requireTransition({ mode, from: state.milestone, to: command.milestone, kind: input.kind, reason: command.reason })
    const corrected = input.kind === "correction"
      ? await trx("gp_local_milestone_event").where({ event_id: command.correctionOfEventId, order_id: input.orderId }).first()
      : null
    if (input.kind === "correction" && !corrected)
      throw new LocalMilestoneError("local_milestone_correction_source_missing")
    const now = input.now || new Date()
    const event = { event_id: command.eventId, order_id: input.orderId,
      fulfillment_id: command.fulfillmentId, attempt_id: state.attempt_id,
      version: state.version + 1, kind: input.kind, previous_milestone: state.milestone,
      milestone: command.milestone, correction_of_event_id: command.correctionOfEventId,
      actor_id: input.actor.id, actor_role: input.actor.role, reason: command.reason,
      note: command.note, request_hash: requestHash,
      occurred_at: corrected?.occurred_at || now, recorded_at: now }
    await trx("gp_local_milestone_event").insert(event)
    await trx("gp_local_milestone_state").where({ order_id: input.orderId }).update({
      milestone: command.milestone, version: event.version,
      current_event_id: event.event_id, updated_at: now,
    })
    return { event, duplicate: false }
  })
}

export async function assignLocalDriver(db: any, input: {
  orderId: string
  fulfillmentId: string
  assignmentId: string
  driverCustomerId: string
  actor: StaffPrincipal
}) {
  requireMilestoneActor(input.actor, "milestones.office")
  const requestHash = milestoneRequestHash({ orderId: input.orderId, fulfillmentId: input.fulfillmentId,
    assignmentId: input.assignmentId, driverCustomerId: input.driverCustomerId, actorId: input.actor.id })
  return db.transaction(async (trx: any) => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [`gp-local-milestone:${input.orderId}`])
    const replay = await trx("gp_local_milestone_assignment").where({ assignment_id: input.assignmentId }).first()
    if (replay) {
      if (replay.order_id !== input.orderId || replay.request_hash !== requestHash)
        throw new LocalMilestoneError("local_assignment_idempotency_conflict")
      return { assignment: replay, duplicate: true }
    }
    const order = await trx("order").where({ id: input.orderId }).forUpdate().first()
    if (!order) throw new LocalMilestoneError("local_milestone_order_not_found", 404)
    const relation = await trx("order_fulfillment").where({ order_id: input.orderId, fulfillment_id: input.fulfillmentId }).first()
    if (!relation) throw new LocalMilestoneError("fulfillment_not_on_order", 422)
    const fulfillment = await trx("fulfillment").where({ id: input.fulfillmentId }).whereNull("canceled_at").whereNull("deleted_at").first()
    if (!fulfillment) throw new LocalMilestoneError("fulfillment_not_active", 422)
    if (localMilestoneMode(order) !== "local_delivery") throw new LocalMilestoneError("driver_assignment_requires_local_delivery", 422)
    requireLocalRelease(order)
    const state = await currentState(trx, input.orderId, input.fulfillmentId, "local_delivery")
    const prior = await trx("gp_local_milestone_assignment").where({ order_id: input.orderId }).orderBy("assigned_at", "desc").first()
    const assignment = { assignment_id: input.assignmentId, order_id: input.orderId,
      fulfillment_id: input.fulfillmentId, driver_customer_id: input.driverCustomerId,
      assigned_by: input.actor.id, request_hash: requestHash,
      assigned_at: new Date(), replaces_assignment_id: prior?.assignment_id || null }
    await trx("gp_local_milestone_assignment").insert(assignment)
    await trx("gp_local_milestone_state").where({ order_id: input.orderId }).update({
      driver_customer_id: input.driverCustomerId, updated_at: assignment.assigned_at,
    })
    return { assignment, duplicate: false, state }
  })
}

export async function readLocalOrder(db: any, orderId: string, actor: StaffPrincipal) {
  requireMilestoneActor(actor, "milestones.drive")
  const state = await db("gp_local_milestone_state").where({ order_id: orderId }).first()
  if (!state) throw new LocalMilestoneError("local_milestone_order_not_found", 404)
  if (!isMilestoneOffice(actor) && state.driver_customer_id !== actor.id)
    throw new LocalMilestoneError("local_milestone_order_not_assigned", 403)
  const events = await db("gp_local_milestone_event").where({ order_id: orderId }).orderBy("version", "asc")
  return { state, events }
}

export async function listLocalOrders(db: any, actor: StaffPrincipal, exceptionsOnly = false) {
  requireMilestoneActor(actor, exceptionsOnly ? "milestones.office" : "milestones.drive")
  let query = db("gp_local_milestone_state").orderBy("updated_at", "desc").limit(100)
  if (!isMilestoneOffice(actor)) query = query.where({ driver_customer_id: actor.id })
  if (exceptionsOnly) query = query.whereIn("milestone", ["local_failed", "local_returned"])
  else query = query.whereNotIn("milestone", ["pickup_collected", "local_delivered", "local_returned"])
  return query
}
