import { randomUUID } from "node:crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { recordCommunicationEvent, sendTrackedEmail } from "./communications/core"
import { emitOpsAlert } from "./ops-alert"
import {
  buildLocalMilestoneEmail, localNoticeDestinationHash,
  localNoticePolicy, localOrderSmsPermission,
  type LocalNoticePolicy, type NoticeMilestone,
} from "./local-milestone-notice-policy"

type Db = any
type NoticeChannel = "email" | "sms" | "office"
type EventRow = { event_id: string; order_id: string; milestone: string; kind: string;
  recorded_at: Date; display_id: number | null; email: string | null; customer_id: string | null;
  metadata: Record<string, any> | null }

async function pendingEvents(db: Db, channel: NoticeChannel, milestones: string[], startAt?: string) {
  if (!milestones.length) return [] as EventRow[]
  const now = new Date()
  const query = db("gp_local_milestone_event as event")
    .join("order as ord", "ord.id", "event.order_id")
    .leftJoin("gp_local_milestone_notice as notice", function(this: any) {
      this.on("notice.event_id", "=", "event.event_id").andOn("notice.channel", "=", db.raw("?", [channel]))
    })
    .whereIn("event.milestone", milestones)
    .where(function(this: any) {
      this.whereNull("notice.id").orWhere(function(this: any) {
        this.where("notice.status", "deferred").where("notice.defer_until", "<=", now)
      })
    })
    .orderBy("event.recorded_at", "asc")
    .limit(100)
    .select("event.event_id", "event.order_id", "event.milestone", "event.kind", "event.recorded_at",
      "ord.display_id", "ord.email", "ord.customer_id", "ord.metadata")
  // A corrected or superseded event must not create a stale customer notice.
  // Office alerts still see historical failures and corrections.
  if (channel !== "office") query.join("gp_local_milestone_state as state", "state.order_id", "event.order_id")
    .whereColumn("state.current_event_id", "event.event_id")
  if (startAt) query.where("event.recorded_at", ">=", startAt)
  if (channel === "office") query.where(function(this: any) {
    this.where("event.milestone", "local_failed").orWhere("event.kind", "correction")
  })
  return query as Promise<EventRow[]>
}

export async function claimLocalNotice(db: Db, input: { eventId: string; orderId: string; channel: NoticeChannel;
  destination: string; policyVersion?: string | null; now?: Date }) {
  const hash = localNoticeDestinationHash(input.channel, input.destination)
  const now = input.now || new Date()
  return db.transaction(async (trx: Db) => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [`gp-local-notice:${input.eventId}:${input.channel}:${hash}`])
    const existing = await trx("gp_local_milestone_notice")
      .where({ event_id: input.eventId, channel: input.channel, destination_hash: hash }).first()
    if (existing && (existing.status !== "deferred" || new Date(existing.defer_until).getTime() > now.getTime()))
      return { claimed: false, row: existing }
    if (existing) {
      await trx("gp_local_milestone_notice").where({ id: existing.id }).update({
        status: "attempting", attempted_at: now, updated_at: now, defer_until: null,
      })
      return { claimed: true, row: { ...existing, status: "attempting" } }
    }
    const row = { id: `gplnotice_${randomUUID()}`, event_id: input.eventId, order_id: input.orderId,
      channel: input.channel, destination_hash: hash, policy_version: input.policyVersion || null,
      status: "attempting", attempted_at: now, created_at: now, updated_at: now }
    await trx("gp_local_milestone_notice").insert(row)
    return { claimed: true, row }
  })
}

async function finishNotice(db: Db, id: string, status: string, fields: Record<string, unknown> = {}) {
  await db("gp_local_milestone_notice").where({ id }).update({ status, ...fields, updated_at: new Date() })
}

async function alertReconciliation(event: EventRow, reason: string) {
  await emitOpsAlert({
    alertKind: "local_milestone_notice_reconciliation",
    severity: "page", title: "Local milestone notice needs provider reconciliation",
    path: "src/lib/local-milestone-notices.ts", eventId: event.event_id,
    fingerprint: `local_milestone_notice:${event.event_id}`,
    meta: { order_id: event.order_id, milestone: event.milestone, reason },
  })
}

