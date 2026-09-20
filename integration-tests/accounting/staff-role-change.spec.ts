import { randomUUID } from "node:crypto"
import { changeStaffRole } from "../../src/lib/staff-role-change"
import { staffCapabilities, staffSessionIsCurrent } from "../../src/lib/staff-access-policy"
import type { StaffPrincipal } from "../../src/lib/staff-principal"

const knex = require("knex")
const schema = `gp_staff_${randomUUID().replace(/-/g, "")}`
const originalEnv = { ...process.env }
let db: any, admin: any
const owner: StaffPrincipal = { id: "cus_owner", kind: "customer", role: "super_admin", email: "owner@example.test", name: "Fixture Owner",
  capabilities: new Set(["team.manage"]), transport_id: "apk_gateway", auth: { iat: Math.floor(Date.now() / 1000) - 30 } }
const recovery: StaffPrincipal = { ...owner, id: "usr_recovery", kind: "operator", email: "recovery@example.test", name: "Fixture Recovery" }
const input = (extra: Record<string, any> = {}) => ({ role: "customer", reason: "Authorized fixture revocation", confirmation: "REMOVE STAFF", expected_version: 0, ...extra })

beforeAll(async () => {
  const url = process.env.QBD_TEST_DATABASE_URL, socket = process.env.QBD_TEST_PG_SOCKET
  if (!url && !socket) throw new Error("Supply an isolated QBD_TEST_DATABASE_URL or QBD_TEST_PG_SOCKET, never DATABASE_URL.")
  const connection = url || { host: socket, port: 55431, user: "gp_launch_test", database: "gp_launch" }
  admin = knex({ client: "pg", connection }); await admin.raw(`create schema ${schema}`)
  db = knex({ client: "pg", connection, searchPath: [schema], pool: { min: 0, max: 8 } })
  await db.raw(`create table customer (id text primary key, email text, metadata jsonb, deleted_at timestamptz, updated_at timestamptz,
    constraint reject_fixture_grant check (coalesce(metadata->>'gp_staff_role','') <> 'packer'))`)
})
beforeEach(async () => {
  process.env.GP_PRIVILEGED_ADMIN_USER_IDS = "usr_recovery"
  process.env.GP_STAFF_BOOTSTRAP_CUSTOMER_IDS = "cus_bootstrap"
  await db("customer").delete()
  await db("customer").insert([
    { id: "cus_owner", email: "owner@example.test", metadata: JSON.stringify({ gp_staff_role: "super_admin" }) },
    { id: "cus_bootstrap", email: "bootstrap@example.test", metadata: JSON.stringify({ contact_preference: "email" }) },
  ])
})
afterAll(async () => {
  process.env = originalEnv
  if (db) await db.destroy()
  if (admin) { await admin.raw(`drop schema if exists ${schema} cascade`); await admin.destroy() }
})

it("revokes bootstrap powers, commits the person and cutoff, and preserves ordinary profile data", async () => {
  const result = await changeStaffRole(db, owner, "cus_bootstrap", input({ staff_actor_id: "forged" }))
  const stored = await db("customer").where({ id: "cus_bootstrap" }).first()
  expect(staffCapabilities(stored).size).toBe(0)
  expect(stored.metadata).toMatchObject({ contact_preference: "email", staff_access_revoked: true, staff_bootstrap_override: true, staff_access_version: 1 })
  expect(staffSessionIsCurrent(stored, owner.auth)).toBe(false)
  expect(JSON.parse(stored.metadata.staff_access_audit_log)).toEqual([expect.objectContaining({ staff_actor_id: owner.id, actor_kind: "customer", previous_role: "super_admin", role: "customer", reason: "Authorized fixture revocation" })])
  expect(result.reauthentication_required).toBe(true)
})
it("lets the separate operator recover without reviving old sessions or silently restoring bootstrap owner powers", async () => {
  await changeStaffRole(db, owner, "cus_bootstrap", input())
  await changeStaffRole(db, recovery, "cus_bootstrap", input({ role: "manager", confirmation: "MANAGER", expected_version: 1, final_charge_enabled: true }))
  const stored = await db("customer").where({ id: "cus_bootstrap" }).first()
  expect(staffCapabilities(stored).has("charge")).toBe(true)
  expect(staffCapabilities(stored).has("team.manage")).toBe(false)
  expect(staffSessionIsCurrent(stored, owner.auth)).toBe(false)
  expect(JSON.parse(stored.metadata.staff_access_audit_log)).toHaveLength(2)
  expect(JSON.parse(stored.metadata.staff_access_audit_log)[1]).toMatchObject({ recovery: true, staff_actor_id: "usr_recovery", actor_kind: "operator" })
})
it("serializes conflicting role changes and does not lose an audit row", async () => {
  const results = await Promise.allSettled([changeStaffRole(db, owner, "cus_bootstrap", input()), changeStaffRole(db, recovery, "cus_bootstrap", input({ role: "office", confirmation: "OFFICE" }))])
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
  expect(JSON.parse((await db("customer").where({ id: "cus_bootstrap" }).first()).metadata.staff_access_audit_log)).toHaveLength(1)
})
it("rolls back the role, epoch and audit together on a database rejection", async () => {
  await expect(changeStaffRole(db, owner, "cus_bootstrap", input({ role: "packer", confirmation: "PACKER" }))).rejects.toThrow("reject_fixture_grant")
  expect((await db("customer").where({ id: "cus_bootstrap" }).first()).metadata).toEqual({ contact_preference: "email" })
})
it("rechecks an owner's revoked authority under the customer lock before any grant", async () => {
  await db("customer").where({ id: "cus_owner" }).update({ metadata: JSON.stringify({ gp_staff_role: "super_admin", staff_access_revoked: true }) })
  await expect(changeStaffRole(db, owner, "cus_bootstrap", input())).rejects.toThrow("staff access changed")
  expect((await db("customer").where({ id: "cus_bootstrap" }).first()).metadata).toEqual({ contact_preference: "email" })
})
it("requires the separate recovery configuration, confirmation, current version and forbids self-demotion", async () => {
  await expect(changeStaffRole(db, owner, "cus_owner", input())).rejects.toThrow("own super admin")
  await expect(changeStaffRole(db, owner, "cus_bootstrap", input({ confirmation: "WRONG" }))).rejects.toThrow("required confirmation")
  await expect(changeStaffRole(db, owner, "cus_bootstrap", input({ expected_version: 9 }))).rejects.toThrow("changed since")
  process.env.GP_PRIVILEGED_ADMIN_USER_IDS = ""
  await expect(changeStaffRole(db, owner, "cus_bootstrap", input())).rejects.toThrow("separate recovery")
  expect((await db("customer").where({ id: "cus_bootstrap" }).first()).metadata).toEqual({ contact_preference: "email" })
})
