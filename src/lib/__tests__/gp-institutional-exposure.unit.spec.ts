import {
  calculateInstitutionalExposure,
  reserveInstitutionalCredit,
  type InstitutionalCommitment,
} from "../gp-institutional-exposure"

const invoice = (txnId: string, remainingCents: number) => ({ txnId, remainingCents })
const commitment = (
  orderId: string,
  amountCents: number,
  state: InstitutionalCommitment["state"] = "accepted",
  invoiceTxnId?: string
): InstitutionalCommitment => ({ orderId, amountCents, state, invoiceTxnId })

describe("institutional document exposure (#370 fixtures)", () => {
  it("sums source invoices and unposted commitments in cents", () => {
    expect(calculateInstitutionalExposure({
      invoices: [invoice("TEST_INVOICE_1", 20000)],
      commitments: [commitment("TEST_ORDER_1", 10000)],
    })).toMatchObject({ invoiceCents: 20000, commitmentCents: 10000, totalCents: 30000 })
  })

  it("replaces the exact order commitment when its QBD invoice appears", () => {
    const before = calculateInstitutionalExposure({
      invoices: [invoice("TEST_INVOICE_OLD", 70000)],
      commitments: [commitment("TEST_ORDER_C", 10000, "posting")],
    })
    const after = calculateInstitutionalExposure({
      invoices: [invoice("TEST_INVOICE_OLD", 70000), invoice("TEST_INVOICE_C", 10000)],
      commitments: [commitment("TEST_ORDER_C", 10000, "posted", "TEST_INVOICE_C")],
    })

    expect(before.totalCents).toBe(80000)
    expect(after.totalCents).toBe(80000)
    expect(after.commitmentCents).toBe(0)
  })

  it("updates an unposted catch-weight commitment without manufacturing payment", () => {
    const before = calculateInstitutionalExposure({
      invoices: [], commitments: [commitment("TEST_ORDER_D", 45000)],
    })
    const after = calculateInstitutionalExposure({
      invoices: [], commitments: [commitment("TEST_ORDER_D", 50000)],
    })

    expect(after.totalCents - before.totalCents).toBe(5000)
  })

  it("uses the QBD remaining amount after a partial collection, even on replay", () => {
    const result = calculateInstitutionalExposure({
      invoices: [invoice("TEST_INVOICE_E", 30000)],
      commitments: [commitment("TEST_ORDER_E", 50000, "posted", "TEST_INVOICE_E")],
    })

    expect(result.totalCents).toBe(30000)
    expect(result.quarantined).toBe(false)
  })

  it("releases a cancelled unposted commitment and retains a posted one until QBD readback", () => {
    const result = calculateInstitutionalExposure({
      invoices: [],
      commitments: [
        commitment("TEST_ORDER_F", 30000, "cancelled"),
        commitment("TEST_ORDER_G", 40000, "cancelled", "TEST_INVOICE_G"),
      ],
    })

    expect(result.totalCents).toBe(40000)
    expect(result.quarantined).toBe(true)
    expect(result.reasons).toContain("posted_cancellation_waiting_for_qbd:TEST_ORDER_G")
  })

  it("quarantines uncertain credits and a posted order lacking invoice identity", () => {
    const result = calculateInstitutionalExposure({
      invoices: [],
      commitments: [commitment("TEST_ORDER_G", 40000, "posted")],
      pendingCreditTxnIds: ["TEST_CREDIT_G"],
    })

    expect(result.totalCents).toBe(40000)
    expect(result.quarantined).toBe(true)
    expect(result.reasons).toContain("credit_waiting_for_qbd_readback")
  })

  it("waits for QBD reconciliation before releasing a fully collected posted invoice", () => {
    const uncertain = calculateInstitutionalExposure({
      invoices: [],
      commitments: [commitment("TEST_ORDER_H", 50000, "posted", "TEST_INVOICE_H")],
    })
    const reconciled = calculateInstitutionalExposure({
      invoices: [],
      commitments: [commitment("TEST_ORDER_H", 50000, "reconciled", "TEST_INVOICE_H")],
    })

    expect(uncertain.totalCents).toBe(50000)
    expect(uncertain.quarantined).toBe(true)
    expect(reconciled.totalCents).toBe(0)
  })

  it("rejects duplicate QBD documents, duplicate commitments and invalid balances", () => {
    expect(() => calculateInstitutionalExposure({
      invoices: [invoice("TEST_INVOICE_1", 100), invoice("TEST_INVOICE_1", 100)], commitments: [],
    })).toThrow("Duplicate QBD invoice TxnID")
    expect(() => calculateInstitutionalExposure({
      invoices: [], commitments: [commitment("TEST_ORDER_1", 100), commitment("TEST_ORDER_1", 100)],
    })).toThrow("Duplicate institutional order commitment")
    expect(() => calculateInstitutionalExposure({
      invoices: [invoice("TEST_INVOICE_1", -1)], commitments: [],
    })).toThrow("Invalid QBD remaining invoice balance")
  })
})

