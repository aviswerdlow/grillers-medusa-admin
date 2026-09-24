import { createHash } from "node:crypto"
import {
  FINALIZATION_CHARGED_READY_TO_SHIP,
  FINALIZATION_RELEASED_TO_FULFILLMENT,
  PAYMENT_WORKFLOW_INVOICE_AR,
  PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE,
} from "./catch-weight-finalization"

export type LocalMilestoneMode = "pickup" | "local_delivery"
export type LocalMilestone = "packed" | "pickup_ready" | "pickup_collected" |
  "local_dispatched" | "local_delivered" | "local_failed" | "local_returned"
export type MilestoneEventKind = "record" | "correction"

export class LocalMilestoneError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}

export function localMilestonesEnabled() {
  return process.env.GP_LOCAL_MILESTONES_ENABLED === "true"
}

export function requireLocalMilestonesEnabled() {
  if (!localMilestonesEnabled()) throw new LocalMilestoneError("local_milestones_disabled", 404)
}

export function localMilestoneMode(order: Record<string, any>): LocalMilestoneMode {
  const metadata = objectMetadata(order.metadata)
  const type = metadata.fulfillmentType || metadata.fulfillment_type
  if (type === "plant_pickup" || type === "southeast_pickup") return "pickup"
  if (type === "local_delivery" || type === "atlanta_delivery") return "local_delivery"
  throw new LocalMilestoneError("not_a_local_or_pickup_order", 422)
}

export function objectMetadata(value: unknown): Record<string, any> {
  if (value === null || value === undefined) return {}
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { throw new LocalMilestoneError("order_metadata_unavailable", 503) }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalMilestoneError("order_metadata_unavailable", 503)
  return value as Record<string, any>
}

/** A local milestone never releases an order. It consumes the existing release. */
export function requireLocalRelease(order: Record<string, any>) {
  const metadata = objectMetadata(order.metadata)
  if (order.status === "canceled" || order.canceled_at || order.deleted_at || order.is_draft_order ||
    metadata.fulfillment_hold?.held === true)
    throw new LocalMilestoneError("order_release_held")
  if (metadata.fulfillment_gate_status !== "released" ||
    ![FINALIZATION_CHARGED_READY_TO_SHIP, FINALIZATION_RELEASED_TO_FULFILLMENT].includes(metadata.finalization_status))
    throw new LocalMilestoneError("order_not_finalized_for_release")
  if (metadata.payment_workflow === PAYMENT_WORKFLOW_SETUP_THEN_FINAL_CHARGE) {
    if (metadata.final_charge_status !== "succeeded") throw new LocalMilestoneError("payment_not_complete")
  } else if (metadata.payment_workflow === PAYMENT_WORKFLOW_INVOICE_AR) {
    if (metadata.final_charge_status !== "not_applicable_invoice" ||
      metadata.finalization_status !== FINALIZATION_RELEASED_TO_FULFILLMENT)
      throw new LocalMilestoneError("invoice_release_not_complete")
  } else {
    // Unknown or legacy payment modes require an office review before use.
    throw new LocalMilestoneError("payment_workflow_unverified")
  }
}

const forward: Record<LocalMilestone, LocalMilestone[]> = {
  packed: ["pickup_ready", "local_dispatched"],
  pickup_ready: ["pickup_collected"],
  pickup_collected: [],
  local_dispatched: ["local_delivered", "local_failed"],
  local_delivered: [],
  local_failed: ["local_returned"],
  local_returned: [],
}

const correction: Record<LocalMilestone, LocalMilestone[]> = {
  packed: [],
  pickup_ready: ["pickup_collected"],
  pickup_collected: ["pickup_ready"],
  local_dispatched: ["local_delivered", "local_failed"],
  local_delivered: ["local_dispatched", "local_failed"],
  local_failed: ["local_dispatched", "local_delivered", "local_returned"],
  local_returned: ["local_failed", "local_delivered"],
}

export function requireTransition(input: {
  mode: LocalMilestoneMode
  from: LocalMilestone
  to: LocalMilestone
  kind: MilestoneEventKind
  reason?: string | null
}) {
  const validForMode = input.mode === "pickup"
    ? input.to.startsWith("pickup_")
    : input.to.startsWith("local_")
  if (!validForMode || !(input.kind === "record" ? forward : correction)[input.from]?.includes(input.to))
    throw new LocalMilestoneError("invalid_local_milestone_transition")
  if ((input.kind === "correction" || ["local_failed", "local_returned"].includes(input.to)) &&
    !String(input.reason || "").trim())
    throw new LocalMilestoneError("milestone_reason_required", 422)
}

export function parseMilestoneCommand(value: unknown, kind: MilestoneEventKind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalMilestoneError("invalid_milestone_command", 400)
  const body = value as Record<string, unknown>
  const eventId = body.event_id, fulfillmentId = body.fulfillment_id
  const milestone = body.milestone, expectedVersion = body.expected_version
  const correctionOfEventId = body.correction_of_event_id
  const token = (item: unknown) => typeof item === "string" && /^[a-zA-Z0-9_:-]{8,128}$/.test(item)
  if (!token(eventId) || !token(fulfillmentId) || !Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0 ||
    !["pickup_ready", "pickup_collected", "local_dispatched", "local_delivered", "local_failed", "local_returned"].includes(String(milestone)) ||
    (kind === "correction" ? !token(correctionOfEventId) : correctionOfEventId !== undefined))
    throw new LocalMilestoneError("invalid_milestone_command", 400)
  const note = body.note === undefined ? null : body.note
  const reason = body.reason === undefined ? null : body.reason
  if ((note !== null && (typeof note !== "string" || note.length > 500)) ||
    (reason !== null && (typeof reason !== "string" || reason.length > 500)))
    throw new LocalMilestoneError("invalid_milestone_command", 400)
  return { eventId: eventId as string, fulfillmentId: fulfillmentId as string,
    milestone: milestone as LocalMilestone, expectedVersion: expectedVersion as number,
    correctionOfEventId: kind === "correction" ? correctionOfEventId as string : null,
    note: note as string | null, reason: reason as string | null }
}

export function milestoneRequestHash(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}
