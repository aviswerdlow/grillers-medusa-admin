const oldPrimaryContactFlag = process.env.GP_PRIMARY_CONTACT_ENABLED
beforeEach(() => { process.env.GP_PRIMARY_CONTACT_ENABLED = "true" })
afterEach(() => { if (oldPrimaryContactFlag === undefined) delete process.env.GP_PRIMARY_CONTACT_ENABLED; else process.env.GP_PRIMARY_CONTACT_ENABLED = oldPrimaryContactFlag })
import { CONTACT_CONFIRMATION_VERSION, contactRevision, hasContactConfirmation,
  hasMigrationProvenance, normalizePrimaryPhone, permitsPrimaryDestination } from "../customer-contact-state"
import { parseContactChange } from "../customer-primary-contact"
import { legacyContactImportPatch } from "../legacy-contact-provenance"
import { guardCustomerContactWrite, guardCustomerProvenanceCreate } from "../../api/middlewares/customer-contact"
import { POST } from "../../api/store/customers/me/contact/route"

const date = "2026-09-20T12:00:00.000Z"
const primary = { version: 1, revision: 2, phone: "4045550101", sms_consent_not_before: date }

it("requires source identity, never a creation-date heuristic or matching phone", () => {
  expect(hasMigrationProvenance({ created_at: "2025-01-01", phone: "4045550100" })).toBe(false)
  expect(hasMigrationProvenance({ legacy_source: "legacy_site_customers", legacy_customer_id: "late-row" })).toBe(true)
  expect(hasMigrationProvenance({ migration_provenance_v1: { version: 1, source: "legacy_site_customers", source_customer_id: "new-row" } })).toBe(true)
  expect(hasMigrationProvenance({ legacy_source: "legacy_site_customers" })).toBe(false)
})
it("preserves legitimate previous confirmation but rejects malformed evidence", () => {
  expect(hasContactConfirmation({ contact_verified_at: date, contact_verified_version: "contact-verify-v1-2026-07-07" })).toBe(true)
  expect(hasContactConfirmation({ contact_verified_at: "broken", contact_verified_version: "contact-verify-v1-2026-07-07" })).toBe(false)
  expect(hasContactConfirmation({ contact_verified_at: date })).toBe(false)
  expect(hasContactConfirmation({ contact_confirmation_v2: { status: "confirmed", version: CONTACT_CONFIRMATION_VERSION, confirmed_at: date } })).toBe(true)
})
it("normalizes syntax without claiming mobile type or possession", () => {
  expect(normalizePrimaryPhone("+1 (404) 555-0100")).toBe("4045550100")
  for (const phone of ["4045550100123", "4045550100 ext 9", "1045550100", "abc4045550100", ""]) expect(normalizePrimaryPhone(phone)).toBeNull()
})
it("prevents old queued/order consent following replacement or reactivation", () => {
  const m = { primary_contact_v1: primary }
  expect(permitsPrimaryDestination(m,"4045550100",date)).toBe(false)
  expect(permitsPrimaryDestination(m,"4045550101","2026-09-19T12:00:00.000Z")).toBe(false)
  expect(permitsPrimaryDestination(m,"4045550101",date)).toBe(true)
  expect(permitsPrimaryDestination({ primary_contact_v1: {} },"4045550101",date)).toBe(false)
})
it("leaves a new target contact/opt-out/verified email out of import patches", () => {
  const existing = { phone: null, metadata: { primary_contact_v1: primary, sms_consent: false,
    receipt_contact: { status: "verified" }, migration_provenance_v1: { first_imported_at: date } } }
  const patch = legacyContactImportPatch(existing,{ legacyCustomerId: "source-1", phone: "4045550100" },date)
  expect(patch.phone).toBeUndefined()
  expect(Object.keys(patch.metadata)).toEqual(["migration_provenance_v1"])
  expect(patch.metadata.migration_provenance_v1.source_watermark).toBeNull()
  expect(contactRevision(existing.metadata)).toBe(2)
})
it("validates revision/idempotency and scopes supported request fields", () => {
  expect(() => parseContactChange({ phone: "4045550100", expected_revision: -1, request_id: "a" })).toThrow()
  const p = parseContactChange({ phone: "4045550100", expected_revision: 0, request_id: "synthetic-request-1", customer_id: "other", sms_marketing_opt_in: false })
  expect(p).not.toHaveProperty("customer_id")
})
it.each([{ phone: "4045550100" },{ metadata: null },{ metadata: { primary_contact_v1: null } },{ metadata: { legacy_customer_id: "forged" } },{ metadata: { sms_consent: true } }])("blocks native writes bypassing contact authority: %j", async (body) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }; const next=jest.fn()
  await guardCustomerContactWrite({ body } as any,res,next)
  expect(res.status).toHaveBeenCalledWith(409);expect(next).not.toHaveBeenCalled()
})
it("permits ordinary name edits and signup consent, but not forged import stamps", async () => {
  const next=jest.fn(); const res:any={status:jest.fn().mockReturnThis(),json:jest.fn()}
  await guardCustomerContactWrite({body:{first_name:"Synthetic"}} as any,res,next)
  guardCustomerProvenanceCreate({body:{metadata:{sms_consent:true}}} as any,res,next)
  guardCustomerProvenanceCreate({body:{metadata:{contact_verified_at:date}}} as any,res,next)
  expect(next).toHaveBeenCalledTimes(2);expect(res.status).toHaveBeenCalledWith(400)
})
it.each([{}, {actor_id:"other", actor_type:"user"}])("refuses unauthenticated/non-customer actors", async (actor) => {
  const res:any={status:jest.fn().mockReturnThis(),json:jest.fn()}; const resolve=jest.fn()
  await POST({auth_context:actor,scope:{resolve}} as any,res)
  expect(res.status).toHaveBeenCalledWith(401);expect(resolve).not.toHaveBeenCalled()
})

it("default-off contact endpoint is a 404 compatibility response without a mutation", async () => {
  delete process.env.GP_PRIMARY_CONTACT_ENABLED
  const res:any={status:jest.fn().mockReturnThis(),json:jest.fn()}, resolve=jest.fn()
  await POST({auth_context:{actor_id:"cus_fixture",actor_type:"customer"},scope:{resolve}} as any,res)
  expect(res.status).toHaveBeenCalledWith(404); expect(resolve).not.toHaveBeenCalled()
})
it.each([false,true])("default-off native phone edits preserve confirmed contact protection: %s", async confirmed => {
  delete process.env.GP_PRIMARY_CONTACT_ENABLED
  const query:any={};for(const m of ["select","where","whereNull"])query[m]=()=>query
  query.first=async()=>({metadata:confirmed?{primary_contact_v1:primary}:{}})
  const res:any={status:jest.fn().mockReturnThis(),json:jest.fn()},next=jest.fn()
  await guardCustomerContactWrite({body:{phone:"4045550100"},auth_context:{actor_id:"cus_fixture",actor_type:"customer"},scope:{resolve:()=>()=>query}} as any,res,next)
  if(confirmed){expect(res.status).toHaveBeenCalledWith(409);expect(next).not.toHaveBeenCalled()}else expect(next).toHaveBeenCalledTimes(1)
})
it("off-mode legacy writes cannot forge new attestation metadata", async () => {
  delete process.env.GP_PRIMARY_CONTACT_ENABLED
  const res:any={status:jest.fn().mockReturnThis(),json:jest.fn()},next=jest.fn()
  await guardCustomerContactWrite({body:{metadata:{primary_contact_v1:primary}}} as any,res,next)
  expect(res.status).toHaveBeenCalledWith(409);expect(next).not.toHaveBeenCalled()
})
