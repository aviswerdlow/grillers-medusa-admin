import {
  FINALIZATION_CHARGE_FAILED_HOLD,
  FINALIZATION_PACKED_PENDING_CHARGE,
  claimFinalChargeAttempt,
  settleFinalChargeAttempt,
} from "../catch-weight-finalization"

type AttemptRow = Record<string, any>

class Query {
  private filters: Array<(row: AttemptRow) => boolean> = []
  private ordering: Array<{ field: string; direction: string }> = []

  constructor(
    private readonly rows: AttemptRow[],
    private readonly table: string
  ) {}

  where(values: Record<string, any>) {
    this.filters.push((row) =>
      Object.entries(values).every(([key, value]) => row[key] === value)
    )
    return this
  }

  whereNull(field: string) {
    this.filters.push((row) => row[field] === null || row[field] === undefined)
    return this
  }

  orderBy(field: string, direction: string) {
    this.ordering.push({ field, direction })
    return this
  }

  private selected() {
    const selected = this.rows.filter(
      (row) =>
        row.__table === this.table &&
        this.filters.every((filter) => filter(row))
    )
    return selected.sort((left, right) => {
      for (const order of this.ordering) {
        const direction = order.direction === "desc" ? -1 : 1
        if (left[order.field] < right[order.field]) return -1 * direction
        if (left[order.field] > right[order.field]) return direction
      }
      return 0
    })
  }

  async first() {
    return this.selected()[0]
  }

  async insert(input: AttemptRow | AttemptRow[]) {
    for (const row of Array.isArray(input) ? input : [input]) {
      this.rows.push({ __table: this.table, ...row })
    }
  }

  async update(patch: Record<string, any>) {
    const selected = this.selected()
    selected.forEach((row) => Object.assign(row, patch))
    return selected.length
  }

