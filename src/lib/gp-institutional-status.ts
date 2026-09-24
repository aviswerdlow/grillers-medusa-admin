import { readInstitutionalBridgeAccount } from "./gp-institutional-source"
import { authorizeInstitutionalTerms } from "./gp-institutional-terms-authority"

export type InstitutionalCustomerStatus = {
  status: "disabled" | "approved" | "held" | "denied"
  reason: string | null
  terms: { name: string; creditLimitCents: number; openInvoiceCents: number } | null
  source: { revision: string; lastSuccess: string } | null
}

export type InstitutionalStaffStatus = InstitutionalCustomerStatus & {
  account: {
    companyKey: string
    customerListId: string
    approvalField: string
    approvalValue: string | null
    onHold: boolean | null
    termsName: string | null
    creditLimitCents: number | null
    openInvoiceCents: number
  } | null
}

/** A single protected bridge read supplies both views. Customer output never
 * contains a QBD identity, and held accounts never receive approved terms.
 */
export async function readInstitutionalStatus(customerId: string): Promise<{
  customer: InstitutionalCustomerStatus
  staff: InstitutionalStaffStatus
}> {
  const disabled: InstitutionalCustomerStatus = {
    status: "disabled", reason: "feature_disabled", terms: null, source: null,
  }
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") {
    return { customer: disabled, staff: { ...disabled, account: null } }
  }

  const bridge = await readInstitutionalBridgeAccount(customerId)
  const ageSeconds = Number(process.env.GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS || "900")
  const maxAgeMs = Number.isSafeInteger(ageSeconds) && ageSeconds >= 60 && ageSeconds <= 3600
    ? ageSeconds * 1000 : 0
  const decision = authorizeInstitutionalTerms({
    featureEnabled: true,
    expectedTestCompanyKey: process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 || "",
    customerId,
    link: bridge.link,
    snapshot: bridge.snapshot,
    sourceStatus: bridge.sourceStatus,
    now: new Date(),
    maxAgeMs,
  })
  const exactSource = bridge.link && bridge.snapshot &&
    bridge.link.status === "verified" &&
    bridge.link.companyKey === process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 &&
    bridge.link.customerListId === bridge.snapshot.customerListId &&
    bridge.link.medusaCustomerId === customerId &&
    bridge.snapshot.companyKey === bridge.link.companyKey &&
    bridge.snapshot.medusaCustomerId === customerId
      ? bridge.snapshot : null
  const source = exactSource &&
    typeof exactSource.sourceRevision === "string" && exactSource.sourceRevision &&
    typeof exactSource.lastSuccess === "string" && exactSource.lastSuccess
      ? { revision: exactSource.sourceRevision, lastSuccess: exactSource.lastSuccess }
      : null
  const openInvoiceCents = bridge.invoices.reduce((total, invoice) => total + invoice.remainingCents, 0)
  const approved = decision.status === "allow" && source && exactSource &&
    typeof exactSource.termsName === "string" && exactSource.termsName &&
    Number.isSafeInteger(openInvoiceCents) && openInvoiceCents >= 0
  const customer: InstitutionalCustomerStatus = approved
    ? {
        status: "approved", reason: null,
        terms: {
          name: exactSource.termsName!,
          creditLimitCents: decision.creditLimitCents,
          openInvoiceCents,
        },
        source,
      }
    : {
        status: decision.status === "deny" ? "denied" : "held",
        reason: decision.status === "allow" ? "source_terms_incomplete" : decision.reason,
        terms: null,
        source,
      }
  const staff: InstitutionalStaffStatus = {
    ...customer,
    account: exactSource && Number.isSafeInteger(openInvoiceCents) && openInvoiceCents >= 0
      ? {
          companyKey: exactSource.companyKey,
          customerListId: exactSource.customerListId,
          approvalField: exactSource.approvalField,
          approvalValue: exactSource.approvalValue,
          onHold: exactSource.onHold,
          termsName: exactSource.termsName,
          creditLimitCents: exactSource.creditLimitCents,
          openInvoiceCents,
        }
      : null,
  }
  return { customer, staff }
}
