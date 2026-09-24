import { readInstitutionalBridgeAccount } from "../gp-institutional-source"

const companyKey = "a".repeat(64)
const payload = {
  status: "success",
  link: { company_key: companyKey, customer_list_id: "TEST_LIST_001", medusa_customer_id: "medusa_institution_01", status: "verified" },
  snapshot: {
    source: "quickbooks_desktop_test_company", company_key: companyKey,
    customer_list_id: "TEST_LIST_001", medusa_customer_id: "medusa_institution_01",
    source_revision: "test_rev_01", last_success: "2026-09-22T12:00:00Z",
    approval_field: "Pay By Check Approval", approval_value: "Yes", approval_verified: true,
    credit_limit_cents: 100000, terms_list_id: "TEST_TERMS_NET10", terms_name: "Net 10",
    open_invoice_cents: 20000, open_invoices: [{ txn_id: "TEST_INVOICE_1", remaining_cents: 20000 }],
    invoice_readbacks: [{
      source: "quickbooks_desktop_test_company", company_key: companyKey,
      customer_list_id: "TEST_LIST_001", invoice_txn_id: "TEST_INVOICE_1",
      invoice_total_cents: 20000, remaining_cents: 20000,
      linked_transactions: [], source_revision: "test_invoice_rev_01",
      reconciliation_status: "outstanding",
    }],
    payment_readbacks: [],
    on_hold: false,
  },
}

describe("protected institutional bridge source", () => {
  const previousUrl = process.env.GP_INSTITUTIONAL_BRIDGE_READ_URL
  const previousToken = process.env.GP_INSTITUTIONAL_BRIDGE_READ_TOKEN
  const previousFetch = global.fetch

  beforeEach(() => {
    process.env.GP_INSTITUTIONAL_BRIDGE_READ_URL = "https://sync.example.test/api/institutional/accounts"
    process.env.GP_INSTITUTIONAL_BRIDGE_READ_TOKEN = "t".repeat(40)
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as any
  })
  afterAll(() => {
    if (previousUrl === undefined) delete process.env.GP_INSTITUTIONAL_BRIDGE_READ_URL
    else process.env.GP_INSTITUTIONAL_BRIDGE_READ_URL = previousUrl
    if (previousToken === undefined) delete process.env.GP_INSTITUTIONAL_BRIDGE_READ_TOKEN
    else process.env.GP_INSTITUTIONAL_BRIDGE_READ_TOKEN = previousToken
    global.fetch = previousFetch
  })

  it("reads the exact customer with a server-only bearer token", async () => {
    const result = await readInstitutionalBridgeAccount("medusa_institution_01")
    expect(result).toMatchObject({
      sourceStatus: "success", invoices: [{ txnId: "TEST_INVOICE_1", remainingCents: 20000 }],
      readbacks: { invoices: [{ invoiceTxnId: "TEST_INVOICE_1", reconciliationStatus: "outstanding" }], payments: [] },
    })
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("https://sync.example.test/api/institutional/accounts/medusa_institution_01"),
      expect.objectContaining({ method: "GET", headers: { Authorization: `Bearer ${"t".repeat(40)}`, Accept: "application/json" } })
    )
  })

  it("treats read errors and malformed financial data as unavailable, never zero", async () => {
    global.fetch = jest.fn(async () => { throw new Error("network failed") }) as any
    expect(await readInstitutionalBridgeAccount("medusa_institution_01"))
      .toEqual({ sourceStatus: "unavailable", link: null, snapshot: null, invoices: [], readbacks: null })
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({
      ...payload, snapshot: { ...payload.snapshot, open_invoice_cents: 0 },
    }) })) as any
    expect((await readInstitutionalBridgeAccount("medusa_institution_01")).sourceStatus).toBe("unavailable")
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({
      ...payload, snapshot: { ...payload.snapshot, invoice_readbacks: undefined },
    }) })) as any
    expect((await readInstitutionalBridgeAccount("medusa_institution_01")).sourceStatus).toBe("unavailable")
  })

  it("distinguishes an authoritative missing link from an unavailable QBD read", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as any
    expect(await readInstitutionalBridgeAccount("medusa_retail_01"))
      .toEqual({ sourceStatus: "success", link: null, snapshot: null, invoices: [], readbacks: null })
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as any
    expect((await readInstitutionalBridgeAccount("medusa_institution_01")).sourceStatus).toBe("unavailable")
  })
})
