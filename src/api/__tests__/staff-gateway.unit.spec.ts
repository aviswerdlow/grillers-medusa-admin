import path from "node:path"
import type { Server } from "node:http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import middlewares from "../middlewares"
import { verifiedStaffAuditFields } from "../../lib/staff-principal"
import { staffBoundaryMode } from "../../lib/staff-boundary-rollout"
import { staffAuditFields } from "../admin/grillers/orders/[id]/finalization/utils"

jest.mock("../../lib/ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true })) }))
const captureRun = jest.fn(async () => ({}))
jest.mock("@medusajs/core-flows", () => ({ ...jest.requireActual("@medusajs/core-flows"), capturePaymentWorkflow: () => ({ run: captureRun }) }))
const express = require("express"), jwt = require("jsonwebtoken")
const medusaRoot = path.dirname(require.resolve("@medusajs/medusa/package.json"))
const nativeCapture = require(path.join(medusaRoot, "dist/api/admin/payments/[id]/capture/route.js"))
const nativeRefresh = require(path.join(medusaRoot, "dist/api/auth/token/refresh/route.js"))
const nativeSession = require(path.join(medusaRoot, "dist/api/auth/session/route.js"))
const nativeInviteMiddlewares = require(path.join(medusaRoot, "dist/api/admin/invites/middlewares.js")).adminInviteRoutesMiddlewares
const { RoutesSorter } = require(path.join(path.dirname(require.resolve("@medusajs/framework/http")), "routes-sorter.js"))

describe("Staff gateway (installed Medusa authentication and native handlers)", () => {
  const originalEnv = { ...process.env }
  const secret = "isolated-gateway-fixture-secret"
  let server: Server, baseUrl: string
  let customers: Record<string, any>
  const warn = jest.fn()
  const effects = jest.fn(), customerRead = jest.fn(), userRead = jest.fn()
  const authRead = jest.fn(async (id: string) => id === "auth_unregistered"
    ? { id, app_metadata: {} } : { id: "auth_fixture", app_metadata: { customer_id: "cus_staff" } })
  const now = () => Math.floor(Date.now() / 1000)
  const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next)

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use((req: any, _res: any, next: any) => {
      req.scope = { resolve(key: string) {
        if (key === "logger") return { warn }
        if (key === ContainerRegistrationKeys.CONFIG_MODULE) return { projectConfig: { http: { jwtSecret: secret, jwtExpiresIn: "1h" } } }
        if (key === Modules.API_KEY) return { authenticate: async (token: string) => token === "sk_gateway" ? { id: "apk_gateway" } : token === "sk_reader" ? { id: "apk_reader" } : token === "sk_parity" ? { id: "apk_parity" } : token === "sk_unknown" ? { id: "apk_unknown" } : null }
        if (key === Modules.CUSTOMER) return { retrieveCustomer: customerRead }
        if (key === Modules.USER) return { retrieveUser: userRead }
        if (key === Modules.AUTH) return { retrieveAuthIdentity: authRead }
        if (key === ContainerRegistrationKeys.REMOTE_QUERY) return async () => [{ id: "pay_fixture" }]
        throw new Error(`Unexpected dependency ${key}`)
      } }
      req.queryConfig = { fields: ["id"] }; req.session = {}; next()
    })
    // Use the production registrations in Medusa's actual sorted order. Select
    // only these boundary routes; unrelated order/Stripe guards have their own tests.
    const selected = middlewares.routes!.filter((r: any) => r.matcher === "/admin/*" || r.matcher.startsWith("/admin/customers")
      || r.matcher === "/auth/token/refresh" || r.matcher === "/auth/session" || (r.matcher === "/store/customers/me" && r.methods.includes("GET")))
    for (const route of new RoutesSorter(selected).sort()) {
      if (!route.methods?.length || route.methods.includes("ALL")) app.use(route.matcher, ...route.middlewares.map(wrap))
      else for (const method of route.methods) app[method.toLowerCase()](route.matcher, ...route.middlewares.map(wrap))
    }
    const inviteAccept = nativeInviteMiddlewares.find((r: any) => r.matcher === "/admin/invites/accept" && r.method === "POST")
    app.post(inviteAccept.matcher, ...inviteAccept.middlewares.map(wrap), (req: any, res: any) =>
      res.json({ auth_identity_id: req.auth_context?.auth_identity_id, actor_id: req.auth_context?.actor_id || null }))
    app.post("/admin/payments/:id/capture", (req: any, _res: any, next: any) => { req.validatedBody = req.body; next() }, wrap(nativeCapture.POST))
    app.post("/auth/token/refresh", wrap(nativeRefresh.POST))
    app.post("/auth/session", wrap(nativeSession.POST))
    app.get("/store/customers/me", (_req: any, res: any) => res.json({ customer: { id: "cus_staff", metadata: { gp_staff_role: "super_admin" } } }))
    app.all("/admin/*", (req: any, res: any) => { effects(req.path, req.body); res.json({ actor: verifiedStaffAuditFields(req), finalization_actor: staffAuditFields(req, req.body), body: req.body }) })
    app.use((error: Error, _req: any, res: any, _next: any) => res.status(500).json({ message: error.message }))
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)) })
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  })
  beforeEach(() => {
    process.env.GP_STAFF_BOUNDARY_MODE = "enforce"
    jest.clearAllMocks()
    process.env.GP_STAFF_GATEWAY_API_KEY_ID = "apk_gateway"
    process.env.GP_ADMIN_READ_ONLY_API_KEY_IDS = "apk_reader"
    process.env.GP_PARITY_READ_API_KEY_IDS = "apk_parity"
    process.env.GP_PRIVILEGED_ADMIN_USER_IDS = "usr_recovery"
    process.env.GP_STAFF_BOOTSTRAP_CUSTOMER_IDS = "cus_bootstrap"
    customers = { cus_staff: { id: "cus_staff", email: "staff@example.test", first_name: "Fixture", last_name: "Manager", metadata: { gp_staff_role: "manager" } },
      cus_bootstrap: { id: "cus_bootstrap", metadata: {} }, cus_target: { id: "cus_target", metadata: {} } }
    customerRead.mockImplementation(async id => customers[id] || null)
    userRead.mockImplementation(async id => ({ id, email: "recovery@example.test" }))
  })
  afterAll(async () => { process.env = originalEnv; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) })

  function token(payload: any = {}, key = secret) {
    return jwt.sign(Object.fromEntries(Object.entries({ actor_type: "customer", actor_id: "cus_staff", auth_identity_id: "auth_fixture", iat: now() - 10, exp: now() + 3600, ...payload }).filter(([, value]) => value !== undefined)), key)
  }
  async function request(route: string, options: { method?: string; body?: any; key?: string; token?: string | null; authorization?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: options.authorization || `Basic ${Buffer.from(`${options.key || "sk_gateway"}:`).toString("base64")}` }
    if (options.token !== null) headers["x-gp-staff-authorization"] = `Bearer ${options.token || token()}`
    const res = await fetch(baseUrl + route, { method: options.method || "POST", headers, ...(options.method === "GET" ? {} : { body: JSON.stringify(options.body || { staff_actor_customer_id: "forged_owner", staff_actor_email: "forged@example.test", staff_actor_name: "Forged" }) }) })
    return { status: res.status, body: await res.json().catch(() => ({})) as any }
  }
  const moneyAndIdentityRoutes = ["/admin/payments/pay_fixture/capture", "/admin/grillers/payments/pay_fixture/refund", "/admin/customers/cus_target",
    "/admin/grillers/staff-access/customers/cus_target", "/admin/grillers/orders/order_fixture/accounting-action", "/admin/grillers/orders/order_fixture/finalization/charge-and-release"]

  it.each(["customer", "picker", "packer", "merchandising_reviewer"])("denies %s direct money/customer/role/accounting actions with no workflow or target effect", async role => {
    customers.cus_staff.metadata = { gp_staff_role: role, staff: true }
    for (const route of moneyAndIdentityRoutes) expect((await request(route)).status).toBe(403)
    expect(captureRun).not.toHaveBeenCalled(); expect(effects).not.toHaveBeenCalled()
    expect(customerRead.mock.calls.every(([id]) => id === "cus_staff")).toBe(true)
  })
  it("runs the native capture handler with the actual manager, never the shared key or forged actor", async () => {
    expect((await request("/admin/payments/pay_fixture/capture", { body: { amount: 7, staff_actor_id: "forged" } })).status).toBe(200)
    expect(captureRun).toHaveBeenCalledWith({ input: { payment_id: "pay_fixture", captured_by: "cus_staff", amount: 7 } })
  })
  it("binds custom finalization/audit helpers to the same named person", async () => {
    const result = await request("/admin/grillers/orders/order_fixture/finalization/preview")
    expect(result.status).toBe(200)
    expect(result.body.actor).toEqual({ staff_actor_id: "cus_staff", staff_actor_customer_id: "cus_staff", staff_actor_email: "staff@example.test", staff_actor_name: "Fixture Manager" })
    expect(result.body.finalization_actor).toEqual(result.body.actor)
  })
  it("keeps charge, packing, support and team powers separate", async () => {
    customers.cus_staff.metadata = { gp_staff_role: "picker", final_charge_enabled: true }
    expect((await request(moneyAndIdentityRoutes[5])).status).toBe(200)
    expect((await request("/admin/grillers/orders/o/finalization/start", { body: { phase: "pack" } })).status).toBe(403)
    expect((await request("/admin/grillers/orders/o/finalization/packages")).status).toBe(403)
    expect((await request(moneyAndIdentityRoutes[1])).status).toBe(403)
    expect((await request(moneyAndIdentityRoutes[3])).status).toBe(403)
  })
  it("permits the existing office support scope but does not infer final charge", async () => {
    customers.cus_staff.metadata = { gp_staff_role: "office", final_charge_enabled: true }
    expect((await request(moneyAndIdentityRoutes[0])).status).toBe(200)
    expect((await request(moneyAndIdentityRoutes[5])).status).toBe(403)
  })
  it.each(["/admin/api-keys", "/admin/users", "/admin/orders/o", "/admin/orders/o/metadata", "/admin/payments/p/refund", "/admin/unknown-plugin"])("denies an owner the unscoped gateway route %s", async route => {
    customers.cus_staff.metadata = { gp_staff_role: "super_admin" }
    expect((await request(route)).status).toBe(403); expect(effects).not.toHaveBeenCalled()
  })
  it.each(["missing", "forged", "expired", "wrong actor", "future issued", "no expiry"])("denies a %s customer token before data/payment effects", async kind => {
    const t = kind === "missing" ? null : kind === "forged" ? token({}, "different-secret") : kind === "expired" ? token({ exp: now() - 1 })
      : kind === "wrong actor" ? token({ actor_type: "user" }) : kind === "future issued" ? token({ iat: now() + 30 }) : token({ exp: undefined })
    expect((await request(moneyAndIdentityRoutes[0], { token: t })).status).toBe(403)
    expect(customerRead).not.toHaveBeenCalled(); expect(captureRun).not.toHaveBeenCalled()
  })
  it("denies the signed staff token over any other API key", async () => {
    for (const key of ["sk_reader", "sk_unknown"]) expect((await request("/admin/orders", { key, method: "GET" })).status).toBe(403)
    expect(effects).not.toHaveBeenCalled()
  })
  it("gives the reader only enumerated non-mutating discovery", async () => {
    expect((await request("/admin/products", { key: "sk_reader", token: null, method: "GET" })).status).toBe(200)
    expect((await request("/admin/products", { key: "sk_reader", token: null })).status).toBe(403)
    expect((await request("/admin/grillers/orders/o/finalization", { key: "sk_reader", token: null, method: "GET" })).status).toBe(403)
    process.env.GP_ADMIN_READ_ONLY_API_KEY_IDS = "apk_gateway"
    expect((await request("/admin/products", { token: null, method: "GET" })).status).toBe(403)
  })
  it.each(["log", "enforce"])("applies the reader GET allow-list in %s mode", async mode => {
    process.env.GP_STAFF_BOUNDARY_MODE = mode
    expect((await request("/admin/products", { key: "sk_reader", token: null, method: "GET" })).status).toBe(200)
    expect((await request("/admin/invites", { key: "sk_reader", token: null, method: "GET" })).status).toBe(403)
    expect((await request("/admin/products/", { key: "sk_reader", token: null, method: "GET" })).status).toBe(403)
  })
  it.each(["log", "enforce"])("applies the native reader GET allow-list in %s mode", async mode => {
    process.env.GP_STAFF_BOUNDARY_MODE = mode
    process.env.GP_ADMIN_READ_ONLY_USER_IDS = "usr_reader"
    const authorization = `Bearer ${token({ actor_type: "user", actor_id: "usr_reader" })}`
    expect((await request("/admin/orders?limit=1", { authorization, token: null, method: "GET" })).status).toBe(200)
    expect((await request("/admin/invites", { authorization, token: null, method: "GET" })).status).toBe(403)
    expect((await request("/admin/products", { authorization, token: null })).status).toBe(403)
  })
  it.each(["log", "enforce"])("blocks native draft conversion while institutional terms are off in %s mode", async mode => {
    process.env.GP_STAFF_BOUNDARY_MODE = mode
    delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
    expect((await request("/admin/draft-orders/draft_fixture/convert-to-order")).status).toBe(403)
    expect(effects).not.toHaveBeenCalled()
  })
  it.each(["/ADMIN/products", "/admin/%70roducts", "/admin//products", "/admin/products/"])("never grants a reader a nonliteral route %s", async route => {
    const result = await request(route, { key: "sk_reader", token: null, method: "GET" })
    expect(result.status).not.toBe(200)
    expect(effects).not.toHaveBeenCalled()
  })
  it("restricts a parity key to the original-order GET even when also listed as a broad reader", async () => {
    process.env.GP_ADMIN_READ_ONLY_API_KEY_IDS = "apk_reader,apk_parity"
    const route = "/admin/grillers/analytics/order-promises"
    expect((await request(route, { key: "sk_parity", token: null, method: "GET" })).status).toBe(200)
    for (const path of ["/admin/orders", "/admin/orders/o", "/admin/customers", "/admin/products", "/admin/grillers/inventory/allocations"]) {
      expect((await request(path, { key: "sk_parity", token: null, method: "GET" })).status).toBe(403)
    }
    expect((await request(route, { key: "sk_parity", token: null })).status).toBe(403)
    expect((await request(route, { key: "sk_reader", token: null, method: "GET" })).status).toBe(403)
    expect((await request(route, { method: "GET" })).status).toBe(403)
    expect((await request(route, { key: "sk_parity", method: "GET" })).status).toBe(403)
    process.env.GP_PARITY_READ_API_KEY_IDS = ""
    process.env.GP_ADMIN_READ_ONLY_API_KEY_IDS = "apk_reader"
    expect((await request(route, { key: "sk_parity", token: null, method: "GET" })).status).toBe(403)
  })
  it("separates incoming-stock review from writes and denies background readers", async () => {
    const route = "/admin/grillers/inventory/incoming"
    expect((await request(route, { method: "GET" })).status).toBe(200)
    expect((await request(route)).status).toBe(403)
    customers.cus_staff.metadata = { gp_staff_role: "super_admin" }
    expect((await request(route)).status).toBe(200)
    expect((await request(route, { method: "DELETE" })).status).toBe(403)
    expect((await request(route, { key: "sk_reader", token: null, method: "GET" })).status).toBe(403)
    // This tests the gateway boundary only. The real command independently
    // requires a configured receiving operator and rechecks revocation in SQL.
  })
  it("requires an explicitly configured, existing native recovery operator", async () => {
    const authorization = `Bearer ${token({ actor_type: "user", actor_id: "usr_recovery" })}`
    expect((await request("/admin/users", { authorization, token: null })).status).toBe(200)
    process.env.GP_PRIVILEGED_ADMIN_USER_IDS = ""
    expect((await request("/admin/users", { authorization, token: null })).status).toBe(403)
  })
  it("leaves exactly POST /admin/invites/accept to Medusa's unregistered-user middleware", async () => {
    const authorization = `Bearer ${token({ actor_type: "user", actor_id: undefined, auth_identity_id: "auth_unregistered" })}`
    const result = await request("/admin/invites/accept?token=fixture-invite", {
      authorization, token: null, body: { email: "recovery@example.test" },
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ auth_identity_id: "auth_unregistered", actor_id: null })
    expect(effects).not.toHaveBeenCalled()
  })
  it.each([
    ["GET", "/admin/invites/accept"], ["POST", "/admin/invites/accept/"],
    ["POST", "/admin/invites"], ["GET", "/admin/users"],
    ["GET", "/admin/orders"], ["POST", "/admin/grillers/staff-access/customers/cus_target"],
  ])("still requires a registered user for %s %s", async (method, route) => {
    const authorization = `Bearer ${token({ actor_type: "user", actor_id: undefined, auth_identity_id: "auth_unregistered" })}`
    expect((await request(route, { method, authorization, token: null, body: { email: "recovery@example.test" } })).status).toBe(401)
    expect(effects).not.toHaveBeenCalled()
  })
  it.each(["/ADMIN/invites/accept", "/admin/invites/%61ccept", "/admin//invites/accept"])("does not exempt a nonliteral invite path %s", async route => {
    const authorization = `Bearer ${token({ actor_type: "user", actor_id: undefined, auth_identity_id: "auth_unregistered" })}`
    expect((await request(route, { authorization, token: null })).status).not.toBe(200)
    expect(effects).not.toHaveBeenCalled()
  })
  it("denies when fresh grant lookup is unavailable", async () => {
    customerRead.mockRejectedValueOnce(new Error("isolated database outage"))
    expect((await request(moneyAndIdentityRoutes[0])).status).toBe(503); expect(captureRun).not.toHaveBeenCalled()
  })
  it("revokes all privileged replay paths and does not revive old JWTs after regrant", async () => {
    const old = token(), cutoff = now() - 2
    expect((await request(moneyAndIdentityRoutes[0], { token: old })).status).toBe(200)
    captureRun.mockClear()
    customers.cus_staff.metadata = { gp_staff_role: "super_admin", staff_access_revoked: true, staff_access_valid_after: cutoff }
    for (const route of moneyAndIdentityRoutes) expect((await request(route, { token: old })).status).toBe(403)
    customers.cus_staff.metadata.staff_access_revoked = false
    expect((await request(moneyAndIdentityRoutes[0], { token: old })).status).toBe(403)
    expect(captureRun).not.toHaveBeenCalled()
    expect((await request(moneyAndIdentityRoutes[0], { token: token({ iat: now() }) })).status).toBe(200)
  })
  it("uses immutable bootstrap IDs and honors bootstrap demotion/revocation", async () => {
    customers.cus_staff.email = "peter@grillerspride.com"; customers.cus_staff.metadata = { role: "customer" }
    expect((await request(moneyAndIdentityRoutes[3])).status).toBe(403)
    expect((await request(moneyAndIdentityRoutes[3], { token: token({ actor_id: "cus_bootstrap" }) })).status).toBe(200)
    customers.cus_bootstrap.metadata = { gp_staff_role: "office", staff_bootstrap_override: true }
    expect((await request(moneyAndIdentityRoutes[3], { token: token({ actor_id: "cus_bootstrap" }) })).status).toBe(403)
    customers.cus_bootstrap.metadata = { staff_access_revoked: true }
    expect((await request(moneyAndIdentityRoutes[0], { token: token({ actor_id: "cus_bootstrap" }) })).status).toBe(403)
  })
  it.each(["/auth/token/refresh", "/auth/session"])("prevents stale registered and pre-registration tokens using %s", async route => {
    customers.cus_staff.metadata.staff_access_valid_after = now() - 2
    for (const actor_id of ["cus_staff", ""]) {
      const result = await request(route, { token: null, authorization: `Bearer ${token({ actor_id })}` })
      expect([401, 403]).toContain(result.status); expect(result.body.token).toBeUndefined()
    }
    expect((await request(route, { token: null, authorization: `Bearer ${token({ iat: now() })}` })).status).toBe(200)
  })
  it("reports stale authority without an admin fallback or a stale metadata grant", async () => {
    customers.cus_staff.metadata.staff_access_valid_after = now() - 2
    const result = await request("/store/customers/me", { method: "GET", token: null, authorization: `Bearer ${token()}` })
    expect(result.status).toBe(200); expect(result.body.customer.staff_access).toMatchObject({ role: "customer", session_current: false, final_charge_enabled: false })
  })
  it("blocks generic authority writes even for an owner and strips unchanged stale grant snapshots", async () => {
    customers.cus_staff.metadata.gp_staff_role = "super_admin"
    customers.cus_target.metadata = { gp_staff_role: "customer", staff_access_version: 4 }
    expect((await request("/admin/customers/cus_target", { body: { metadata: { gp_staff_role: "manager" } } })).status).toBe(403)
    expect((await request("/admin/customers/cus_target", { body: { metadata: null } })).status).toBe(403)
    const result = await request("/admin/customers/cus_target", { body: { first_name: "Updated", metadata: { gp_staff_role: "customer", staff_access_version: 4, preferred_contact: "email" } } })
    expect(result.status).toBe(200); expect(result.body.body.metadata).toMatchObject({ preferred_contact: "email" }); expect(result.body.body.metadata.gp_staff_role).toBeUndefined(); expect(result.body.body.metadata.staff_access_version).toBeUndefined()
  })
  it("prevents office staff editing an administrator's profile or address", async () => {
    customers.cus_staff.metadata.gp_staff_role = "office"
    for (const suffix of ["", "/addresses"]) expect((await request(`/admin/customers/cus_bootstrap${suffix}`, { body: { email: "forged@example.test" } })).status).toBe(403)
    expect(effects).not.toHaveBeenCalled()
  })
  it("preserves prior audit attribution and binds only appended customer audit rows", async () => {
    const old = { action: "staff_role_change", staff_actor_customer_id: "cus_prior_owner" }
    customers.cus_target.metadata.staff_audit_log = JSON.stringify([old])
    const result = await request("/admin/customers/cus_target", { body: { metadata: { staff_audit_log: JSON.stringify([old, { action: "profile_update", staff_actor_customer_id: "forged", staffEmail: "forged@example.test" }]) } } })
    expect(result.status).toBe(200)
    const rows = JSON.parse(result.body.body.metadata.staff_audit_log)
    expect(rows[0]).toEqual(old); expect(rows[1]).toMatchObject({ staff_actor_customer_id: "cus_staff", staffEmail: "staff@example.test" })
    expect((await request("/admin/customers/cus_target", { body: { metadata: { staff_audit_log: JSON.stringify([{ ...old, staff_actor_customer_id: "forged" }]) } } })).status).toBe(403)
  })
  it("defaults to observation and preserves native dashboard and unclassified service access", async () => {
    delete process.env.GP_STAFF_BOUNDARY_MODE
    delete process.env.GP_PRIVILEGED_ADMIN_USER_IDS
    expect(staffBoundaryMode()).toBe("log")
    expect((await request("/admin/users", { token: null, authorization: `Bearer ${token({ actor_type: "user", actor_id: "usr_existing" })}`, method: "GET" })).status).toBe(200)
    expect((await request("/admin/products", { key: "sk_unknown", token: null, body: { title: "Fixture" } })).status).toBe(200)
    expect((await request("/admin/customers/cus_target", { key: "sk_unknown", token: null, body: { phone: "4045550100" } })).status).toBe(200)
    // Three allowed requests share one would-deny reason and one alert window.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/Bearer|sk_unknown|4045550100|Fixture/)
    const noAuth = await fetch(baseUrl + "/admin/users")
    expect(noAuth.status).toBe(401)
  })
  it("keeps invalid explicit mode strict and publishes authority only when enforcing", async () => {
    process.env.GP_STAFF_BOUNDARY_MODE = "typo"
    expect(staffBoundaryMode()).toBe("enforce")
    expect((await request("/admin/products", { key: "sk_unknown", token: null, method: "GET" })).status).toBe(403)
    process.env.GP_STAFF_BOUNDARY_MODE = "log"
    const legacy = await request("/store/customers/me", { method: "GET", token: null, authorization: `Bearer ${token()}` })
    expect(legacy.body.customer.staff_access).toBeUndefined()
  })
  it("classifies bridge catalog writes without granting payments, grants or destructive routes", async () => {
    process.env.GP_QBD_CATALOG_API_KEY_IDS = "apk_unknown"
    for (const path of ["/admin/products/prod_1", "/admin/inventory-items", "/admin/inventory-items/i/location-levels/l", "/admin/products/p/variants/v/inventory-items"]) {
      expect((await request(path, { key: "sk_unknown", token: null, body: { metadata: { qbd_list_id: "fixture" } } })).status).toBe(200)
    }
    for (const path of ["/admin/payments/p/capture", "/admin/draft-orders/d/pay", "/admin/customers/cus_target", "/admin/grillers/staff-access/customers/cus_target"]) {
      expect((await request(path, { key: "sk_unknown", token: null })).status).toBe(403)
    }
    expect((await request("/admin/products/prod_1", { key: "sk_unknown", token: null, method: "DELETE" })).status).toBe(403)
    delete process.env.GP_QBD_CATALOG_API_KEY_IDS
  })
  it("permits only send-marker metadata for the communications service and denies conflicting classes", async () => {
    process.env.GP_COMMUNICATIONS_ADMIN_API_KEY_IDS = "apk_unknown"
    for (const path of ["/admin/orders/o", "/admin/customers/cus_target"]) {
      expect((await request(path, { key: "sk_unknown", token: null, body: { metadata: { review_request_sent_at: "2026-09-21T00:00:00.000Z" } } })).status).toBe(200)
      expect((await request(path, { key: "sk_unknown", token: null, body: { metadata: { final_charge_enabled: true } } })).status).toBe(403)
      expect((await request(path, { key: "sk_unknown", token: null, body: { email: "forged@example.test", metadata: { review_request_sent_at: "2026-09-21T00:00:00.000Z" } } })).status).toBe(403)
    }
    process.env.GP_ADMIN_READ_ONLY_API_KEY_IDS = "apk_reader,apk_unknown"
    expect((await request("/admin/orders", { key: "sk_unknown", token: null, method: "GET" })).status).toBe(403)
    delete process.env.GP_COMMUNICATIONS_ADMIN_API_KEY_IDS
  })

  it("does not let log-only staff rollout bypass required order review", async () => {
    process.env.GP_STAFF_BOUNDARY_MODE = "log"
    process.env.GP_ORDER_REVIEW_ENFORCEMENT = "required"
    expect((await request("/admin/draft-orders", { key: "sk_unknown", token: null })).status).toBe(403)
    expect(effects).not.toHaveBeenCalled()
    delete process.env.GP_ORDER_REVIEW_ENFORCEMENT
  })

})
