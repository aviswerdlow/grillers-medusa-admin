import { quarantineStaleInstitutionalReservations } from "../gp-institutional-stale-reservations"

const prior = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
afterAll(() => {
  if (prior === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = prior
})

const now = new Date("2026-09-24T12:00:00Z")
const old = "2026-09-22T12:00:00Z"
const account = {
  id: "gpic_test",
  company_key: "TEST_COMPANY_A",
  customer_list_id: "TEST_LIST_001",
}

function harness(input: { linkedCommitmentId?: string; updatedAt?: string } = {}) {
  const row = {
    ...account,
    order_id: "cart:TEST_CART_A",
    state: "accepted",
    updated_at: input.updatedAt ?? old,
  }
  const calls: string[] = []
  const trx = {
    raw: jest.fn(async (sql: string, bindings: unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        calls.push(`lock:${bindings[0]}`)
        return { rows: [{}] }
      }
      if (sql.includes("for update")) {
        calls.push("read")
        return { rows: [row] }
      }
      if (sql.includes("from order_cart oc join")) {
        calls.push("link")
        return { rows: input.linkedCommitmentId
          ? [{ commitment_id: input.linkedCommitmentId }] : [] }
      }
      if (sql.includes("update gp_institutional_credit_commitment")) {
        calls.push("quarantine")
        row.state = "quarantined"
        return { rows: [{ id: account.id }] }
      }
      throw new Error(`Unexpected transaction query: ${sql}`)
    }),
  }
  const db = {
    raw: jest.fn(async () => ({ rows: row.state === "accepted" ? [account] : [] })),
    transaction: async <T>(run: (workTrx: typeof trx) => Promise<T>): Promise<T> => run(trx),
  }
  return { db, trx, row, calls }
}

it("does not scan or write with the institutional flag off", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const { db } = harness()
  expect(await quarantineStaleInstitutionalReservations(db, now)).toBe(0)
  expect(db.raw).not.toHaveBeenCalled()
})

it("quarantines an old unlinked reservation under the account lock and never releases exposure", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  const { db, row, calls } = harness()
  expect(await quarantineStaleInstitutionalReservations(db, now)).toBe(1)
  expect(row.state).toBe("quarantined")
  expect(calls).toEqual([
    "lock:gp_institutional_credit:TEST_COMPANY_A:TEST_LIST_001",
    "read", "link", "quarantine",
  ])
  expect(await quarantineStaleInstitutionalReservations(db, now)).toBe(0)
})

it("leaves an exact linked order accepted and leaves a recent retry untouched", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  const linked = harness({ linkedCommitmentId: "cart:TEST_CART_A" })
  expect(await quarantineStaleInstitutionalReservations(linked.db, now)).toBe(0)
  expect(linked.row.state).toBe("accepted")
  expect(linked.calls).not.toContain("quarantine")

  const recent = harness({ updatedAt: "2026-09-24T11:59:00Z" })
  expect(await quarantineStaleInstitutionalReservations(recent.db, now)).toBe(0)
  expect(recent.calls).toEqual([
    "lock:gp_institutional_credit:TEST_COMPANY_A:TEST_LIST_001", "read",
  ])
})

it("quarantines a link to an order with a different commitment ID", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  const { db, row } = harness({ linkedCommitmentId: "cart:DIFFERENT" })
  expect(await quarantineStaleInstitutionalReservations(db, now)).toBe(1)
  expect(row.state).toBe("quarantined")
})
