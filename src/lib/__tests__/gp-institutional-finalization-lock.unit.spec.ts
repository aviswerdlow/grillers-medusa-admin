import { withInstitutionalFinalizationWrite } from "../gp-institutional-finalization-lock"

const prior = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
afterAll(() => {
  if (prior === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = prior
})

function harness(status = "packed_pending_review") {
  const raw = jest.fn(async () => ({ rows: [] }))
  const trx: any = jest.fn(() => ({
    where: () => ({ whereNull: () => ({ first: async () => ({ status }) }) }),
  }))
  trx.raw = raw
  const db: any = jest.fn()
  db.transaction = jest.fn(async (run) => run(trx))
  const order = { id: "order_fixture", metadata: { payment_workflow: "invoice_ar" } }
  return { db, trx, raw, order }
}

it("keeps the existing direct path while the flag is off", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const { db, order } = harness()
  const run = jest.fn(async (workDb) => workDb)
  expect(await withInstitutionalFinalizationWrite(db, order, run)).toBe(db)
  expect(db.transaction).not.toHaveBeenCalled()
})

it("holds the invoice order lock through the callback", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  const { db, trx, raw, order } = harness()
  const run = jest.fn(async (workDb) => workDb)
  expect(await withInstitutionalFinalizationWrite(db, order, run)).toBe(trx)
  expect(raw).toHaveBeenCalledWith(
    expect.stringContaining("pg_advisory_xact_lock"),
    ["gp_institutional_finalization:order_fixture"]
  )
  expect(trx).toHaveBeenCalledWith("gp_order_finalization")
})

it("rejects a post-release edit while allowing an immutable detail read", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  const { db, order } = harness("released_to_fulfillment")
  const run = jest.fn(async () => "detail")
  await expect(withInstitutionalFinalizationWrite(db, order, run))
    .rejects.toThrow("Released invoice packing cannot be changed")
  expect(run).not.toHaveBeenCalled()
  expect(await withInstitutionalFinalizationWrite(db, order, run, { readReleased: true }))
    .toBe("detail")
})
