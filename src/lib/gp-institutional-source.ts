import type {
  InstitutionalAccountLink,
  InstitutionalQbdSnapshot,
} from "./gp-institutional-terms-authority"
import type { InstitutionalInvoice } from "./gp-institutional-exposure"

export type InstitutionalBridgeRead = {
  sourceStatus: "success" | "unavailable"
  link: InstitutionalAccountLink | null
  snapshot: InstitutionalQbdSnapshot | null
  invoices: InstitutionalInvoice[]
}

const unavailable = (): InstitutionalBridgeRead => ({
  sourceStatus: "unavailable", link: null, snapshot: null, invoices: [],
})

function id(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value !== ""
    ? value : null
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null
}

/** A protected server-to-server read; errors never become zero exposure. */
export async function readInstitutionalBridgeAccount(customerId: string): Promise<InstitutionalBridgeRead> {
  const base = process.env.GP_INSTITUTIONAL_BRIDGE_READ_URL || ""
  const token = process.env.GP_INSTITUTIONAL_BRIDGE_READ_TOKEN || ""
  if (!id(customerId) || token.length < 32 || token.length > 512) return unavailable()
  let url: URL
  try {
    url = new URL(base)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return unavailable()
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(customerId)}`
  } catch {
    return unavailable()
  }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5000)
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: abort.signal,
    })
    if (response.status === 404) {
      return { sourceStatus: "success", link: null, snapshot: null, invoices: [] }
    }
    if (!response.ok) return unavailable()
    const body = await response.json() as Record<string, any>
    if (body?.status !== "success" || body?.link?.status !== "verified" ||
        body?.snapshot?.source !== "quickbooks_desktop_test_company") return unavailable()
    const rawLink = body.link
    const raw = body.snapshot
    const companyKey = id(rawLink.company_key)
    const customerListId = id(rawLink.customer_list_id)
    if (!companyKey || !customerListId || rawLink.medusa_customer_id !== customerId ||
        raw.company_key !== companyKey || raw.customer_list_id !== customerListId ||
        raw.medusa_customer_id !== customerId || !Array.isArray(raw.open_invoices)) {
      return unavailable()
    }
    const invoices: InstitutionalInvoice[] = []
    const seen = new Set<string>()
    for (const item of raw.open_invoices) {
      const txnId = id(item?.txn_id)
      const remainingCents = cents(item?.remaining_cents)
      if (!txnId || remainingCents === null || seen.has(txnId)) return unavailable()
      seen.add(txnId)
      invoices.push({ txnId, remainingCents })
    }
    const creditLimitCents = raw.credit_limit_cents === null
      ? null : cents(raw.credit_limit_cents)
    if (raw.credit_limit_cents !== null && creditLimitCents === null) return unavailable()
    const invoiceTotal = invoices.reduce((sum, row) => sum + row.remainingCents, 0)
    if (!Number.isSafeInteger(invoiceTotal) || invoiceTotal !== raw.open_invoice_cents) return unavailable()

    return {
      sourceStatus: "success",
      link: { companyKey, customerListId, medusaCustomerId: customerId, status: "verified" },
      snapshot: {
        source: "quickbooks_desktop_test_company",
        companyKey, customerListId, medusaCustomerId: customerId,
        sourceRevision: raw.source_revision,
        lastSuccess: raw.last_success,
        approvalField: raw.approval_field,
        approvalValue: raw.approval_value,
        approvalVerified: raw.approval_verified === true,
        creditLimitCents,
        termsListId: raw.terms_list_id,
        termsName: raw.terms_name,
        onHold: raw.on_hold === false ? false : raw.on_hold === true ? true : null,
      },
      invoices,
    }
  } catch {
    return unavailable()
  } finally {
    clearTimeout(timer)
  }
}
