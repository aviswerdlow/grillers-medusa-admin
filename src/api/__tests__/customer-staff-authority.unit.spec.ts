import path from "node:path"
import type { Server } from "node:http"
import { authenticate } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules, mergeMetadata } from "@medusajs/framework/utils"
import middlewares from "../middlewares"
import { protectCustomerStaffAuthority } from "../middlewares/customer-staff-authority"

// The HTTP fixture runs the installed Medusa authentication, validators and
// handlers. Only customer workflows/persistence are synthetic; no live account
// is read or changed. It does not stand in for a deployed Medusa rehearsal.
const createRun = jest.fn(async () => ({ result: { id: "cus_fixture" } }))
const updateRun = jest.fn(async (_input: any) => ({ result: [] }))
jest.mock("@medusajs/core-flows", () => ({
  ...jest.requireActual("@medusajs/core-flows"),
  createCustomerAccountWorkflow: () => ({ run: createRun }),
  updateCustomersWorkflow: () => ({ run: updateRun }),
}))

const medusaRoot = path.dirname(require.resolve("@medusajs/medusa/package.json"))
const validators = require(path.join(medusaRoot, "dist/api/store/customers/validators.js"))
const createRoute = require(path.join(medusaRoot, "dist/api/store/customers/route.js"))
const updateRoute = require(path.join(medusaRoot, "dist/api/store/customers/me/route.js"))
const { RoutesSorter } = require(path.join(path.dirname(require.resolve("@medusajs/framework/http")), "routes-sorter.js"))
const express = require("express")
const jwt = require("jsonwebtoken")

// JSON persistence keeps nested metadata in the same realm as the HTTP parser.
const metadataCopy = (value: any) => JSON.parse(JSON.stringify(value))

const authorityKeys = [
  "gp_staff_role", "staff_role", "role", "account_role", "is_staff", "staff",
  "gp_staff", "staff_access", "phone_order_staff", "staff_super_admin",
  "staff_access_revoked", "staff_access_updated_at", "final_charge_enabled",
  "can_charge_final_orders", "staff_final_charge_enabled", "catch_weight_charge_enabled",
  "staff_actor_customer_id", "staff_audit_log", "gp_staff_session_generation",
  "created_by_staff_customer_id", "customer_account_credits", "customer_account_credit_balance_minor", "customer_account_notes",
  "gp_offline_payment_approved", "gp_offline_methods", "gp_credit_limit", "gp_payment_terms", "gp_invoice_application_status",
]

