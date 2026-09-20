import { createHash, randomUUID } from "node:crypto"
import {
  contactObject, contactRevision, CONTACT_CONFIRMATION_VERSION,
  hasMigrationProvenance, normalizePrimaryPhone, PRIMARY_CONTACT_KEY,
} from "./customer-contact-state"
import {
  SMS_MARKETING_CONSENT_VERSION, SMS_MARKETING_DISCLOSURE,
  SMS_MARKETING_PROGRAM, SMS_MARKETING_PROVIDER,
  SMS_MARKETING_CONSENT_METHOD, SMS_MARKETING_CONSENT_PURPOSE,
  upsertCustomerProfile,
} from "./communications/core"

export class ContactChangeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

export type ContactChange = {
  phone: string
  expected_revision: number
  request_id: string
  sms_marketing_opt_in?: boolean
  confirmation?: { version: string; address_id: string; preferred_email?: string | null }
}

export function parseContactChange(raw: unknown): ContactChange {
  const value = contactObject(raw)
  const phone = normalizePrimaryPhone(value.phone)
  if (!phone) throw new ContactChangeError(400, "invalid_phone", "Enter a valid 10-digit US mobile number.")
  if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0 ||
      typeof value.request_id !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.request_id)) {
    throw new ContactChangeError(400, "invalid_request", "Refresh this page and try again.")
  }
  if (value.sms_marketing_opt_in !== undefined && typeof value.sms_marketing_opt_in !== "boolean") {
    throw new ContactChangeError(400, "invalid_consent", "Choose whether to receive marketing texts.")
  }
  let confirmation: ContactChange["confirmation"]
  if (value.confirmation !== undefined) {
    const c = contactObject(value.confirmation)
    if (c.version !== CONTACT_CONFIRMATION_VERSION || typeof c.address_id !== "string" || !c.address_id) {
      throw new ContactChangeError(400, "invalid_confirmation", "Confirm your shipping address and try again.")
    }
    const email = typeof c.preferred_email === "string" ? c.preferred_email.trim().toLowerCase() : null
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) {
      throw new ContactChangeError(400, "invalid_email", "Enter a valid email address.")
    }
    confirmation = { version: c.version, address_id: c.address_id, preferred_email: email }
  }
  return { phone, expected_revision: value.expected_revision, request_id: value.request_id,
    sms_marketing_opt_in: value.sms_marketing_opt_in, confirmation }
}

function smsEvidence(phone: string, now: string, confirm: boolean) {
  return { sms_marketing_opt_in: true, sms_consent: true, sms_consent_status: "subscribed",
    sms_consent_at: now, sms_consent_source: confirm ? "first_login_verification" : "account_profile",
    sms_consent_version: SMS_MARKETING_CONSENT_VERSION, sms_consent_text: SMS_MARKETING_DISCLOSURE,
    sms_consent_phone: phone, sms_consent_provider: SMS_MARKETING_PROVIDER,
    sms_program: SMS_MARKETING_PROGRAM, sms_consent_purpose: SMS_MARKETING_CONSENT_PURPOSE,
    sms_consent_method: SMS_MARKETING_CONSENT_METHOD }
}

