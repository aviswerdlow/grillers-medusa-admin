import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { changePrimaryContact, parseContactChange } from "../../src/lib/customer-primary-contact"
import { CONTACT_CONFIRMATION_VERSION } from "../../src/lib/customer-contact-state"
import { findLegacyImportCustomer } from "../../src/lib/legacy-contact-provenance"
import { upsertCustomerProfile } from "../../src/lib/communications/core"
import { permitsCustomerSmsDestination } from "../../src/lib/communications/primary-destination"

const knex = require("knex")
const schema = `gp_contact_${randomUUID().replace(/-/g,"")}`
let db:any, admin:any
beforeAll(async () => {
  const url = process.env.CONTACT_TEST_DATABASE_URL
  const socket = process.env.CONTACT_TEST_PG_SOCKET
  if (!url && !socket) throw new Error("Explicit isolated contact-test database required")
  const connection = url || { host: socket, port: 55465, user: "gp_contact_test", database: "gp_contacts" }
  admin=knex({client:"pg",connection});await admin.raw(`create schema ${schema}`)
  db=knex({client:"pg",connection,searchPath:[schema],pool:{min:0,max:8}})
  // Use installed native customer SQL and the actual communications migration.
  const native=fs.readFileSync(path.join(path.dirname(require.resolve("@medusajs/customer/package.json")),"dist/migrations/Migration20240124154000.js"),"utf8")
  for (const table of ["customer","customer_address"]) {
    const sql=native.match(new RegExp(`this.addSql\\('([^']*create table if not exists "${table}"[^']*)'\\)`))?.[1]
    if (!sql) throw new Error(`Native table SQL missing: ${table}`)
    await db.raw(sql)
  }
  await db.raw('alter table customer_address add column deleted_at timestamptz null')
  const migration=fs.readFileSync(path.join(process.cwd(),"src/modules/gp-communications/migrations/Migration20260526120000.ts"),"utf8")
  for (const match of migration.matchAll(/this\.addSql\(`([\s\S]*?)`\)/g)) {
    if (/create table if not exists "(gp_customer_profile|gp_communication_event)"/.test(match[1]) ||
        /create unique index[^;]*on "(gp_customer_profile|gp_communication_event)"/i.test(match[1])) await db.raw(match[1])
  }
})
afterAll(async () => {if(db)await db.destroy();if(admin){await admin.raw(`drop schema if exists ${schema} cascade`);await admin.destroy()}})
beforeEach(async () => {
  for (const table of ["gp_communication_event","gp_customer_profile","customer_address","customer"]) await db(table).delete()
  await db("customer").insert({ id:"cus_test", email:"synthetic@example.invalid",phone:"4045550100",metadata:{legacy_source:"legacy_site_customers",legacy_customer_id:"source-1"} })
  await db("customer_address").insert({id:"addr_test",customer_id:"cus_test",address_1:"1 Test Street",is_default_shipping:true})
})
const request=(extra:any={})=>parseContactChange({phone:"4045550101",expected_revision:0,request_id:randomUUID(),sms_marketing_opt_in:false,...extra})
const customer=()=>db("customer").where({id:"cus_test"}).first()
const profile=()=>db("gp_customer_profile").where({medusa_customer_id:"cus_test"}).first()

