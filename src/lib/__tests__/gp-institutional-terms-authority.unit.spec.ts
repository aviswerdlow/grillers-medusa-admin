import {
  authorizeInstitutionalTerms,
  type InstitutionalAccountLink,
  type InstitutionalQbdSnapshot,
} from "../gp-institutional-terms-authority"

const link: InstitutionalAccountLink = {
  companyKey: "TEST_COMPANY_A",
  customerListId: "TEST_LIST_001",
  medusaCustomerId: "medusa_institution_01",
  status: "verified",
}
const snapshot: InstitutionalQbdSnapshot = {
  source: "quickbooks_desktop_test_company",
  companyKey: link.companyKey,
  customerListId: link.customerListId,
  medusaCustomerId: link.medusaCustomerId,
  sourceRevision: "test_rev_01",
  lastSuccess: "2026-09-22T12:00:00Z",
  approvalField: "Pay By Check Approval",
  approvalValue: "Yes",
  approvalVerified: true,
  creditLimitCents: 100000,
  termsListId: "TEST_TERMS_NET10",
  termsName: "Net 10",
  onHold: false,
}
const baseline = {
  featureEnabled: true,
  expectedTestCompanyKey: "TEST_COMPANY_A",
  customerId: link.medusaCustomerId,
  link,
  snapshot,
  sourceStatus: "success" as const,
  now: new Date("2026-09-22T12:01:00Z"),
  maxAgeMs: 15 * 60 * 1000,
}

