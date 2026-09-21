import { randomUUID } from "node:crypto"
import { recordCommunicationEvent } from "./communications/core"
import {
  CUSTOMER_MEASUREMENT_SOURCE,
  customerSnapshotHash,
  validCustomerSnapshot,
  type CustomerMeasurementSnapshot,
} from "./analytics/customer-measurement-context"
import type { DeliveryResult } from "./order-publication"

export const CUSTOMER_TARGETS = [
  "native_customer_jitsu",
  "native_customer_gp",
  "native_customer_automation",
] as const
export type CustomerTarget = (typeof CUSTOMER_TARGETS)[number]

export async function saveCustomerMeasurement(
  db: any,
  snapshot: CustomerMeasurementSnapshot
) {
  if (!validCustomerSnapshot(snapshot))
    throw new Error("customer_measurement_source_invalid")
  await recordCommunicationEvent(
    db,
    {
      event_name: snapshot.event_name,
      event_id: snapshot.event_id,
      source: CUSTOMER_MEASUREMENT_SOURCE,
      medusa_customer_id: snapshot.customer_id,
      anonymous_id: snapshot.context.anonymous_id,
      session_id: snapshot.context.session_id,
      occurred_at: snapshot.occurred_at,
      properties: {
        ...snapshot.context,
        customer_id: snapshot.customer_id,
        test_event: snapshot.context.test_order,
        idempotency_key: snapshot.event_id,
        event_timestamp_ms: Date.parse(snapshot.occurred_at),
      },
      context: {
        native_customer_snapshot: snapshot,
        native_customer_hash: customerSnapshotHash(snapshot),
      },
    },
    { deferSideEffects: true }
  )
  // recordCommunicationEvent may race an insert; always use the actual winner.
  const saved = await db("gp_communication_event")
    .where({ event_id: snapshot.event_id })
    .whereNull("deleted_at")
    .first()
  if (
    saved?.source !== CUSTOMER_MEASUREMENT_SOURCE ||
    saved?.context?.native_customer_hash !== customerSnapshotHash(snapshot)
  )
    throw new Error("customer_measurement_source_conflict")
  return saved
}

export function customerSourceFromRow(
  row: any
): CustomerMeasurementSnapshot | null {
  const snapshot = row?.context?.native_customer_snapshot
  if (
    row?.source !== CUSTOMER_MEASUREMENT_SOURCE ||
    !validCustomerSnapshot(snapshot) ||
    row.event_id !== snapshot.event_id ||
    row.event_name !== snapshot.event_name ||
    row.context.native_customer_hash !== customerSnapshotHash(snapshot)
  )
    return null
  return snapshot
}

export async function deliverCustomerMeasurements(
  db: any,
  deliver: (
    target: CustomerTarget,
    snapshot: CustomerMeasurementSnapshot,
    row: any,
    trx: any
  ) => Promise<DeliveryResult>,
  now = new Date(),
  limit = 5
) {
  const targetSql = CUSTOMER_TARGETS.map(() => "?").join(",")
  const rows = await db("gp_communication_event as e")
    .where("e.source", CUSTOMER_MEASUREMENT_SOURCE)
    .whereNull("e.deleted_at")
    .whereRaw(
      `(select count(*) from gp_event_delivery d where d.event_id = e.event_id and d.deleted_at is null and d.status in ('delivered','skipped') and d.target in (${targetSql})) < 3`,
      [...CUSTOMER_TARGETS]
    )
    .orderByRaw(
      `coalesce((select max(d.last_attempt_at) from gp_event_delivery d where d.event_id=e.event_id and d.deleted_at is null and d.target in (${targetSql})), e.created_at) asc`,
      [...CUSTOMER_TARGETS]
    )
    .orderBy("e.event_id")
    .limit(Math.max(1, Math.min(limit, 20)))
  const result = {
    accepted: 0,
    excluded: 0,
    held: 0,
    retry: 0,
    busy: 0,
    production_pending: 0,
  }
  for (const row of rows) {
    await db.transaction(async (trx: any) => {
      // Nonblocking transaction lock: concurrent workers do not deliver the same
      // source together. Stable IDs survive the acknowledgment/commit crash gap.
      const lock = await trx.raw(
        "select pg_try_advisory_xact_lock(hashtextextended(?, 0)) as locked",
        [`gp-native-customer:${row.event_id}`]
      )
      if (!lock.rows[0].locked) {
        result.busy++
        return
      }
      const snapshot = customerSourceFromRow(row)
      for (const target of CUSTOMER_TARGETS) {
        const previous = await trx("gp_event_delivery")
          .where({ event_id: row.event_id, target })
          .whereNull("deleted_at")
          .first()
        if (["delivered", "skipped"].includes(previous?.status)) continue
        if (
          previous?.metadata?.next_attempt_at &&
          Date.parse(previous.metadata.next_attempt_at) > now.getTime()
        )
          continue
        let outcome: DeliveryResult
        try {
          outcome = snapshot
            ? await deliver(target, snapshot, row, trx)
            : { status: "held", reason: "customer_measurement_source_invalid" }
        } catch {
          outcome = {
            status: "held",
            reason: "customer_measurement_transport_failed",
          }
          result.retry++
        }
        if (outcome.status === "accepted") result.accepted++
        else if (outcome.status === "excluded") result.excluded++
        else {
          result.held++
          if (snapshot && !snapshot.context.test_order)
            result.production_pending++
        }
        const status =
          outcome.status === "accepted"
            ? "delivered"
            : outcome.status === "excluded"
            ? "skipped"
            : "failed"
        const metadata = {
          reason: "reason" in outcome ? outcome.reason : null,
          source_hash: row.context?.native_customer_hash,
          next_attempt_at:
            status === "failed"
              ? new Date(now.getTime() + 60_000).toISOString()
              : null,
        }
        await trx("gp_event_delivery")
          .insert({
            id: `gpedlv_${randomUUID()}`,
            event_id: row.event_id,
            event_name: row.event_name,
            target,
            status,
            attempts: 1,
            last_attempt_at: now,
            delivered_at: status === "delivered" ? now : null,
            error_message: metadata.reason,
            metadata,
            created_at: now,
            updated_at: now,
          })
          .onConflict(
            trx.raw('("event_id", "target") where "deleted_at" is null')
          )
          .merge({
            status,
            attempts: trx.raw("gp_event_delivery.attempts + 1"),
            last_attempt_at: now,
            delivered_at: status === "delivered" ? now : null,
            error_message: metadata.reason,
            metadata,
            updated_at: now,
          })
      }
    })
  }
  return result
}