/** One customer lock serializes replacement, consent and confirmation. No provider I/O. */
export async function changePrimaryContact(db: any, customerId: string, input: ContactChange) {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex")
  return db.transaction(async (trx: any) => {
    const customer = await trx("customer").where({ id: customerId }).whereNull("deleted_at").forUpdate().first()
    if (!customer) throw new ContactChangeError(401, "unknown_customer", "Please sign in again.")
    const metadata = contactObject(customer.metadata)
    const prior = contactObject(metadata[PRIMARY_CONTACT_KEY])
    if (prior.last_request_id === input.request_id) {
      if (prior.last_request_hash !== hash) throw new ContactChangeError(409, "request_conflict", "Refresh this page and try again.")
      return { ok: true, revision: contactRevision(metadata), replayed: true }
    }
    if (contactRevision(metadata) !== input.expected_revision) {
      throw new ContactChangeError(409, "contact_changed", "Your contact details changed in another session. Refresh before saving.")
    }
    if (input.confirmation) {
      if (!hasMigrationProvenance(metadata)) throw new ContactChangeError(409, "not_migrated", "Your account does not need this confirmation.")
      const address = await trx("customer_address").where({ id: input.confirmation.address_id, customer_id: customerId })
        .whereNull("deleted_at").first()
      if (!address) throw new ContactChangeError(400, "invalid_address", "Choose an address saved to your account.")
    }

    // Only a customer ID or an unbound exact-email profile may be associated.
    // upsert rejects another account's bound email; phone never joins identity.
    const profile = await upsertCustomerProfile(trx, { medusa_customer_id: customerId,
      email: customer.email, first_name: customer.first_name, last_name: customer.last_name })
    if (!profile) throw new Error("Contact profile unavailable")
    const lockedProfile = await trx("gp_customer_profile").where({ id: profile.id }).whereNull("deleted_at").forUpdate().first()
    const profileMetadata = contactObject(lockedProfile.metadata)
    const now = new Date().toISOString()
    const oldPhone = normalizePrimaryPhone(prior.phone || customer.phone)
    const changed = oldPhone !== input.phone
    const active = { version: 1, revision: input.expected_revision + 1, phone: input.phone,
      attested_at: now, attested_by: customerId, assurance: "customer_attested",
      possession_verified_at: null, line_type_checked_at: null,
      sms_consent_not_before: changed ? now : prior.sms_consent_not_before || null,
      last_request_id: input.request_id, last_request_hash: hash }
    const consentPatch: Record<string, any> = input.sms_marketing_opt_in === true
      ? smsEvidence(input.phone, now, Boolean(input.confirmation))
      : changed || input.sms_marketing_opt_in === false
        ? { sms_marketing_opt_in: false, sms_consent: false, sms_consent_status: "unsubscribed",
            sms_consent_at: null, sms_consent_phone: input.phone, sms_opt_out_at: now,
            sms_opt_out_phone: input.phone }
        : {}
    const patch: Record<string, any> = { [PRIMARY_CONTACT_KEY]: active, ...consentPatch }
    if (input.confirmation) {
      patch.contact_confirmation_v2 = { version: CONTACT_CONFIRMATION_VERSION, status: "confirmed",
        confirmed_at: now, actor_id: customerId, address_id: input.confirmation.address_id,
        phone_assurance: "customer_attested" }
      // #366 owns verification/activation. This is explicitly only a request;
      // an already verified recipient record is never overwritten here.
      if (input.confirmation.preferred_email && input.confirmation.preferred_email !== String(customer.email).toLowerCase()) {
        patch.preferred_contact_email_request = { status: "pending_verification",
          email: input.confirmation.preferred_email, requested_at: now }
      }
    }
    const smsConsent = input.sms_marketing_opt_in === true ? true
      : changed || input.sms_marketing_opt_in === false ? false : lockedProfile.sms_consent
    await trx("customer").where({ id: customerId }).update({ phone: input.phone,
      metadata: { ...metadata, ...patch }, updated_at: now })
    await trx("gp_customer_profile").where({ id: profile.id }).update({ phone: input.phone,
      sms_consent: smsConsent, sms_consent_at: smsConsent
        ? input.sms_marketing_opt_in === true ? now : lockedProfile.sms_consent_at : null,
      metadata: { ...profileMetadata, [PRIMARY_CONTACT_KEY]: active, ...consentPatch }, updated_at: now })
    // Durable local audit, same transaction. Does not dispatch a campaign or
    // subscriber. No full phone, email or address is copied into public logs.
    await trx("gp_communication_event").insert({ id: `gpev_${randomUUID()}`,
      event_id: `primary-contact:${customerId}:${input.request_id}`, event_name: "primary_contact_confirmed",
      source: "medusa-customer", profile_id: profile.id, medusa_customer_id: customerId,
      occurred_at: now, received_at: now, properties: { revision: active.revision, changed_destination: changed,
        marketing_choice: input.sms_marketing_opt_in ?? "unchanged", assurance: "customer_attested" },
      created_at: now, updated_at: now })
    return { ok: true, revision: active.revision, replayed: false }
  })
}