describe("institutional terms source authority (#370 synthetic fixtures)", () => {
  it("requires the feature flag even for a verified test account", () => {
    expect(authorizeInstitutionalTerms({ ...baseline, featureEnabled: false }))
      .toEqual({ status: "deny", reason: "feature_disabled" })
    expect(authorizeInstitutionalTerms({ ...baseline, featureEnabled: "false" as unknown as boolean }))
      .toEqual({ status: "deny", reason: "feature_disabled" })
  })

  it("accepts the exact verified QBD test account without backup card terms", () => {
    expect(authorizeInstitutionalTerms(baseline)).toEqual({
      status: "allow",
      creditLimitCents: 100000,
      termsListId: "TEST_TERMS_NET10",
      termsName: "Net 10",
      sourceRevision: "test_rev_01",
      lastSuccess: "2026-09-22T12:00:00Z",
    })
  })

  it("denies retail metadata claiming approval when no exact link exists", () => {
    expect(authorizeInstitutionalTerms({ ...baseline, customerId: "medusa_retail_01", link: null }))
      .toEqual({ status: "deny", reason: "no_verified_account_link" })
  })

  it("denies a different requester even when the verified link and snapshot agree", () => {
    expect(authorizeInstitutionalTerms({ ...baseline, customerId: "medusa_institution_02" }))
      .toEqual({ status: "deny", reason: "no_verified_account_link" })
  })

  it("requires a verified link for the configured test company", () => {
    for (const changedLink of [
      { ...link, status: "pending_source_read" as const },
      { ...link, status: "quarantined" as const },
      { ...link, companyKey: "TEST_COMPANY_B" },
    ]) {
      expect(authorizeInstitutionalTerms({ ...baseline, link: changedLink }))
        .toEqual({ status: "deny", reason: "no_verified_account_link" })
    }
  })

  it("requires the snapshot to name the verified test source and linked customer", () => {
    expect(authorizeInstitutionalTerms({ ...baseline, snapshot: {
      ...snapshot, source: "quickbooks_desktop_production" as InstitutionalQbdSnapshot["source"],
    } })).toEqual({ status: "deny", reason: "qbd_identity_mismatch" })
    expect(authorizeInstitutionalTerms({ ...baseline, snapshot: {
      ...snapshot, medusaCustomerId: "medusa_institution_02",
    } })).toEqual({ status: "deny", reason: "qbd_identity_mismatch" })
  })

  it("denies an unflagged or unverified QBD account", () => {
    for (const change of [
      { approvalValue: "No" }, { approvalValue: "YES" }, { approvalValue: "Yes " },
      { approvalVerified: false }, { approvalVerified: "false" as unknown as boolean },
      { approvalField: "Other" },
    ]) {
      expect(authorizeInstitutionalTerms({ ...baseline, snapshot: { ...snapshot, ...change } }))
        .toEqual({ status: "deny", reason: "qbd_approval_missing" })
    }
  })

  it("does not join by a matching display name when the ListID differs", () => {
    expect(authorizeInstitutionalTerms({
      ...baseline,
      snapshot: { ...snapshot, customerListId: "TEST_LIST_999" },
    })).toEqual({ status: "deny", reason: "qbd_identity_mismatch" })
  })

  it("denies a wrong QBD company even with the same ListID", () => {
    expect(authorizeInstitutionalTerms({
      ...baseline,
      snapshot: { ...snapshot, companyKey: "TEST_COMPANY_B" },
    })).toEqual({ status: "deny", reason: "qbd_identity_mismatch" })
  })

  it("holds missing terms or a missing credit limit without a default Net term", () => {
    for (const change of [{ termsListId: null }, { creditLimitCents: null }, { creditLimitCents: 0 }]) {
      expect(authorizeInstitutionalTerms({ ...baseline, snapshot: { ...snapshot, ...change } }))
        .toEqual({ status: "hold", reason: "qbd_terms_or_limit_missing" })
    }
  })

  it("holds stale, future, missing-revision and unavailable source reads", () => {
    expect(authorizeInstitutionalTerms({
      ...baseline, now: new Date("2026-09-22T13:00:00Z"),
    })).toEqual({ status: "hold", reason: "qbd_source_stale" })
    expect(authorizeInstitutionalTerms({
      ...baseline, now: new Date("2026-09-22T11:59:59Z"),
    })).toEqual({ status: "hold", reason: "qbd_source_stale" })
    expect(authorizeInstitutionalTerms({
      ...baseline, snapshot: { ...snapshot, sourceRevision: "" },
    })).toEqual({ status: "hold", reason: "qbd_source_unverified" })
    expect(authorizeInstitutionalTerms({
      ...baseline, sourceStatus: "unavailable", snapshot: null,
    })).toEqual({ status: "hold", reason: "qbd_source_unavailable" })
    expect(authorizeInstitutionalTerms({
      ...baseline, sourceStatus: "unavailable", link: null, snapshot: null,
    })).toEqual({ status: "hold", reason: "qbd_source_unavailable" })
  })

  it("requires a valid last-success timestamp with an explicit timezone", () => {
    for (const lastSuccess of ["not-a-date", "2026-09-22T12:00:00", "2026-09-22"]) {
      expect(authorizeInstitutionalTerms({ ...baseline, snapshot: { ...snapshot, lastSuccess } }))
        .toEqual({ status: "hold", reason: "qbd_source_unverified" })
    }
    expect(authorizeInstitutionalTerms({ ...baseline, snapshot: {
      ...snapshot, lastSuccess: "2026-09-22T08:00:00-04:00",
    } }).status).toBe("allow")
  })

  it("holds an impossible last-success calendar date even when Date.parse normalizes it", () => {
    expect(authorizeInstitutionalTerms({
      ...baseline,
      now: new Date("2026-03-02T12:01:00Z"),
      snapshot: { ...snapshot, lastSuccess: "2026-02-30T12:00:00Z" },
    })).toEqual({ status: "hold", reason: "qbd_source_unverified" })
  })

  it("holds an explicitly held QBD account", () => {
    expect(authorizeInstitutionalTerms({ ...baseline, snapshot: { ...snapshot, onHold: true } }))
      .toEqual({ status: "hold", reason: "qbd_account_on_hold" })
    expect(authorizeInstitutionalTerms({ ...baseline, snapshot: { ...snapshot, onHold: null } }))
      .toEqual({ status: "hold", reason: "qbd_account_on_hold" })
  })
})
