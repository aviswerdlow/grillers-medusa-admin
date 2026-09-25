type Row = Record<string, unknown>
type QueryResult = { rows?: Row[] }
type Transaction = { raw(sql: string, bindings?: unknown[]): Promise<QueryResult> }
type Database = Transaction & { transaction<T>(run: (trx: Transaction) => Promise<T>): Promise<T> }

const MAX_AGE_MS = 24 * 60 * 60 * 1000

function rows(result: QueryResult): Row[] {
  if (!result || !Array.isArray(result.rows)) {
    throw new Error("Institutional reservation read did not return rows")
  }
  return result.rows
}

function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error("Institutional reservation identity is invalid")
  }
  return value
}

/**
 * A stale cart reservation with no verified native order is uncertain, not
 * released credit. Quarantine it under the same account advisory lock used by
 * checkout; exposure keeps its amount and future reservations hold for review.
 * The job can be retried without changing already linked or quarantined rows.
 */
export async function quarantineStaleInstitutionalReservations(
  db: Database,
  now = new Date()
): Promise<number> {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") return 0
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid reservation scan time")
  const cutoff = new Date(now.getTime() - MAX_AGE_MS)
  const candidates = rows(await db.raw(`
    select c.id, c.company_key, c.customer_list_id
    from gp_institutional_credit_commitment c
    where c.deleted_at is null and c.state = 'accepted'
      and c.order_id like 'cart:%' and c.updated_at < ?::timestamptz
      and not exists (
        select 1 from order_cart oc
        join "order" o on o.id = oc.order_id
        where oc.cart_id = substring(c.order_id from 6)
          and o.metadata->>'gp_institutional_commitment_id' = c.order_id
      )
    order by c.updated_at asc, c.id asc
    limit 25
  `, [cutoff]))

  let quarantined = 0
  for (const candidate of candidates) {
    const account = [id(candidate.company_key), id(candidate.customer_list_id)]
    const commitmentId = id(candidate.id)
    const changed = await db.transaction(async (trx) => {
      await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
        `gp_institutional_credit:${account[0]}:${account[1]}`,
      ])
      const current = rows(await trx.raw(`
        select id, company_key, customer_list_id, order_id, state, updated_at
        from gp_institutional_credit_commitment
        where id = ? and deleted_at is null for update
      `, [commitmentId]))[0]
      if (!current || current.company_key !== account[0] ||
          current.customer_list_id !== account[1] || current.state !== "accepted" ||
          !String(current.order_id).startsWith("cart:") ||
          !current.updated_at || new Date(String(current.updated_at)).getTime() >= cutoff.getTime()) {
        return false
      }
      const cartId = id(String(current.order_id).slice(5))
      const links = rows(await trx.raw(`
        select o.metadata->>'gp_institutional_commitment_id' as commitment_id
        from order_cart oc join "order" o on o.id = oc.order_id
        where oc.cart_id = ?
      `, [cartId]))
      if (links.some((link) => link.commitment_id === current.order_id)) return false

      const updated = rows(await trx.raw(`
        update gp_institutional_credit_commitment
        set state = 'quarantined', updated_at = now()
        where id = ? and state = 'accepted' and deleted_at is null
        returning id
      `, [commitmentId]))
      return updated.length === 1
    })
    if (changed) quarantined += 1
  }
  return quarantined
}
