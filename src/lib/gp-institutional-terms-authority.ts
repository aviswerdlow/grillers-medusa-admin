/**
 * #370: source-only eligibility for a test QBD institutional account. The
 * caller must obtain the link and snapshot through the protected bridge read
 * path; customer/cart metadata is never an eligibility input.
 */
export type InstitutionalAccountLink = {
  companyKey: string
  customerListId: string
  medusaCustomerId: string
  status: "verified" | "pending_source_read" | "quarantined"
}

export type InstitutionalQbdSnapshot = {
  source: "quickbooks_desktop_test_company"
  companyKey: string
  customerListId: string
  medusaCustomerId: string
  sourceRevision: string
  lastSuccess: string
  approvalField: string
  approvalValue: string | null
  approvalVerified: boolean
  creditLimitCents: number | null
  termsListId: string | null
  termsName: string | null
  onHold: boolean | null
}

export type InstitutionalTermsDecision =
  | { status: "allow"; creditLimitCents: number; termsListId: string; termsName: string | null; sourceRevision: string; lastSuccess: string }
  | { status: "deny" | "hold"; reason: string }

function exactId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.trim() === value
}

function validTimestampCalendar(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return false
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  calendar.setUTCHours(hour, minute, second, 0)
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month &&
    calendar.getUTCDate() === day && calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute && calendar.getUTCSeconds() === second
}

export function authorizeInstitutionalTerms(input: {
  featureEnabled: boolean
  expectedTestCompanyKey: string
  customerId: string
  link: InstitutionalAccountLink | null
  snapshot: InstitutionalQbdSnapshot | null
  sourceStatus: "success" | "unavailable"
  now: Date
  maxAgeMs: number
}): InstitutionalTermsDecision {
  if (input.featureEnabled !== true) return { status: "deny", reason: "feature_disabled" }
  if (input.sourceStatus !== "success") {
    return { status: "hold", reason: "qbd_source_unavailable" }
  }
  const { link, snapshot } = input
  if (!link || !exactId(input.customerId) || !exactId(input.expectedTestCompanyKey)) {
    return { status: "deny", reason: "no_verified_account_link" }
  }
  if (link.status !== "verified" || link.medusaCustomerId !== input.customerId ||
      link.companyKey !== input.expectedTestCompanyKey || !exactId(link.customerListId)) {
    return { status: "deny", reason: "no_verified_account_link" }
  }
  if (!snapshot) {
    return { status: "hold", reason: "qbd_source_unavailable" }
  }
  if (snapshot.source !== "quickbooks_desktop_test_company" ||
      snapshot.companyKey !== link.companyKey || snapshot.customerListId !== link.customerListId ||
      snapshot.medusaCustomerId !== link.medusaCustomerId) {
    return { status: "deny", reason: "qbd_identity_mismatch" }
  }
  if (!exactId(snapshot.sourceRevision) || !exactId(snapshot.lastSuccess) ||
      !validTimestampCalendar(snapshot.lastSuccess) ||
      !Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0 ||
      !Number.isFinite(input.now.getTime())) {
    return { status: "hold", reason: "qbd_source_unverified" }
  }
  const lastSuccessMs = Date.parse(snapshot.lastSuccess)
  if (!Number.isFinite(lastSuccessMs) || lastSuccessMs > input.now.getTime() ||
      input.now.getTime() - lastSuccessMs > input.maxAgeMs) {
    return { status: "hold", reason: "qbd_source_stale" }
  }
  if (snapshot.approvalField !== "Pay By Check Approval" ||
      snapshot.approvalVerified !== true || snapshot.approvalValue !== "Yes") {
    return { status: "deny", reason: "qbd_approval_missing" }
  }
  if (snapshot.onHold !== false) return { status: "hold", reason: "qbd_account_on_hold" }
  if (!Number.isSafeInteger(snapshot.creditLimitCents) || !snapshot.creditLimitCents ||
      snapshot.creditLimitCents <= 0 || !exactId(snapshot.termsListId)) {
    return { status: "hold", reason: "qbd_terms_or_limit_missing" }
  }
  return {
    status: "allow",
    creditLimitCents: snapshot.creditLimitCents,
    termsListId: snapshot.termsListId,
    termsName: snapshot.termsName,
    sourceRevision: snapshot.sourceRevision,
    lastSuccess: snapshot.lastSuccess,
  }
}
