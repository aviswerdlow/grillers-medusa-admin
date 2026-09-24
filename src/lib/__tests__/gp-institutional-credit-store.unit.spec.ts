import {
  PostgresInstitutionalCreditStore,
  type CreditStoreTransaction,
} from "../gp-institutional-credit-store"

describe("institutional durable credit store", () => {
  const store = new PostgresInstitutionalCreditStore()

  it("reads all account commitments by exact company and ListID", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = []
    const trx: CreditStoreTransaction = {
      raw: jest.fn(async (sql, bindings) => {
        calls.push({ sql, bindings })
        return { rows: [{ order_id: "TEST_ORDER_A", amount_cents: "20000", state: "accepted", invoice_txn_id: null }] }
      }),
    }

    await expect(store.list(trx, "TEST_COMPANY_A", "TEST_LIST_001"))
      .resolves.toEqual([{ orderId: "TEST_ORDER_A", amountCents: 20000, state: "accepted", invoiceTxnId: null }])
    expect(calls[0].bindings).toEqual(["TEST_COMPANY_A", "TEST_LIST_001"])
    expect(calls[0].sql).toContain("deleted_at is null")
  })

  it("upserts one stable order under the account lock and never creates a second reservation", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = []
    const trx: CreditStoreTransaction = {
      raw: jest.fn(async (sql, bindings) => {
        calls.push({ sql, bindings })
        return { rows: [{ id: bindings[0] }] }
      }),
    }
    const account = { companyKey: "TEST_COMPANY_A", customerListId: "TEST_LIST_001" }
    const row = { orderId: "TEST_ORDER_A", amountCents: 20000, state: "accepted" as const, invoiceTxnId: null }

    await store.reserve(trx, account, row)
    await store.reserve(trx, account, { ...row, amountCents: 25000 })

    expect(calls).toHaveLength(2)
    expect(calls[0].bindings[0]).toBe(calls[1].bindings[0])
    expect(calls[1].bindings[4]).toBe("25000")
    expect(calls[0].sql).toContain("on conflict (company_key, customer_list_id, order_id)")
    expect(calls[0].sql).toContain("where gp_institutional_credit_commitment.state = 'accepted'")
  })

  it("refuses to re-reserve an order that moved past accepted", async () => {
    const trx: CreditStoreTransaction = { raw: jest.fn(async () => ({ rows: [] })) }

    await expect(store.reserve(
      trx,
      { companyKey: "TEST_COMPANY_A", customerListId: "TEST_LIST_001" },
      { orderId: "TEST_ORDER_A", amountCents: 20000, state: "accepted", invoiceTxnId: null }
    )).rejects.toThrow("no longer reservable")
  })

  it("rejects missing IDs, invalid amounts and unknown source states", async () => {
    const trx: CreditStoreTransaction = { raw: jest.fn(async () => ({ rows: [] })) }
    await expect(store.reserve(
      trx,
      { companyKey: "TEST_COMPANY_A", customerListId: "TEST_LIST_001" },
      { orderId: "", amountCents: 20000, state: "accepted", invoiceTxnId: null }
    )).rejects.toThrow("Stable institutional")
    await expect(store.reserve(
      trx,
      { companyKey: "TEST_COMPANY_A", customerListId: "TEST_LIST_001" },
      { orderId: "TEST_ORDER_A", amountCents: 12.5, state: "accepted", invoiceTxnId: null }
    )).rejects.toThrow("Invalid institutional")

    const invalidTrx: CreditStoreTransaction = {
      raw: jest.fn(async () => ({ rows: [{ order_id: "TEST_ORDER_A", amount_cents: "20000", state: "unknown", invoice_txn_id: null }] })),
    }
    await expect(store.list(invalidTrx, "TEST_COMPANY_A", "TEST_LIST_001"))
      .rejects.toThrow("Unknown institutional commitment state")
  })
})