it("atomically records one primary mobile, declined marketing and confirmation, and replays once",async()=>{
 const input=request({confirmation:{version:CONTACT_CONFIRMATION_VERSION,address_id:"addr_test",preferred_email:"pending@example.invalid"}})
 expect(await changePrimaryContact(db,"cus_test",input)).toMatchObject({revision:1,replayed:false})
 const c=await customer(),p=await profile()
 expect(c.phone).toBe(p.phone);expect(p.sms_consent).toBe(false)
 expect(c.metadata.contact_confirmation_v2.status).toBe("confirmed")
 expect(c.metadata.primary_contact_v1.possession_verified_at).toBeNull()
 expect(c.metadata.preferred_contact_email_request.status).toBe("pending_verification")
 expect(c.email).toBe("synthetic@example.invalid")
 expect(await changePrimaryContact(db,"cus_test",input)).toMatchObject({revision:1,replayed:true})
 expect(await db("gp_communication_event")).toHaveLength(1)
})
it("competing changes have one winner; a stale replay cannot revert a later edit",async()=>{
 const first=request(); const result=await Promise.allSettled([changePrimaryContact(db,"cus_test",first),changePrimaryContact(db,"cus_test",request())])
 expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1)
 await changePrimaryContact(db,"cus_test",request({expected_revision:1,phone:"4045550102"}))
 await expect(changePrimaryContact(db,"cus_test",first)).rejects.toMatchObject({status:409})
 expect((await customer()).phone).toBe("4045550102")
})
it("rolls back both records if durable audit cannot commit",async()=>{
 await db.raw("alter table gp_communication_event add constraint reject_contact_test check (event_name <> 'primary_contact_confirmed')")
 try {await expect(changePrimaryContact(db,"cus_test",request())).rejects.toThrow()} finally {await db.raw('alter table gp_communication_event drop constraint reject_contact_test')}
 expect((await customer()).phone).toBe("4045550100");expect(await profile()).toBeUndefined()
})
it("does not reuse another account's address or profile",async()=>{
 await expect(changePrimaryContact(db,"cus_test",request({confirmation:{version:CONTACT_CONFIRMATION_VERSION,address_id:"addr_other"}}))).rejects.toMatchObject({status:400})
 await db("gp_customer_profile").insert({id:"profile_other",medusa_customer_id:"cus_other",email_lower:"synthetic@example.invalid"})
 await expect(changePrimaryContact(db,"cus_test",request())).rejects.toThrow("identity conflict")
 expect((await db("gp_customer_profile").first()).medusa_customer_id).toBe("cus_other")
})
it("does not transfer consent, redirect historical order texts or revive a retired number",async()=>{
 await changePrimaryContact(db,"cus_test",request({sms_marketing_opt_in:true}))
 const first=await customer()
 expect(await permitsCustomerSmsDestination(db,"cus_test","4045550100",new Date().toISOString())).toBe(false)
 expect(await permitsCustomerSmsDestination(db,"cus_test","4045550101",first.metadata.primary_contact_v1.attested_at)).toBe(true)
 await changePrimaryContact(db,"cus_test",request({expected_revision:1,phone:"4045550102",sms_marketing_opt_in:false}))
 expect((await profile()).sms_consent).toBe(false)
 expect(await permitsCustomerSmsDestination(db,"cus_test","4045550101",new Date().toISOString())).toBe(false)
 expect(await permitsCustomerSmsDestination(db,"cus_test","4045550102","2020-01-01T00:00:00.000Z")).toBe(false)
})
it("ignores stale subscriber phone/consent snapshots after the authoritative transaction",async()=>{
 await changePrimaryContact(db,"cus_test",request({sms_marketing_opt_in:false}))
 await upsertCustomerProfile(db,{medusa_customer_id:"cus_test",phone:"4045550100",sms_consent:true,sms_consent_at:"2026-09-19T12:00:00.000Z",metadata:{sms_consent_phone:"4045550100",sms_consent_at:"2026-09-19T12:00:00.000Z"}})
 const p=await profile();expect(p.phone).toBe("4045550101");expect(p.sms_consent).toBe(false);expect(p.metadata.sms_consent_phone).toBe("4045550101")
})
it("never joins separate accounts by a shared phone",async()=>{
 await db("customer").insert({id:"cus_other",email:"other@example.invalid",phone:"4045550101",metadata:{}})
 await changePrimaryContact(db,"cus_test",request())
 await changePrimaryContact(db,"cus_other",request())
 expect(await db("gp_customer_profile")).toHaveLength(2)
 const rows=await db("gp_customer_profile").select("medusa_customer_id")
 expect(new Set(rows.map((r:any)=>r.medusa_customer_id)).size).toBe(2)
})
it("uses stable import identity and holds ambiguous/email-only mappings before writes",async()=>{
 expect((await findLegacyImportCustomer(db,"source-1","synthetic@example.invalid")).id).toBe("cus_test")
 await expect(findLegacyImportCustomer(db,"source-2","synthetic@example.invalid")).rejects.toThrow("requires_reviewed_mapping")
 await expect(findLegacyImportCustomer(db,"source-1","changed@example.invalid")).rejects.toThrow("source_email_changed")
 expect(await findLegacyImportCustomer(db,"source-3","new@example.invalid")).toBeNull()
})


describe("profile identity rollout compatibility", () => {
  const previous = process.env.GP_PRIMARY_CONTACT_ENABLED
  afterEach(() => {
    if (previous === undefined) delete process.env.GP_PRIMARY_CONTACT_ENABLED
    else process.env.GP_PRIMARY_CONTACT_ENABLED = previous
  })
  it("preserves the legacy email association while contact activation is off", async () => {
    delete process.env.GP_PRIMARY_CONTACT_ENABLED
    await db("gp_customer_profile").insert({ id: "profile_legacy", medusa_customer_id: "cus_old", email_lower: "synthetic@example.invalid" })
    const updated = await upsertCustomerProfile(db, { medusa_customer_id: "cus_test", email: "synthetic@example.invalid" })
    expect(updated?.medusa_customer_id).toBe("cus_test")
  })
  it.each(["enabled", "attested", "explicit"])("holds a conflicting profile when %s", async mode => {
    delete process.env.GP_PRIMARY_CONTACT_ENABLED
    if (mode === "enabled") process.env.GP_PRIMARY_CONTACT_ENABLED = "true"
    await db("gp_customer_profile").insert({ id: "profile_legacy", medusa_customer_id: "cus_old", email_lower: "synthetic@example.invalid",
      metadata: mode === "attested" ? { primary_contact_v1: { version: 1, revision: 1 } } : {} })
    await expect(upsertCustomerProfile(db, { medusa_customer_id: "cus_test", email: "synthetic@example.invalid" },
      { requireIdentityMatch: mode === "explicit" })).rejects.toThrow("identity conflict")
    expect((await db("gp_customer_profile").first()).medusa_customer_id).toBe("cus_old")
  })
})
