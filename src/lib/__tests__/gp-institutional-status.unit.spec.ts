import { readInstitutionalBridgeAccount } from "../gp-institutional-source"
import { readInstitutionalStatus } from "../gp-institutional-status"
import { adminRouteCapability } from "../staff-route-capabilities"
import { GET as customerGET } from "../../api/store/customers/me/institutional-terms/route"

jest.mock("../gp-institutional-source", () => ({
  readInstitutionalBridgeAccount: jest.fn(),
}))

const companyKey = "a".repeat(64)
const customerId = "cust_synthetic_01"
const prior = {
  flag: process.env.GP_INSTITUTIONAL_TERMS_ENABLED,
  company: process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256,
  age: process.env.GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS,
}

afterAll(() => {
  for (const [key, value] of [
    ["GP_INSTITUTIONAL_TERMS_ENABLED", prior.flag],
    ["GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256", prior.company],
    ["GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS", prior.age],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 = companyKey
  process.env.GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS = "900"
})

function source(overrides: Record<string, unknown> = {}) {
  const { snapshot: snapshotOverrides, ...rest } = overrides
  return {
    sourceStatus: "success",
    link: {
      companyKey, customerListId: "TEST_LIST_001", medusaCustomerId: customerId,
      status: "verified",
    },
    snapshot: {
      source: "quickbooks_desktop_test_company",
      companyKey, customerListId: "TEST_LIST_001", medusaCustomerId: customerId,
      sourceRevision: "test_rev_01", lastSuccess: new Date().toISOString(),
      approvalField: "Pay By Check Approval", approvalValue: "Yes",
      approvalVerified: true, creditLimitCents: 100000,
      termsListId: "TEST_TERMS_NET10", termsName: "Net 10", onHold: false,
      ...(snapshotOverrides as object || {}),
    },
    invoices: [{ txnId: "TEST_INVOICE_01", remainingCents: 20000 }],
    ...rest,
  }
}

it("does not touch the bridge while institutional terms are off", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const status = await readInstitutionalStatus(customerId)
  expect(status.customer).toEqual({
    status: "disabled", reason: "feature_disabled", terms: null, source: null,
  })
  expect(readInstitutionalBridgeAccount).not.toHaveBeenCalled()
})

it("shows approved terms from the exact test-company source but hides QBD IDs from customers", async () => {
  ;(readInstitutionalBridgeAccount as jest.Mock).mockResolvedValue(source())
  const status = await readInstitutionalStatus(customerId)
  expect(status.customer.status).toBe("approved")
  expect(status.customer.terms).toEqual({
    name: "Net 10", creditLimitCents: 100000, openInvoiceCents: 20000,
  })
  expect(JSON.stringify(status.customer)).not.toContain("TEST_LIST_001")
  expect(JSON.stringify(status.customer)).not.toContain(companyKey)
  expect(status.staff.account?.customerListId).toBe("TEST_LIST_001")
})

it("holds an account with an unknown QBD hold decision and hides customer terms", async () => {
  ;(readInstitutionalBridgeAccount as jest.Mock).mockResolvedValue(source({
    snapshot: { onHold: null },
  }))
  const status = await readInstitutionalStatus(customerId)
  expect(status.customer).toMatchObject({
    status: "held", reason: "qbd_account_on_hold", terms: null,
  })
  expect(status.staff.account?.onHold).toBeNull()
})

it("holds a stale QBD read rather than showing approved terms", async () => {
  ;(readInstitutionalBridgeAccount as jest.Mock).mockResolvedValue(source({
    snapshot: { lastSuccess: "2026-09-22T12:00:00Z" },
  }))
  const status = await readInstitutionalStatus(customerId)
  expect(status.customer).toMatchObject({
    status: "held", reason: "qbd_source_stale", terms: null,
  })
})

it("denies a company/ListID mismatch without exposing account details", async () => {
  ;(readInstitutionalBridgeAccount as jest.Mock).mockResolvedValue(source({
    link: { companyKey, customerListId: "TEST_LIST_999", medusaCustomerId: customerId, status: "verified" },
  }))
  const status = await readInstitutionalStatus(customerId)
  expect(status.customer).toMatchObject({ status: "denied", terms: null, source: null })
  expect(status.staff.account).toBeNull()
})

it("binds the account read to the authenticated customer and grants staff GET only", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const req = { auth_context: { actor_id: customerId }, query: { customer_id: "other" } } as any
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
  await customerGET(req, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "disabled" }))
  expect(adminRouteCapability("/admin/grillers/customers/cust_1/institutional-terms", "GET"))
    .toBe("customers.read")
  expect(adminRouteCapability("/admin/grillers/customers/cust_1/institutional-terms", "POST"))
    .toBeNull()
})
