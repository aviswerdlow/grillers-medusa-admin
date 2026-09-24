import {
  institutionalReleaseIntent,
  persistInstitutionalReleaseIntent,
  reconcileInstitutionalReleaseIntent,
} from "../gp-institutional-release-intent"

const priorFlag = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
beforeEach(() => { process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true" })
afterAll(() => {
  if (priorFlag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = priorFlag
})

const baseMetadata = {
  payment_workflow: "invoice_ar",
  gp_institutional_commitment_id: "cart:cart_fixture",
  fulfillment_gate_status: "open_invoice",
}
const targetMetadata = {
  ...baseMetadata,
  fulfillment_gate_status: "released",
  finalization_status: "released_to_fulfillment",
  qbd_posting_action: "invoice_ar_accounting_record",
  qbd_posting_request_key: "invoice_ar:order_fixture",
  qbd_posting_status: "pending_manual",
  qbd_posting_required: true,
  qbd_posting_amount: 50000,
}

function harness() {
  const finalization: any = {
    id: "fin_fixture", order_id: "order_fixture", status: "released_to_fulfillment", metadata: {},
  }
  const credit = [{ order_id: "cart:cart_fixture", amount_cents: "50000", state: "accepted" }]
  const order: any = { id: "order_fixture", metadata: { ...baseMetadata } }
  const trx: any = (table: string) => {
    const filters: Record<string, unknown> = {}
    return {
      where(value: Record<string, unknown>) {
        Object.assign(filters, value)
        return this
      },
      whereNull() { return this },
      async first() {
        if (table !== "gp_order_finalization") throw new Error("Unexpected first()")
        return filters.id === finalization.id || filters.order_id === finalization.order_id
          ? { ...finalization } : null
      },
      then(resolve: (value: unknown) => unknown) {
        if (table !== "gp_institutional_credit_commitment") throw new Error("Unexpected rows()")
        return Promise.resolve(credit.filter((row) => row.order_id === filters.order_id)).then(resolve)
      },
      async update(patch: Record<string, unknown>) {
        if (table !== "gp_order_finalization" || filters.id !== finalization.id) throw new Error("Unexpected update()")
        Object.assign(finalization, patch)
        return 1
      },
    }
  }
  trx.raw = jest.fn(async () => ({ rows: [] }))
  const db: any = { transaction: jest.fn(async (run) => run(trx)) }
  const orderModule = {
    retrieveOrder: jest.fn(async () => ({ ...order, metadata: { ...order.metadata } })),
    updateOrders: jest.fn(async (_id, patch) => { order.metadata = { ...patch.metadata } }),
  }
  const intent = institutionalReleaseIntent({
    orderId: order.id,
    commitmentId: "cart:cart_fixture",
    baseMetadata: order.metadata,
    targetMetadata,
    amountCents: 50000,
  })
  return { db, trx, finalization, credit, order, orderModule, intent }
}

it("persists the release intent only on the released finalization row", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  expect(h.finalization.metadata.gp_institutional_release_intent)
    .toMatchObject({ status: "prepared", requestKey: "invoice_ar:order_fixture" })
  await expect(persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent))
    .rejects.toThrow("cannot be recorded")
})

it("applies a prepared invoice once after canonical order readback", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  const first = await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id })
  const second = await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id })
  expect(first).toEqual({ status: "applied" })
  expect(second).toEqual({ status: "applied" })
  expect(h.orderModule.updateOrders).toHaveBeenCalledTimes(1)
  expect(h.finalization.metadata.gp_institutional_release_intent.status).toBe("applied")
})

it("adopts a committed update whose response failed without sending it again", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  h.orderModule.updateOrders.mockImplementationOnce(async (_id, patch) => {
    h.order.metadata = { ...patch.metadata }
    throw new Error("response lost")
  })
  expect(await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id }))
    .toEqual({ status: "applied" })
  expect(h.orderModule.updateOrders).toHaveBeenCalledTimes(1)
})

it("leaves an unconfirmed write prepared, then retries only after a fresh unchanged read", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  h.orderModule.updateOrders.mockRejectedValueOnce(new Error("order update unavailable"))
  expect(await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id }))
    .toEqual({ status: "pending", reason: "order_update_unconfirmed" })
  expect(h.finalization.metadata.gp_institutional_release_intent.status).toBe("prepared")
  expect(await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id }))
    .toEqual({ status: "applied" })
  expect(h.orderModule.retrieveOrder).toHaveBeenCalledTimes(4)
  expect(h.orderModule.updateOrders).toHaveBeenCalledTimes(2)
})

it("quarantines a conflicting order state before any metadata write", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  h.order.metadata.staff_note = "changed after approval"
  expect(await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id }))
    .toEqual({ status: "quarantined", reason: "order_metadata_conflict" })
  expect(h.orderModule.updateOrders).not.toHaveBeenCalled()
})

it("quarantines a missing credit commitment before posting the invoice", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  h.credit.length = 0
  expect(await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id }))
    .toEqual({ status: "quarantined", reason: "release_credit_mismatch" })
  expect(h.orderModule.updateOrders).not.toHaveBeenCalled()
})

it("recognizes QBD-posted readback with the same request key without replay", async () => {
  const h = harness()
  await persistInstitutionalReleaseIntent(h.trx, h.finalization.id, h.intent)
  h.order.metadata = { ...targetMetadata, qbd_posting_status: "posted", qbd_posting_required: false, qbd_txn_id: "TEST_TXN" }
  expect(await reconcileInstitutionalReleaseIntent({ db: h.db, orderModule: h.orderModule, orderId: h.order.id }))
    .toEqual({ status: "applied" })
  expect(h.orderModule.updateOrders).not.toHaveBeenCalled()
})
