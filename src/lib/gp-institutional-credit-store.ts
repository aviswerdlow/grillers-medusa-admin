import { createHash } from "crypto"

type RawResult = { rows?: Record<string, unknown>[] }
export type CreditStoreTransaction = {
  raw(sql: string, bindings: unknown[]): Promise<RawResult>
}

export type StoredInstitutionalCommitment = {
  orderId: string
  amountCents: number
  state: "accepted" | "posting" | "posted" | "cancelled" | "reconciled" | "quarantined"
  invoiceTxnId: string | null
}

const allowedStates = new Set<StoredInstitutionalCommitment["state"]>([
  "accepted", "posting", "posted", "cancelled", "reconciled", "quarantined",
])

function stableId(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Stable institutional account/document ID is required")
  return value.trim()
}

function cents(value: unknown): number {
  const amount = typeof value === "string" ? Number(value) : value
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Invalid institutional commitment amount")
  }
  return amount
}

/**
 * Durable adapter for #370's account-locked reservation helper. Call list and
 * reserve inside the SAME transaction after taking the account advisory lock.
 */
export class PostgresInstitutionalCreditStore {
  async list(
    trx: CreditStoreTransaction,
    companyKey: string,
    customerListId: string
  ): Promise<StoredInstitutionalCommitment[]> {
    const result = await trx.raw(
      `select order_id, amount_cents, state, invoice_txn_id
       from gp_institutional_credit_commitment
       where company_key = ? and customer_list_id = ? and deleted_at is null`,
      [stableId(companyKey), stableId(customerListId)]
    )
    if (!result || !Array.isArray(result.rows)) {
      throw new Error("Institutional commitment read did not return rows")
    }
    return result.rows.map((row) => {
      const state = row.state as StoredInstitutionalCommitment["state"]
      if (!allowedStates.has(state)) throw new Error("Unknown institutional commitment state")
      return {
        orderId: stableId(row.order_id as string),
        amountCents: cents(row.amount_cents),
        state,
        invoiceTxnId: row.invoice_txn_id == null ? null : stableId(row.invoice_txn_id as string),
      }
    })
  }

  async reserve(
    trx: CreditStoreTransaction,
    account: { companyKey: string; customerListId: string },
    commitment: StoredInstitutionalCommitment
  ): Promise<void> {
    if (commitment.state !== "accepted") throw new Error("Only accepted orders may reserve credit")
    const companyKey = stableId(account.companyKey)
    const customerListId = stableId(account.customerListId)
    const orderId = stableId(commitment.orderId)
    const amount = cents(commitment.amountCents)
    const id = "gpic_" + createHash("sha256")
      .update(JSON.stringify([companyKey, customerListId, orderId]))
      .digest("hex")
    const result = await trx.raw(
      `insert into gp_institutional_credit_commitment
         (id, company_key, customer_list_id, order_id, amount_cents, state, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'accepted', now(), now())
       on conflict (company_key, customer_list_id, order_id)
       do update set amount_cents = excluded.amount_cents, updated_at = now()
       where gp_institutional_credit_commitment.state = 'accepted'
       returning id`,
      [id, companyKey, customerListId, orderId, String(amount)]
    )
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
      throw new Error("Institutional commitment is no longer reservable")
    }
  }
}
