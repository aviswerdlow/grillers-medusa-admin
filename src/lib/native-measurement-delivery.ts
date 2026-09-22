import { randomUUID } from "node:crypto"
import type { DeliveryResult } from "./order-publication"

export async function deliverNativeMeasurements<S, T extends string>(
  db: any,
  config: {
    source: string
    targets: readonly T[]
    parse: (row: any) => S | null
    hashKey: string
    lockPrefix: string
    errorPrefix: string
    productionPending: (snapshot: S) => boolean
  },
  deliver: (
    target: T,
    snapshot: S,
    row: any,
    trx: any
  ) => Promise<DeliveryResult>,
  now = new Date(),
  limit = 5
) {
  const targetSql = config.targets.map(() => "?").join(",")
  const rows = await db("gp_communication_event as e")
    .where("e.source", config.source)
    .whereNull("e.deleted_at")
    .whereRaw(
      `(select count(*) from gp_event_delivery d where d.event_id = e.event_id and d.deleted_at is null and d.status in ('delivered','skipped') and d.target in (${targetSql})) < ${config.targets.length}`,
      [...config.targets]
    )
    .orderByRaw(
      `coalesce((select max(d.last_attempt_at) from gp_event_delivery d where d.event_id=e.event_id and d.deleted_at is null and d.target in (${targetSql})), e.created_at) asc`,
      [...config.targets]
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
        [`${config.lockPrefix}:${row.event_id}`]
      )
      if (!lock.rows[0].locked) {
        result.busy++
        return
      }
      const snapshot = config.parse(row)
      for (const target of config.targets) {
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
            : { status: "held", reason: `${config.errorPrefix}_source_invalid` }
        } catch {
          outcome = {
            status: "held",
            reason: `${config.errorPrefix}_transport_failed`,
          }
          result.retry++
        }
        if (outcome.status === "accepted") result.accepted++
        else if (outcome.status === "excluded") result.excluded++
        else {
          result.held++
          if (snapshot && config.productionPending(snapshot))
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
          source_hash: row.context?.[config.hashKey],
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