describe("Store customer staff-authority boundary (native Medusa HTTP fixture)", () => {
  let server: Server
  let baseUrl: string
  const secret = "isolated-staff-authority-http-fixture"
  const remoteQuery = jest.fn(async () => [{ id: "cus_fixture", email: "fixture@example.test" }])
  let customer: any
  let beforePersist: (() => void) | undefined
  const retrieveCustomer = jest.fn(async (_id: string, _options: any) => metadataCopy(customer))
  const config = { projectConfig: { http: { jwtSecret: secret } } }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use((req: any, _res: any, next: any) => {
      req.scope = { resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.CONFIG_MODULE) return config
        if (key === ContainerRegistrationKeys.REMOTE_QUERY) return remoteQuery
        if (key === Modules.CUSTOMER) return { retrieveCustomer }
        throw new Error(`Unexpected dependency: ${key}`)
      } }
      req.queryConfig = { fields: ["id", "email"] }
      next()
    })
    for (const endpoint of ["/store/customers", "/store/customers/me"]) {
      const create = endpoint === "/store/customers"
      const schema = create ? validators.StoreCreateCustomer : validators.StoreUpdateCustomer
      const handler = create ? createRoute.POST : updateRoute.POST
      const guard = middlewares.routes?.find((r: any) => r.matcher === endpoint && r.methods.includes("POST"))
      if (!guard?.middlewares?.includes(protectCustomerStaffAuthority)) throw new Error(`Missing production guard for ${endpoint}`)
      app.post(endpoint,
        authenticate("customer", ["bearer"], { allowUnregistered: create }),
        ...guard.middlewares,
        (req: any, res: any, next: any) => {
          const result = schema.safeParse(req.body)
          if (!result.success) return res.status(400).json({ message: "Invalid account data" })
          req.validatedBody = result.data
          next()
        },
        (req: any, res: any, next: any) => Promise.resolve(handler(req, res)).catch(next),
      )
    }
    app.use((error: Error, _req: any, res: any, _next: any) => res.status(500).json({ message: error.message }))
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  })

  beforeEach(() => {
    jest.clearAllMocks()
    beforePersist = undefined
    customer = { id: "cus_fixture", email: "fixture@example.test", metadata: {
      gp_staff_role: "office", staff_access_revoked: true,
      created_by_staff_customer_id: "cus_creator", gp_credit_limit: 1000,
      customer_account_notes: [{ text: "Internal fixture note" }],
      customer_account_credit_balance_minor: 1250,
    } }
    retrieveCustomer.mockImplementation(async () => metadataCopy(customer))
    remoteQuery.mockImplementation(async () => [metadataCopy(customer)])
    updateRun.mockImplementation(async ({ input }) => {
      beforePersist?.()
      // Same merge helper used by the installed Medusa internal service. This
      // is synthetic persistence, not a live database/customer mutation.
      if (input.update.metadata) customer.metadata = mergeMetadata(customer.metadata, input.update.metadata)
      return { result: [] }
    })
  })
  afterAll(async () => {
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })

  async function post(endpoint: string, body: unknown, validAuth = true) {
    const token = jwt.sign({ actor_type: "customer", actor_id: endpoint.endsWith("/me") ? "cus_fixture" : "",
      auth_identity_id: "auth_fixture", app_metadata: {} }, validAuth ? secret : "wrong-fixture-key", { expiresIn: "1m" })
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  it("uses native schemas that would otherwise forward role metadata", () => {
    for (const schema of [validators.StoreCreateCustomer, validators.StoreUpdateCustomer]) {
      expect(schema.parse({ metadata: { gp_staff_role: "super_admin" } }).metadata).toEqual({ gp_staff_role: "super_admin" })
    }
  })

  it("Medusa sorts each registered guard before its native route handler", () => {
    for (const matcher of ["/store/customers", "/store/customers/me"]) {
      const guard = middlewares.routes?.find((r: any) => r.matcher === matcher)!
      expect(guard).toBeDefined()
      const handler = { matcher, methods: ["POST"], isRoute: true }
      const sorted = new RoutesSorter([guard, handler]).sort()
      expect(sorted.indexOf(guard)).toBeLessThan(sorted.indexOf(handler))
    }
  })

  describe.each(["/store/customers", "/store/customers/me"])("%s", (endpoint) => {
    it.each(authorityKeys)("rejects a change to %s before mutation or response read", async (key) => {
      const result = await post(endpoint, { email: "fixture@example.test", metadata: { [key]: key.includes("revoked") ? false : "super_admin" } })
      expect(result.status).toBe(403)
      expect(createRun).not.toHaveBeenCalled()
      expect(updateRun).not.toHaveBeenCalled()
      expect(remoteQuery).not.toHaveBeenCalled()
    })
    it.each([null, false, "", "{\"staff_access_revoked\":false}", []])("rejects wholesale metadata replacement %p", async (metadata) => {
      expect((await post(endpoint, { metadata })).status).toBe(400)
      expect(createRun).not.toHaveBeenCalled()
      expect(updateRun).not.toHaveBeenCalled()
    })
    it.each([null, "", false])("does not allow clearing a protected field with %p", async (value) => {
      expect((await post(endpoint, { metadata: { staff_access_revoked: value } })).status).toBe(403)
      expect(createRun).not.toHaveBeenCalled()
      expect(updateRun).not.toHaveBeenCalled()
    })
    it("preserves native authentication for forged tokens", async () => {
      expect((await post(endpoint, { first_name: "Fixture" }, false)).status).toBe(401)
      expect(createRun).not.toHaveBeenCalled()
      expect(updateRun).not.toHaveBeenCalled()
    })
    it("passes ordinary contact/preferences metadata unchanged to the installed handler", async () => {
      const body = { first_name: "Fixture", phone: "4045550100", metadata: { contact_preference: "email", sms_marketing_opt_in: false } }
      const result = await post(endpoint, body)
      expect(result.status).toBe(200)
      if (endpoint.endsWith("/me")) {
        expect(updateRun).toHaveBeenCalledWith({ input: { selector: { id: "cus_fixture" }, update: body } })
        expect(createRun).not.toHaveBeenCalled()
      } else {
        expect(createRun).toHaveBeenCalledWith({ input: { authIdentityId: "auth_fixture", customerData: body } })
        expect(updateRun).not.toHaveBeenCalled()
      }
    })
    it("allows a contact-only update without metadata", async () => {
      expect((await post(endpoint, { first_name: "Fixture" })).status).toBe(200)
    })
  })

  it.each([undefined, "log", "enforce"])("allows an unchanged authority snapshot with SMS updates in %s mode", async (mode) => {
    const prior = process.env.GP_STAFF_BOUNDARY_MODE
    try {
      if (mode === undefined) delete process.env.GP_STAFF_BOUNDARY_MODE
      else process.env.GP_STAFF_BOUNDARY_MODE = mode
      const protectedBefore = metadataCopy(customer.metadata)
      const sms = { sms_marketing_opt_in: true, sms_marketing_phone: "+14045550100", sms_marketing_consent_source: "account_profile" }
      expect((await post("/store/customers/me", { phone: "4045550100", metadata: { ...protectedBefore, ...sms } })).status).toBe(200)
      expect(updateRun).toHaveBeenCalledWith({ input: { selector: { id: customer.id }, update: { phone: "4045550100", metadata: sms } } })
      expect(retrieveCustomer).toHaveBeenCalledWith(customer.id, { select: ["id", "metadata"] })
      expect(customer.metadata).toEqual({ ...protectedBefore, ...sms })
    } finally {
      if (prior === undefined) delete process.env.GP_STAFF_BOUNDARY_MODE
      else process.env.GP_STAFF_BOUNDARY_MODE = prior
    }
  })

  it("cannot replay an old grant or credit over a change after the guard read", async () => {
    const snapshot = metadataCopy(customer.metadata)
    beforePersist = () => { customer.metadata.gp_staff_role = "customer"; customer.metadata.gp_credit_limit = 0 }
    expect((await post("/store/customers/me", { metadata: { ...snapshot, sms_marketing_opt_in: false } })).status).toBe(200)
    expect(customer.metadata).toMatchObject({ gp_staff_role: "customer", gp_credit_limit: 0, sms_marketing_opt_in: false })
    expect(updateRun.mock.calls[0][0].input.update.metadata).toEqual({ sms_marketing_opt_in: false })
  })

  it("rejects a mixed legitimate SMS update and changed authority without applying either", async () => {
    expect((await post("/store/customers/me", { metadata: { ...customer.metadata, gp_staff_role: "super_admin", sms_marketing_opt_in: true } })).status).toBe(403)
    expect(updateRun).not.toHaveBeenCalled()
    expect(customer.metadata.sms_marketing_opt_in).toBeUndefined()
  })

  it("holds an authority-bearing update when its current record cannot be verified", async () => {
    retrieveCustomer.mockRejectedValueOnce(new Error("Synthetic storage failure"))
    expect((await post("/store/customers/me", { metadata: { ...customer.metadata, sms_marketing_opt_in: true } })).status).toBe(503)
    expect(updateRun).not.toHaveBeenCalled()
  })

  it("authenticates the account before reading authority from its full snapshot", async () => {
    expect((await post("/store/customers/me", { metadata: customer.metadata }, false)).status).toBe(401)
    expect(retrieveCustomer).not.toHaveBeenCalled()
    expect(updateRun).not.toHaveBeenCalled()
  })

  it("validates raw and transformed bodies before stripping either snapshot", async () => {
    const body = { metadata: { ...customer.metadata, sms_marketing_opt_in: true } }
    const validatedBody = { metadata: { ...body.metadata, staff_access_revoked: false } }
    const req: any = { method: "POST", path: "/store/customers/me", auth_context: { actor_type: "customer", actor_id: customer.id }, body, validatedBody,
      scope: { resolve: () => ({ retrieveCustomer }) } }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn()
    await protectCustomerStaffAuthority(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(body.metadata.gp_staff_role).toBe("office")
    expect(next).not.toHaveBeenCalled()
  })

  it("also rejects an already-validated protected body", async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    await protectCustomerStaffAuthority({ body: {}, validatedBody: { metadata: { is_staff: true } } } as any, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
})
