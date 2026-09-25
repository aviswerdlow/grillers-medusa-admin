import { reconcileInstitutionalPostingHandoff as reconcile } from "../gp-institutional-posting-handoff"
import { calculateInstitutionalExposure } from "../gp-institutional-exposure"

const companyKey = "a".repeat(64)
const prior = {
  flag: process.env.GP_INSTITUTIONAL_TERMS_ENABLED,
  company: process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256,
}

afterAll(() => {
  if (prior.flag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = prior.flag
  if (prior.company === undefined) delete process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256
  else process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = prior.company
})

beforeEach(() => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = companyKey
})

function order() {
  return {
    id: "TEST_ORDER_C", cart_id: "TEST_CART_C", customer_id: "TEST_CUSTOMER_C",
    metadata: {
      payment_workflow: "invoice_ar", gp_institutional_commitment_id: "cart:TEST_CART_C",
      qbd_posting_status: "posted", qbd_posting_action: "invoice_ar_accounting_record",
      qbd_posting_request_key: "invoice_ar:TEST_ORDER_C", qbd_posting_amount: 10000,
      qbd_txn_id: "TEST_INVOICE_C",
    },
  }
}

function source(balance = 10000, lastSuccess = new Date().toISOString()) {
  return {
    sourceStatus: "success" as const,
    link: { companyKey, customerListId: "TEST_LIST_001", medusaCustomerId: "TEST_CUSTOMER_C", status: "verified" as const },
    snapshot: {
      source: "quickbooks_desktop_test_company" as const, companyKey,
      customerListId: "TEST_LIST_001", medusaCustomerId: "TEST_CUSTOMER_C",
      sourceRevision: "TEST_SOURCE_REV", lastSuccess,
      approvalField: "Pay By Check Approval", approvalValue: "Yes", approvalVerified: true,
      creditLimitCents: 100000, termsListId: "TEST_NET10", termsName: "Net 10", onHold: null,
    },
    invoices: balance > 0 ? [{ txnId: "TEST_INVOICE_C", remainingCents: balance }] : [],
    readbacks: {
      invoices: [{
        invoiceTxnId: "TEST_INVOICE_C", totalCents: 10000, remainingCents: balance,
        paymentTxnIds: balance === 0 ? ["TEST_PAYMENT_C"] : [], creditTxnIds: [],
        sourceRevision: "TEST_INVOICE_REV", reconciliationStatus: balance === 0 ? "reconciled" as const : "outstanding" as const,
      }],
      payments: balance === 0 ? [{
        paymentTxnId: "TEST_PAYMENT_C", invoiceTxnId: "TEST_INVOICE_C",
        receivedTotalCents: 10000, appliedCents: 10000,
        sourceRevision: "TEST_PAYMENT_REV", status: "confirmed_by_invoice_readback" as const,
      }] : [],
    },
  }
}

function harness(extraRows: Array<Record<string, any>> = []) {
  const rows = [{
    id: "gpic_test_c", company_key: companyKey, customer_list_id: "TEST_LIST_001",
    order_id: "cart:TEST_CART_C", amount_cents: "10000", state: "accepted",
    invoice_txn_id: null as string | null,
  }, ...extraRows]
  const updates: Array<Record<string, unknown>> = []
  const locks: string[] = []
  const db: any = (table: string) => {
    expect(table).toBe("gp_institutional_credit_commitment")
    const filters: Record<string, unknown> = {}
    const selected = () => rows.filter((row) => Object.entries(filters)
      .every(([key, value]) => row[key] === value))
    const builder: any = {
      where(values: Record<string, unknown>) { Object.assign(filters, values); return this },
      whereNull() { return this },
      forUpdate: async () => selected(),
      update: async (values: Record<string, unknown>) => {
        updates.push(values)
        for (const row of selected()) Object.assign(row, values)
        return selected().length
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(selected()).then(resolve, reject)
      },
    }
    return builder
  }
  db.transaction = async (run: (trx: any) => Promise<unknown>) => {
    const trx: any = (table: string) => db(table)
    trx.raw = async (_sql: string, bindings: string[]) => { locks.push(bindings[0]) }
    return run(trx)
  }
  return { db, rows, updates, locks }
}

