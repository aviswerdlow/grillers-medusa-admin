import { randomUUID } from "node:crypto"
import { QBD_OUTBOX_TABLE, QBD_OUTBOX_VERSION } from "./qbd-posting-outbox"

export type QbdOutboxEnvelope = {
  version: number
  id: string
  request_key: string
  depends_on_request_key: string | null
  sequence: string
  retry_generation: number
}

type DeliveryDependencies = {
  db: any
  post: (order: Record<string, any>, envelope: QbdOutboxEnvelope) => Promise<Response>
  normalize: (order: Record<string, any>) => Promise<Record<string, any>>
  limit?: number
  now?: () => Date
}

/** A timed lease allows another worker to recover after a crash without losing the action. */
async function claim(db: any, now: Date) {
  return db.transaction(async (trx: any) => {
    const row = await trx(QBD_OUTBOX_TABLE).where({ status: "pending" })
      .where("available_at", "<=", now)
      .where((builder: any) => builder.whereNull("leased_until").orWhere("leased_until", "<=", now))
      .orderBy("sequence").forUpdate().skipLocked().first()
    if (!row) return null
    const leaseId = randomUUID()
    await trx(QBD_OUTBOX_TABLE).where({ id: row.id }).update({
      lease_id: leaseId, leased_until: new Date(now.getTime() + 90_000),
      attempts: Number(row.attempts) + 1, updated_at: now,
    })
    return { ...row, lease_id: leaseId, attempts: Number(row.attempts) + 1 }
  })
}

export async function deliverQbdOutbox({ db, post, normalize, limit = 25, now = () => new Date() }: DeliveryDependencies) {
  const result = { delivered: 0, retried: 0, blocked: 0 }
  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index++) {
    const row = await claim(db, now())
    if (!row) break
    const owned = () => db(QBD_OUTBOX_TABLE).where({ id: row.id, lease_id: row.lease_id, status: "pending" })
    const snapshot = row.order_snapshot
    if (!snapshot || snapshot.id !== row.order_id || !Array.isArray(snapshot.items)
      || snapshot.metadata?.qbd_posting_request_key !== row.request_key) {
      await owned().update({ status: "blocked", last_error: "Invalid stored accounting snapshot; operator review required.",
        lease_id: null, leased_until: null, updated_at: now() })
      result.blocked++
      continue
    }
    try {
      const order = await normalize(snapshot)
      const response = await post(order, {
        version: QBD_OUTBOX_VERSION, id: row.id, request_key: row.request_key,
        depends_on_request_key: row.depends_on_request_key, sequence: String(row.sequence),
        retry_generation: Number(row.retry_generation),
      })
      if (response.status === 422) {
        await owned().update({ status: "blocked", last_error: "Bridge rejected the accounting action. Review its source and implementation before retrying.",
          lease_id: null, leased_until: null, updated_at: now() })
        result.blocked++
        continue
      }
      if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`)
      const body = await response.json()
      const receipt = body?.qbd_outbox_receipt
      if (receipt?.id !== row.id || receipt?.request_key !== row.request_key || !receipt?.bridge_job_id) {
        throw new Error("Bridge did not acknowledge the exact durable action")
      }
      await owned().update({ status: "delivered", bridge_job_id: String(receipt.bridge_job_id),
        delivered_at: now(), last_error: null, lease_id: null, leased_until: null, updated_at: now() })
      result.delivered++
    } catch (error) {
      // Do not persist a provider body, stack, customer record or credential in the error field.
      const reason = error instanceof Error && /^(Bridge HTTP \d{3}|Bridge did not acknowledge)/.test(error.message)
        ? error.message : "Bridge delivery failed; the durable action will be retried."
      await owned().update({ last_error: reason,
        available_at: new Date(now().getTime() + Math.min(3600, 30 * 2 ** Math.min(row.attempts - 1, 7)) * 1000),
        lease_id: null, leased_until: null, updated_at: now() })
      result.retried++
    }
  }
  return result
}
