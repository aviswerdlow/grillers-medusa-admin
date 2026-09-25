import { authorizeInstitutionalTerms } from "./gp-institutional-terms-authority"
import { readInstitutionalBridgeAccount } from "./gp-institutional-source"
import {
  reserveInstitutionalCredit,
  type InstitutionalInvoice,
  type CreditReservationDecision,
} from "./gp-institutional-exposure"
import { PostgresInstitutionalCreditStore } from "./gp-institutional-credit-store"

export type InstitutionalCheckoutAuthority = {
  companyKey: string
  customerListId: string
  creditLimitCents: number
  termsName: string
  termsListId: string
  sourceRevision: string
  lastSuccess: string
  invoices: InstitutionalInvoice[]
}

export type InstitutionalCheckoutCheck =
  | { status: "allow"; account: InstitutionalCheckoutAuthority }
  | { status: "deny" | "hold"; reason: string }

/** Only a protected, fresh bridge read can authorize the no-card path. */
export async function institutionalCheckoutAuthority(customerId: string): Promise<InstitutionalCheckoutCheck> {
  if (process.env.GP_INSTITUTIONAL_TERMS_ENABLED !== "true") {
    return { status: "deny", reason: "feature_disabled" }
  }
  const source = await readInstitutionalBridgeAccount(customerId)
  const rawAge = process.env.GP_INSTITUTIONAL_QBD_MAX_AGE_SECONDS || "900"
  const ageSeconds = Number(rawAge)
  const maxAgeMs = Number.isSafeInteger(ageSeconds) && ageSeconds >= 60 && ageSeconds <= 3600
    ? ageSeconds * 1000 : 0
  const decision = authorizeInstitutionalTerms({
    featureEnabled: true,
    expectedTestCompanyKey: process.env.GP_INSTITUTIONAL_TEST_COMPANY_FILE_SHA256 || "",
    customerId,
    link: source.link,
    snapshot: source.snapshot,
    sourceStatus: source.sourceStatus,
    now: new Date(),
    maxAgeMs,
  })
  if (decision.status !== "allow") return decision
  if (!decision.termsName || !source.link) {
    return { status: "hold", reason: "qbd_terms_missing" }
  }
  return {
    status: "allow",
    account: {
      companyKey: source.link.companyKey,
      customerListId: source.link.customerListId,
      creditLimitCents: decision.creditLimitCents,
      termsName: decision.termsName,
      termsListId: decision.termsListId,
      sourceRevision: decision.sourceRevision,
      lastSuccess: decision.lastSuccess,
      invoices: source.invoices,
    },
  }
}

export function institutionalDollarsToCents(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new Error("Institutional order total is unavailable")
  }
  const cents = Math.round(amount * 100)
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 0.000001) {
    throw new Error("Institutional order total has invalid precision")
  }
  return cents
}

/** The cart ID is a stable pre-order reservation ID; it travels on the order. */
export async function reserveInstitutionalCheckout(input: {
  db: any
  transaction?: any
  account: InstitutionalCheckoutAuthority
  reservationId: string
  amountCents: number
}): Promise<CreditReservationDecision> {
  return reserveInstitutionalCredit({
    db: input.db,
    transaction: input.transaction,
    store: new PostgresInstitutionalCreditStore(),
    companyKey: input.account.companyKey,
    customerListId: input.account.customerListId,
    sourceFresh: true,
    limitCents: input.account.creditLimitCents,
    invoices: input.account.invoices,
    commitment: {
      orderId: input.reservationId,
      amountCents: input.amountCents,
      state: "accepted",
      invoiceTxnId: null,
    },
  })
}