export async function sendEmailNotice(container: MedusaContainer, db: Db, event: EventRow, policy: LocalNoticePolicy) {
  const recipient = String(event.email || "").trim().toLowerCase()
  const claim = await claimLocalNotice(db, { eventId: event.event_id, orderId: event.order_id,
    channel: "email", destination: recipient || "missing", policyVersion: policy.version })
  if (!claim.claimed) return "duplicate"
  if (!recipient) {
    await finishNotice(db, claim.row.id, "suppressed", { reason: "missing_accepted_order_email" })
    return "suppressed"
  }
  try {
    const content = buildLocalMilestoneEmail({ milestone: event.milestone as NoticeMilestone,
      orderId: event.order_id, displayId: event.display_id, correction: event.kind === "correction" })
    const result = await sendTrackedEmail(container, {
      to: recipient, medusa_customer_id: event.customer_id || undefined,
      stream: "transactional", purpose: "transactional", topic: "order_updates",
      template_key: `local-${event.milestone}`,
      idempotency_key: `local-milestone:${event.event_id}:email:${claim.row.destination_hash}`,
      order_id: event.order_id, ...content,
      metadata: { local_milestone_event_id: event.event_id, local_notice_policy: policy.version },
    })
    if (result.deferred) {
      await finishNotice(db, claim.row.id, "deferred", { reason: result.error || "observance_blackout",
        defer_until: result.deferUntil || new Date(Date.now() + 60 * 60 * 1000) })
      return "deferred"
    }
    if (result.ok) {
      await finishNotice(db, claim.row.id, result.skipped && !result.messageId ? "suppressed" : "sent",
        { message_id: result.messageId || null, reason: result.skipped && !result.messageId ? "communications_suppressed" : null })
      return result.skipped ? "suppressed" : "sent"
    }
    await finishNotice(db, claim.row.id, "needs_reconciliation", { reason: result.error || "provider_outcome_uncertain" })
    await alertReconciliation(event, result.error || "provider_outcome_uncertain")
    return "needs_reconciliation"
  } catch (error) {
    const reason = error instanceof Error ? error.message : "provider_outcome_uncertain"
    await finishNotice(db, claim.row.id, "needs_reconciliation", { reason: reason.slice(0, 200) })
    await alertReconciliation(event, reason.slice(0, 200))
    return "needs_reconciliation"
  }
}

async function suppressLocalSms(container: MedusaContainer, db: Db, event: EventRow, policy: LocalNoticePolicy) {
  const permission = localOrderSmsPermission(event.metadata)
  const claim = await claimLocalNotice(db, { eventId: event.event_id, orderId: event.order_id,
    channel: "sms", destination: event.order_id, policyVersion: policy.version })
  if (!claim.claimed) return "duplicate"
  const reason = permission.allowed ? "local_sms_sender_not_approved" : permission.reason
  await finishNotice(db, claim.row.id, "suppressed", { reason })
  await recordCommunicationEvent(container.resolve(ContainerRegistrationKeys.PG_CONNECTION), {
    event_name: "transactional_sms_suppressed", order_id: event.order_id,
    template_key: `local-${event.milestone}`,
    properties: { event_id: event.event_id, channel: "sms", reason, policy_version: policy.version },
  })
  return "suppressed"
}

export async function alertOfficeException(db: Db, event: EventRow) {
  const claim = await claimLocalNotice(db, { eventId: event.event_id, orderId: event.order_id,
    channel: "office", destination: "local_milestone_exception_queue" })
  if (!claim.claimed) return "duplicate"
  const result = await emitOpsAlert({ alertKind: "local_milestone_office_exception",
    severity: "page", title: "Local milestone needs office review",
    path: "src/lib/local-milestone-notices.ts", eventId: event.event_id,
    fingerprint: `local_milestone_exception:${event.event_id}`,
    meta: { order_id: event.order_id, milestone: event.milestone, correction: event.kind === "correction" } })
  await finishNotice(db, claim.row.id, result.ok ? "alerted" : "needs_reconciliation",
    result.ok ? {} : { reason: "office_alert_sink_unavailable" })
  return result.ok ? "alerted" : "needs_reconciliation"
}

async function reconcileStaleAttempts(db: Db) {
  const stale = await db("gp_local_milestone_notice")
    .where({ status: "attempting" }).where("attempted_at", "<", new Date(Date.now() - 5 * 60 * 1000)).limit(100)
  for (const row of stale) {
    await finishNotice(db, row.id, "needs_reconciliation", { reason: "attempt_interrupted" })
    await emitOpsAlert({ alertKind: "local_milestone_notice_reconciliation", severity: "page",
      title: "Local milestone notice attempt interrupted", path: "src/lib/local-milestone-notices.ts",
      eventId: row.event_id, fingerprint: `local_milestone_notice:${row.event_id}`,
      meta: { order_id: row.order_id, channel: row.channel, reason: "attempt_interrupted" } })
  }
}

export async function runLocalMilestoneNotices(container: MedusaContainer) {
  if (process.env.GP_LOCAL_MILESTONES_ENABLED !== "true") return { enabled: false, processed: 0 }
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const policy = localNoticePolicy()
  await reconcileStaleAttempts(db)
  let processed = 0
  for (const event of await pendingEvents(db, "office", ["pickup_ready", "pickup_collected", "local_dispatched", "local_delivered", "local_failed", "local_returned"])) {
    if (event.milestone !== "local_failed" && event.kind !== "correction") continue
    await alertOfficeException(db, event)
    processed++
  }
  if (!policy) return { enabled: true, policyHeld: true, processed }
  for (const event of await pendingEvents(db, "email", policy.email, policy.startAt)) {
    await sendEmailNotice(container, db, event, policy)
    processed++
  }
  for (const event of await pendingEvents(db, "sms", policy.sms, policy.startAt)) {
    await suppressLocalSms(container, db, event, policy)
    processed++
  }
  return { enabled: true, policyHeld: false, processed }
}