it("does not touch the source or database with the flag off", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const readSource = jest.fn(async () => source())
  const result = await reconcile({ db: () => { throw new Error("DB read") }, order: order(), readSource: readSource as any })
  expect(result).toEqual({ status: "pending", reason: "feature_disabled" })
  expect(readSource).not.toHaveBeenCalled()
})

it("links one posted invoice under the account lock and prevents double exposure", async () => {
  const { db, rows, updates, locks } = harness()
  const readSource = jest.fn(async () => source())
  const first = await reconcile({ db, order: order(), readSource: readSource as any })
  expect(first).toEqual({ status: "posted", invoiceTxnId: "TEST_INVOICE_C" })
  expect(rows[0]).toMatchObject({ state: "posted", invoice_txn_id: "TEST_INVOICE_C" })
  expect(locks).toEqual([`gp_institutional_credit:${companyKey}:TEST_LIST_001`])
  expect(calculateInstitutionalExposure({
    invoices: [{ txnId: "TEST_INVOICE_C", remainingCents: 10000 }],
    commitments: [{ orderId: rows[0].order_id, amountCents: 10000, state: "posted", invoiceTxnId: rows[0].invoice_txn_id }],
  }).totalCents).toBe(10000)
  expect(await reconcile({ db, order: order(), readSource: readSource as any })).toEqual(first)
  expect(updates).toHaveLength(1)
})

it("marks a fully collected exact invoice reconciled and releases exposure", async () => {
  const { db, rows } = harness()
  expect(await reconcile({ db, order: order(), readSource: (async () => source(0)) as any }))
    .toEqual({ status: "reconciled", invoiceTxnId: "TEST_INVOICE_C" })
  expect(rows[0].state).toBe("reconciled")
  expect(calculateInstitutionalExposure({
    invoices: [],
    commitments: [{ orderId: rows[0].order_id, amountCents: 10000, state: "reconciled", invoiceTxnId: rows[0].invoice_txn_id }],
  }).totalCents).toBe(0)
})

it("waits on a stale source without changing the commitment", async () => {
  const { db, rows, updates } = harness()
  expect(await reconcile({ db, order: order(), readSource: (async () => source(10000, "2026-09-22T12:00:00Z")) as any }))
    .toEqual({ status: "pending", reason: "qbd_source_unavailable_or_stale" })
  expect(rows[0].state).toBe("accepted")
  expect(updates).toHaveLength(0)
})

it("quarantines a mismatched final invoice amount", async () => {
  const { db, rows } = harness()
  const mismatched = source()
  mismatched.readbacks.invoices[0].totalCents = 11000
  expect(await reconcile({ db, order: order(), readSource: (async () => mismatched) as any }))
    .toEqual({ status: "quarantined", reason: "posted_invoice_amount_mismatch" })
  expect(rows[0].state).toBe("quarantined")
})

it("quarantines an accounting receipt with the wrong stable request key", async () => {
  const { db, rows } = harness()
  const badOrder = order()
  badOrder.metadata.qbd_posting_request_key = "invoice_ar:TEST_OTHER_ORDER"
  const readSource = jest.fn(async () => source())
  expect(await reconcile({ db, order: badOrder, readSource: readSource as any }))
    .toEqual({ status: "quarantined", reason: "posting_receipt_mismatch" })
  expect(rows[0].state).toBe("quarantined")
  expect(readSource).not.toHaveBeenCalled()
})

it("quarantines a QBD invoice already linked to another commitment", async () => {
  const other = {
    id: "gpic_other", company_key: companyKey, customer_list_id: "TEST_LIST_001",
    order_id: "cart:TEST_OTHER", amount_cents: "10000", state: "posted",
    invoice_txn_id: "TEST_INVOICE_C",
  }
  const { db, rows } = harness([other])
  expect(await reconcile({ db, order: order(), readSource: (async () => source()) as any }))
    .toEqual({ status: "quarantined", reason: "invoice_linked_to_another_commitment" })
  expect(rows[0].state).toBe("quarantined")
})