describe("atomic institutional credit reservations", () => {
  const previousFlag = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
    else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = previousFlag
  })

  function harness() {
    const rows: InstitutionalCommitment[] = []
    let tail = Promise.resolve()
    const lockCalls: string[] = []
    const db = {
      transaction: async <T>(run: (trx: { raw: (sql: string, bindings: unknown[]) => Promise<void> }) => Promise<T>): Promise<T> => {
        let release!: () => void
        const done = new Promise<void>((resolve) => { release = resolve })
        const trx = {
          raw: async (sql: string, bindings: unknown[]) => {
            lockCalls.push(`${sql}:${String(bindings[0])}`)
            const before = tail
            tail = done
            await before
          },
        }
        try { return await run(trx) } finally { release() }
      },
    }
    const store = {
      list: async () => rows.map((row) => ({ ...row })),
      reserve: async (_trx: unknown, _account: unknown, row: InstitutionalCommitment) => {
        const index = rows.findIndex((existing) => existing.orderId === row.orderId)
        if (index < 0) rows.push({ ...row })
        else rows[index] = { ...row }
      },
    }
    const base = {
      db,
      store,
      companyKey: "TEST_COMPANY_A",
      customerListId: "TEST_LIST_001",
      sourceFresh: true,
      limitCents: 100000,
      invoices: [invoice("TEST_INVOICE_OLD", 70000)],
    }
    return { rows, lockCalls, base }
  }

  it("holds with the feature off by default and never reserves", async () => {
    delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
    const { rows, base } = harness()
    const decision = await reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_A", 20000) })

    expect(decision).toMatchObject({ status: "hold", reason: "feature_disabled" })
    expect(rows).toHaveLength(0)
  })

  it("allows only one of two concurrent orders against the same remaining limit", async () => {
    process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
    const { rows, lockCalls, base } = harness()
    const [first, second] = await Promise.all([
      reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_A", 20000) }),
      reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_B", 20000) }),
    ])

    expect([first.status, second.status].sort()).toEqual(["hold", "reserved"])
    expect(rows).toHaveLength(1)
    expect(lockCalls).toHaveLength(2)
    expect(lockCalls[0]).toContain("pg_advisory_xact_lock")
  })

  it("retains the real amount of a held refresh so a second order cannot spend it", async () => {
    process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
    const { rows, base } = harness()
    const first = await reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_A", 20000) })
    const repeat = await reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_A", 20000) })
    const larger = await reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_A", 35000) })

    expect(first.status).toBe("reserved")
    expect(repeat.status).toBe("reserved")
    expect(larger).toMatchObject({ status: "hold", reason: "credit_limit_exceeded", projectedCents: 105000 })
    expect(rows).toHaveLength(1)
    expect(rows[0].amountCents).toBe(35000)
    const second = await reserveInstitutionalCredit({ ...base, commitment: commitment("TEST_ORDER_B", 10000) })
    expect(second).toMatchObject({ status: "hold", reason: "credit_limit_exceeded", projectedCents: 115000 })
    expect(rows).toHaveLength(1)
  })

  it("holds a replay of a posted order without dropping its exact invoice link", async () => {
    process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
    const { rows, base } = harness()
    rows.push(commitment("TEST_ORDER_A", 20000, "posted", "TEST_INVOICE_A"))
    const result = await reserveInstitutionalCredit({
      ...base,
      invoices: [...base.invoices, invoice("TEST_INVOICE_A", 20000)],
      commitment: commitment("TEST_ORDER_A", 20000),
    })

    expect(result).toMatchObject({ status: "hold", reason: "existing_commitment_not_reservable" })
    expect(rows).toEqual([commitment("TEST_ORDER_A", 20000, "posted", "TEST_INVOICE_A")])
  })

  it("holds stale source, missing limit, and uncertain QBD credits", async () => {
    process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
    const { base } = harness()
    const row = commitment("TEST_ORDER_A", 20000)

    expect(await reserveInstitutionalCredit({ ...base, sourceFresh: false, commitment: row }))
      .toMatchObject({ status: "hold", reason: "stale_qbd_exposure" })
    expect(await reserveInstitutionalCredit({ ...base, limitCents: null, commitment: row }))
      .toMatchObject({ status: "hold", reason: "missing_qbd_credit_limit" })
    expect(await reserveInstitutionalCredit({ ...base, pendingCreditTxnIds: ["TEST_CREDIT_1"], commitment: row }))
      .toMatchObject({ status: "hold", reason: "qbd_reconciliation_uncertain" })
  })
})
