/** Portable contact/provenance contract; mirrored in the storefront. */
export const CONTACT_CONFIRMATION_VERSION = "contact-confirm-v2-2026-09-20"
export const PRIMARY_CONTACT_KEY = "primary_contact_v1"
export const MIGRATION_PROVENANCE_KEY = "migration_provenance_v1"

export function contactObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any> : {}
}

export function normalizePrimaryPhone(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+\d\s().-]+$/.test(value)) return null
  const digits = value.replace(/\D/g, "")
  const ten = digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null
}

export function validContactDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
}

export function hasMigrationProvenance(metadata: unknown): boolean {
  const m = contactObject(metadata)
  const provenance = contactObject(m[MIGRATION_PROVENANCE_KEY])
  if (provenance.version === 1 && provenance.source === "legacy_site_customers" &&
      typeof provenance.source_customer_id === "string" && provenance.source_customer_id.trim()) return true
  // Existing imports already carry this stable pair. Never infer migration
  // from created_at, a phone, an accounting ListID alone, or a surname.
  return m.legacy_source === "legacy_site_customers" &&
    ["string", "number"].includes(typeof m.legacy_customer_id) &&
    String(m.legacy_customer_id).trim().length > 0
}

export function hasContactConfirmation(metadata: unknown): boolean {
  const m = contactObject(metadata)
  const state = contactObject(m.contact_confirmation_v2)
  if (state.version === CONTACT_CONFIRMATION_VERSION && state.status === "confirmed" &&
      validContactDate(state.confirmed_at)) return true
  // Preserve legitimate v1 completions instead of prompting the whole book.
  return m.contact_verified_version === "contact-verify-v1-2026-07-07" &&
    validContactDate(m.contact_verified_at)
}

export function contactRevision(metadata: unknown): number {
  const value = contactObject(contactObject(metadata)[PRIMARY_CONTACT_KEY]).revision
  return Number.isSafeInteger(value) && value >= 1 ? value : 0
}

export function isProtectedContactKey(key: string): boolean {
  return /^(primary_contact|contact_confirm|contact_verified|contact_verify|migration_provenance|legacy_|qbd_customer_list_id|preferred_contact_email|receipt_contact|email_confirmed|sms_|order_sms)/.test(key)
}

/** An old order stays historical; changing contact never redirects its texts. */
export function permitsPrimaryDestination(metadata: unknown, phone: unknown, consentAt?: unknown): boolean {
  const raw = contactObject(metadata)[PRIMARY_CONTACT_KEY]
  if (raw === undefined) return true // Existing, unconfirmed accounts retain their qualified consent gates.
  const contact = contactObject(raw)
  if (contact.version !== 1 || !normalizePrimaryPhone(contact.phone) ||
      normalizePrimaryPhone(contact.phone) !== normalizePrimaryPhone(phone)) return false
  if (contact.sms_consent_not_before) {
    if (!validContactDate(contact.sms_consent_not_before) || !validContactDate(consentAt)) return false
    if (Date.parse(String(consentAt)) < Date.parse(contact.sms_consent_not_before)) return false
  }
  return true
}
