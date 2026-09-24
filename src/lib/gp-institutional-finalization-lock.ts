import {
  FINALIZATION_RELEASED_TO_FULFILLMENT,
  isInvoiceOrder,
} from "./catch-weight-finalization"

type Transaction = {
  raw(sql: string, bindings: unknown[]): Promise<unknown>
  (table: string): any
}

type Database = Transaction & {
  transaction<T>(run: (trx: Transaction) => Promise<T>): Promise<T>
}

/** Serialize invoice packing edits and release against the same order key.
 * All invoice packing mutation routes must use this wrapper while the flag is
 * on. The callback's DB work and Medusa order metadata update finish before
 * the lock is released. A failed callback rolls back the DB changes.
 */
export async function withInstitutionalFinalizationWrite<T>(
  db: Database,
  order: Record<string, any>,
  run: (workDb: Transaction) => Promise<T>,
  options: { readReleased?: boolean } = {}
): Promise<T> {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true" || !isInvoiceOrder(order)) {
    return run(db)
  }
  if (typeof order.id !== "string" || !order.id) {
    throw new Error("Institutional order identity is unavailable.")
  }
  return db.transaction(async (trx) => {
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp_institutional_finalization:${order.id}`,
    ])
    const finalization = await trx("gp_order_finalization")
      .where({ order_id: order.id })
      .whereNull("deleted_at")
      .first()
    if (finalization?.status === FINALIZATION_RELEASED_TO_FULFILLMENT && !options.readReleased) {
      throw new Error("Released invoice packing cannot be changed without an accounting adjustment.")
    }
    return run(trx)
  })
}