  then<TResult1 = AttemptRow[], TResult2 = never>(
    onfulfilled?:
      | ((value: AttemptRow[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.selected()).then(onfulfilled, onrejected)
  }
}

function makeAttemptDb(seed: AttemptRow[] = []) {
  const rows: AttemptRow[] = seed.map((row) => ({
    __table: "gp_final_charge_attempt",
    deleted_at: null,
    ...row,
  }))
  const rawCalls: Array<{ sql: string; bindings: unknown[] }> = []
  let mutex = Promise.resolve()

  const db: any = (table: string) => new Query(rows, table)
  db.raw = async (sql: string, bindings: unknown[]) => {
    rawCalls.push({ sql, bindings })
  }
  db.transaction = <T>(callback: (trx: any) => Promise<T>) => {
    const run = mutex.then(() => callback(db))
    mutex = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  return { db, rows, rawCalls }
}

function claimInput(overrides: Record<string, any> = {}) {
  return {
    orderId: "order_123",
    finalizationId: "fin_123",
    finalizationStatus: FINALIZATION_PACKED_PENDING_CHARGE,
    amount: 5000,
    currencyCode: "usd",
    stripeCustomerId: "cus_123",
    stripePaymentMethodId: "pm_123",
    baseIdempotencyKey: "final-charge:order_123:fin_123",
    requestedBy: "user_123",
    now: new Date("2026-07-27T12:00:00.000Z"),
    ...overrides,
  }
}

function failedAttempt(overrides: Record<string, any> = {}) {
  return {
    id: "attempt_1",
    order_id: "order_123",
    finalization_id: "fin_123",
    attempt_number: 1,
    amount: 5000,
    currency_code: "usd",
    stripe_customer_id: "cus_123",
    stripe_payment_method_id: "pm_123",
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    status: "failed",
    stripe_status: null,
    failure_code: "api_connection_error",
    failure_message: "Connection interrupted",
    idempotency_key: "final-charge:order_123:fin_123",
    requested_by: "user_123",
    requested_at: new Date("2026-07-27T11:50:00.000Z"),
    created_at: new Date("2026-07-27T11:50:00.000Z"),
    updated_at: new Date("2026-07-27T11:50:00.000Z"),
    metadata: {},
    ...overrides,
  }
}

describe("final charge attempt claims", () => {
  it("serializes concurrent callers onto one fresh pending attempt", async () => {
    const { db, rows, rawCalls } = makeAttemptDb()

    const [first, second] = await Promise.all([
      claimFinalChargeAttempt(db, claimInput()),
      claimFinalChargeAttempt(db, claimInput()),
    ])

    expect([first.claimed, second.claimed].sort()).toEqual([false, true])
    expect(first.attempt.id).toBe(second.attempt.id)
    expect(first.attempt.idempotency_key).toBe(
      "final-charge:order_123:fin_123"
    )
    expect(
      rows.filter((row) => row.__table === "gp_final_charge_attempt")
    ).toHaveLength(1)
    expect(rawCalls).toHaveLength(2)
    expect(rawCalls[0].bindings).toEqual(["gp-final-charge:fin_123"])
  })

  it("rotates the key and snapshots a changed card only after a confirmed decline", async () => {
    const { db, rows } = makeAttemptDb([
      failedAttempt({
        stripe_payment_intent_id: "pi_declined",
        stripe_status: "requires_payment_method",
        failure_code: "card_declined",
        metadata: { confirmed_stripe_decline: true },
      }),
    ])

    const claim = await claimFinalChargeAttempt(
      db,
      claimInput({
        finalizationStatus: FINALIZATION_CHARGE_FAILED_HOLD,
        stripePaymentMethodId: "pm_fixed",
      })
    )

    expect(claim.claimed).toBe(true)
    expect(claim.attempt.attempt_number).toBe(2)
    expect(claim.attempt.idempotency_key).toBe(
      "final-charge:order_123:fin_123:decline:1"
    )
    expect(claim.attempt.stripe_payment_method_id).toBe("pm_fixed")
    expect(rows).toHaveLength(2)
  })

  it("does not rotate after an unknown or processing outcome", async () => {
    const { db, rows } = makeAttemptDb([
      failedAttempt({
        stripe_payment_intent_id: "pi_processing",
        stripe_status: "processing",
      }),
    ])

    const claim = await claimFinalChargeAttempt(
      db,
      claimInput({
        finalizationStatus: FINALIZATION_CHARGE_FAILED_HOLD,
        stripePaymentMethodId: "pm_changed_but_not_safe_to_use",
      })
    )

    expect(claim.claimed).toBe(true)
    expect(claim.attempt.id).toBe("attempt_1")
    expect(claim.attempt.idempotency_key).toBe(
      "final-charge:order_123:fin_123"
    )
    expect(claim.attempt.stripe_payment_method_id).toBe("pm_123")
    expect(claim.attempt.status).toBe("pending")
    expect(rows).toHaveLength(1)
  })

  it("does not turn a just-settled decline into a concurrent retry before the hold write lands", async () => {
    const { db, rows } = makeAttemptDb([
      failedAttempt({
        stripe_payment_intent_id: "pi_declined",
        stripe_status: "requires_payment_method",
        failure_code: "card_declined",
        updated_at: new Date("2026-07-27T11:59:59.000Z"),
      }),
    ])

    const claim = await claimFinalChargeAttempt(
      db,
      claimInput({ finalizationStatus: "charge_attempting" })
    )

    expect(claim.claimed).toBe(false)
    expect(claim.attempt.id).toBe("attempt_1")
    expect(rows).toHaveLength(1)
  })

  it("counts unique confirmed-decline keys so legacy replays do not skip generations", async () => {
    const { db } = makeAttemptDb([
      failedAttempt({
        id: "attempt_1",
        attempt_number: 1,
        stripe_payment_intent_id: "pi_declined_1",
        stripe_status: "requires_payment_method",
        failure_code: "card_declined",
      }),
      failedAttempt({
        id: "attempt_2",
        attempt_number: 2,
        stripe_payment_intent_id: "pi_declined_1",
        stripe_status: "requires_payment_method",
        failure_code: "card_declined",
      }),
    ])

    const claim = await claimFinalChargeAttempt(
      db,
      claimInput({ finalizationStatus: FINALIZATION_CHARGE_FAILED_HOLD })
    )

    expect(claim.attempt.attempt_number).toBe(3)
    expect(claim.attempt.idempotency_key).toBe(
      "final-charge:order_123:fin_123:decline:1"
    )
  })

  it("reclaims a stale pending attempt with the same key", async () => {
    const { db, rows } = makeAttemptDb([
      failedAttempt({
        status: "pending",
        requested_at: new Date("2026-07-27T11:00:00.000Z"),
      }),
    ])

    const claim = await claimFinalChargeAttempt(db, claimInput())

    expect(claim.claimed).toBe(true)
    expect(claim.attempt.id).toBe("attempt_1")
    expect(claim.attempt.idempotency_key).toBe(
      "final-charge:order_123:fin_123"
    )
    expect(rows).toHaveLength(1)
  })

  it("adopts a stale succeeded attempt but lets a fresh settlement finish", async () => {
    const staleSucceeded = failedAttempt({
      status: "succeeded",
      stripe_payment_intent_id: "pi_succeeded",
      stripe_charge_id: "ch_succeeded",
      stripe_status: "succeeded",
      failure_code: null,
      failure_message: null,
      succeeded_at: new Date("2026-07-27T11:00:00.000Z"),
      updated_at: new Date("2026-07-27T11:00:00.000Z"),
    })
    const staleDb = makeAttemptDb([staleSucceeded])

    const staleClaim = await claimFinalChargeAttempt(
      staleDb.db,
      claimInput({ finalizationStatus: "charge_attempting" })
    )

    expect(staleClaim.claimed).toBe(true)
    expect(staleClaim.attempt.id).toBe("attempt_1")
    expect(staleDb.rows).toHaveLength(1)

    const freshDb = makeAttemptDb([
      {
        ...staleSucceeded,
        succeeded_at: new Date("2026-07-27T11:59:00.000Z"),
        updated_at: new Date("2026-07-27T11:59:00.000Z"),
      },
    ])
    const freshClaim = await claimFinalChargeAttempt(
      freshDb.db,
      claimInput({ finalizationStatus: "charge_attempting" })
    )

    expect(freshClaim.claimed).toBe(false)
    expect(freshDb.rows).toHaveLength(1)
  })

  it("never lets an ambiguous concurrent settlement downgrade success", async () => {
    const succeeded = failedAttempt({
      status: "succeeded",
      stripe_payment_intent_id: "pi_succeeded",
      stripe_charge_id: "ch_succeeded",
      stripe_status: "succeeded",
      failure_code: null,
      failure_message: null,
    })
    const { db } = makeAttemptDb([succeeded])

    const settled = await settleFinalChargeAttempt(db, succeeded, {
      status: "failed",
      failureCode: "api_connection_error",
      failureMessage: "Concurrent response timed out",
    })

    expect(settled.status).toBe("succeeded")
    expect(settled.stripe_payment_intent_id).toBe("pi_succeeded")
    expect(settled.failure_code).toBeNull()
  })

  it("preserves the first success time when the same successful charge is recorded again", async () => {
    const succeededAt = new Date("2026-07-27T11:00:00.000Z")
    const succeeded = failedAttempt({ status: "succeeded", succeeded_at: succeededAt, stripe_status: "succeeded", stripe_payment_intent_id: "pi_succeeded" })
    const { db } = makeAttemptDb([succeeded])
    const settled = await settleFinalChargeAttempt(db, succeeded, { status: "succeeded", stripeStatus: "succeeded", stripePaymentIntentId: "pi_succeeded" })
    expect(settled.succeeded_at).toEqual(succeededAt)
  })

  it("prevents a stale lease owner from racing release after another caller reclaims the attempt", async () => {
    const staleOwner = failedAttempt({
      status: "pending",
      requested_at: new Date("2026-07-27T11:00:00.000Z"),
      metadata: {
        confirmed_decline_generation: 0,
        claim_token: "claim_old",
      },
    })
    const { db, rows } = makeAttemptDb([staleOwner])

    const reclaimed = await claimFinalChargeAttempt(db, claimInput())
    expect(reclaimed.claimed).toBe(true)
    expect(reclaimed.attempt.metadata.claim_token).not.toBe("claim_old")

    const staleSettlement = await settleFinalChargeAttempt(db, staleOwner, {
      status: "succeeded",
      stripePaymentIntentId: "pi_shared",
      stripeChargeId: "ch_shared",
      stripeStatus: "succeeded",
    })

    expect(staleSettlement.claim_lost).toBe(true)
    expect(rows[0].status).toBe("pending")
    expect(rows[0].stripe_payment_intent_id).toBeNull()

    const ownerSettlement = await settleFinalChargeAttempt(
      db,
      reclaimed.attempt,
      {
        status: "succeeded",
        stripePaymentIntentId: "pi_shared",
        stripeChargeId: "ch_shared",
        stripeStatus: "succeeded",
      }
    )
    expect(ownerSettlement.claim_lost).toBeUndefined()
    expect(ownerSettlement.status).toBe("succeeded")
    expect(rows[0].stripe_payment_intent_id).toBe("pi_shared")
  })
})
