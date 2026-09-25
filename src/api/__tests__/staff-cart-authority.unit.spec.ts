import path from "node:path"
import { request as httpRequest, type Server } from "node:http"
import { authenticate, validateAndTransformBody } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules, generateEntityId } from "@medusajs/framework/utils"
import middlewares from "../middlewares"
import { POST as createStaffCart } from "../admin/grillers/staff-carts/route"
import { enforceStaffCartAuthority } from "../middlewares/staff-cart-authority"
import { createAllocationsForOrder } from "../../lib/inventory-allocation"
import { STAFF_CART_AUTHORITY, STAFF_LINE_OVERRIDE, verifiedStaffCartAuthority, verifiedStaffLineOverride } from "../../lib/staff-cart-authority"

const createRun = jest.fn(), completeRun = jest.fn(), paymentRun = jest.fn()
jest.mock("@medusajs/core-flows", () => ({ ...jest.requireActual("@medusajs/core-flows"),
  createCartWorkflow: () => ({ run: createRun }), completeCartWorkflow: () => ({ run: completeRun }),
  createPaymentSessionsWorkflow: () => ({ run: paymentRun }) }))
const medusaRoot = path.dirname(require.resolve("@medusajs/medusa/package.json"))
const native = (file: string) => require(path.join(medusaRoot, `dist/api/store/${file}/route.js`))
const validators = require(path.join(medusaRoot, "dist/api/store/carts/validators.js"))
const express = require("express"), jwt = require("jsonwebtoken")
const { RoutesSorter } = require(path.join(path.dirname(require.resolve("@medusajs/framework/http")), "routes-sorter.js"))

describe("Staff cart boundary through installed Medusa validators and handlers", () => {
  const secret = "isolated-staff-cart-authority-fixture"
  const originalEnv = { ...process.env }
  const now = () => Math.floor(Date.now() / 1000)
  let server: Server, baseUrl: string, carts: Record<string, any>, orders: Record<string, any>, customers: Record<string, any>, variant: any
  let inserts: { table: string; data: any }[], count: number
  let paymentCollectionId: string | null, paymentCartId: string | null
  const customerRead = jest.fn(), workflow = jest.fn(), cartWrite = jest.fn(), otherEffects = jest.fn()
  const db: any = jest.fn((table: string) => {
    const chain: any = { then: (resolve: any) => resolve([]), insert: async (data: any) => { inserts.push({ table, data }); return data } }
    for (const name of ["select", "where", "whereNull", "whereIn", "limit", "orderBy"]) chain[name] = () => chain
    return chain
  })
  const query = { graph: jest.fn(async ({ entity, filters }: any) => {
    if (entity === "cart") return { data: carts[filters.id] ? [carts[filters.id]] : [] }
    if (entity === "cart_payment_collection") return { data: filters.payment_collection_id === "paycol_1" && carts.cart_1 ? [{ cart: { id: "cart_1" } }]
      : filters.payment_collection_id === paymentCollectionId && paymentCartId && carts[paymentCartId] ? [{ cart: { id: paymentCartId } }] : [] }
    if (entity === "product_variant") return { data: [variant] }
    if (entity === "order") return { data: orders[filters.id] ? [orders[filters.id]] : [] }
    return { data: [] }
  }) }
  const token = (id = "cus_staff", overrides: any = {}) => jwt.sign({ actor_type: "customer", actor_id: id,
    auth_identity_id: `auth_${id}`, iat: now() - 10, exp: now() + 600, ...overrides }, secret)
  const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next)

  beforeAll(async () => {
    const app = express(); app.use(express.json())
    app.use((req: any, _res: any, next: any) => {
      req.scope = { resolve(key: string) {
        if (key === ContainerRegistrationKeys.CONFIG_MODULE) return { projectConfig: { http: { jwtSecret: secret } } }
        if (key === Modules.API_KEY) return { authenticate: async (value: string) => value === "sk_gateway" ? { id: "apk_gateway" } : null }
        if (key === Modules.CUSTOMER) return { retrieveCustomer: customerRead }
        if (key === Modules.CART) return { updateCarts: cartWrite }
        if (key === Modules.WORKFLOW_ENGINE) return { run: workflow }
        if (key === ContainerRegistrationKeys.QUERY) return query
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
        if (key === ContainerRegistrationKeys.REMOTE_QUERY) return async () => [carts.cart_1 || (paymentCartId && carts[paymentCartId]) || { id: "paycol_1" }]
        throw new Error(`Unexpected dependency ${key}`)
      } }; req.queryConfig = { fields: ["id", "metadata"] }; next()
    })
    // ApiLoader installs optional customer auth before sorted Store middleware.
    app.use("/store", authenticate("customer", ["bearer", "session"], { allowUnauthenticated: true }))
    const selected = middlewares.routes!.filter((r: any) => r.matcher === "/admin/*" || r.middlewares.includes(enforceStaffCartAuthority))
    for (const r of new RoutesSorter(selected).sort()) {
      if (!r.methods?.length || r.methods.includes("ALL")) app.use(r.matcher, ...r.middlewares.map(wrap))
      else for (const method of r.methods) app[method.toLowerCase()](r.matcher, ...r.middlewares.map(wrap))
    }
    const post = (url: string, schema: any, handler: any) => app.post(url, ...(schema ? [validateAndTransformBody(schema)] : []), wrap(handler))
    app.post("/admin/grillers/staff-carts", wrap(createStaffCart))
    post("/store/carts", validators.StoreCreateCart, native("carts").POST)
    post("/store/carts/:id", validators.StoreUpdateCart, native("carts/[id]").POST)
    post("/store/carts/:id/line-items", validators.StoreAddCartLineItem, native("carts/[id]/line-items").POST)
    post("/store/carts/:id/line-items/:line_id", validators.StoreUpdateCartLineItem, native("carts/[id]/line-items/[line_id]").POST)
    post("/store/carts/:id/complete", null, native("carts/[id]/complete").POST)
    post("/store/payment-collections/:id/payment-sessions", null, native("payment-collections/[id]/payment-sessions").POST)
    app.all("/store/*", (req: any, res: any) => { otherEffects(req.path, req.body); res.json({ cart: carts.cart_1, ok: true }) })
    app.use((e: Error, _req: any, res: any, _next: any) => res.status(500).json({ message: e.message }))
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)) })
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  })
  beforeEach(() => {
    process.env.GP_STAFF_BOUNDARY_MODE = "enforce"
    jest.clearAllMocks(); process.env.GP_STAFF_GATEWAY_API_KEY_ID = "apk_gateway"; count = 0; carts = {}; orders = {}; inserts = []
    paymentCollectionId = null; paymentCartId = null
    customers = { cus_staff: { id: "cus_staff", email: "office@example.test", first_name: "Office", metadata: { gp_staff_role: "office", staff_access_version: 2 } },
      cus_target: { id: "cus_target", email: "customer@example.test", metadata: {} }, cus_other: { id: "cus_other", email: "other@example.test", metadata: { gp_staff_role: "office" } } }
    variant = { id: "variant_1", product_id: "prod_1", inventory_quantity: 5, manage_inventory: true, metadata: {}, product: { id: "prod_1", title: "Fixture item", metadata: {} } }
    customerRead.mockImplementation(async id => customers[id])
    createRun.mockImplementation(async ({ input }) => {
      const cart = { ...input, id: `cart_${++count}`, customer_id: input.customer_id || "cus_target", items: [], completed_at: null }
      carts[cart.id] = cart; return { result: cart }
    })
    cartWrite.mockImplementation(async (id, update) => { Object.assign(carts[id], { metadata: { ...carts[id].metadata, ...update.metadata } }); return carts[id] })
    workflow.mockImplementation(async (_id, { input }) => {
      const cart = carts[input.cart_id || input.id]
      if (input.items) cart.items.push(...input.items.map((line: any) => ({ ...line, id: `line_${cart.items.length + 1}` })))
      else if (input.items?.length === 0) return {}
      else if (input.metadata) cart.metadata = { ...cart.metadata, ...input.metadata }
      return {}
    })
    completeRun.mockImplementation(async ({ input }) => {
      const cart = carts[input.id]; cart.completed_at = new Date().toISOString()
      const order = { ...cart, id: "order_1", cart_id: cart.id, items: cart.items.map((item: any) => ({ ...item, variant })) }
      orders.order_1 = order; return { result: order, errors: [] }
    })
    paymentRun.mockResolvedValue({})
  })
  afterAll(async () => { process.env = originalEnv; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

  async function request(url: string, body?: any, staff = false, options: { method?: string; jwt?: string; authorization?: string } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (staff) headers["x-gp-staff-authorization"] = `Bearer ${options.jwt || token()}`
    if (url.startsWith("/admin/")) headers.Authorization = `Basic ${Buffer.from("sk_gateway:").toString("base64")}`
    if (options.authorization) headers.Authorization = options.authorization
    const response = await fetch(baseUrl + url, { method: options.method || "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as any }
  }
  async function rawRequest(url: string, body: any) {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = httpRequest({ hostname: "127.0.0.1", port: (server.address() as any).port, path: url,
        method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
        let value = ""
        res.on("data", chunk => { value += chunk })
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(value) }))
      })
      req.on("error", reject)
      req.end(payload)
    })
  }
  async function prepared(mode = "send_checkout_link") {
    const result = await request("/admin/grillers/staff-carts", { source: "staff_phone_order", region_id: "reg_fixture", customer_id: "cus_target", email: "customer@example.test",
      metadata: { scheduledDate: new Date().toISOString().slice(0, 10), staff_payment_mode: mode, staff_customer_verified: true, staff_payment_consent: true,
        staff_actor_customer_id: "cus_forged", staff_actor_email: "forged@example.test", staff_audit_log: JSON.stringify([{ staff_actor_customer_id: "cus_forged" }]) } }, true)
    expect(result.status).toBe(200); return result.body.cart
  }
  async function add(override = false) {
    const result = await request("/store/carts/cart_1/line-items", { variant_id: "variant_1", quantity: 2, metadata: { staff_actor_customer_id: "cus_forged",
      ...(override ? { inventory_override_reason: "confirmed_restock", inventory_override_note: "Office confirmed receipt before picking." } : {}) } }, true)
    expect(result.status).toBe(200)
  }
  const paymentPaths = ["/store/payment-collections", "/store/payment-collections/paycol_1/payment-sessions", "/store/carts/cart_1/complete", "/store/grillers/checkout/place-order"]

  it("accepts uppercase Medusa cart and payment IDs while protecting case-varied routes", async () => {
    const cartId = generateEntityId(undefined, "cart")
    paymentCollectionId = generateEntityId(undefined, "paycol")
    paymentCartId = cartId
    expect(cartId).toMatch(/^cart_[0-9A-Z]+$/)
    createRun.mockImplementationOnce(async ({ input }) => {
      const cart = { ...input, id: cartId, customer_id: input.customer_id || "cus_target", items: [], completed_at: null }
      carts[cart.id] = cart; return { result: cart }
    })
    await prepared()
    expect((await request(`/STORE/CARTS/${cartId}`, undefined, true, { method: "GET" })).status).toBe(200)
    expect((await request(`/STORE/CARTS/${cartId}/LINE-ITEMS`, { variant_id: "variant_1", quantity: 2 }, true)).status).toBe(200)
    expect((await request(`/STORE/PAYMENT-COLLECTIONS/${paymentCollectionId}/PAYMENT-SESSIONS`, { provider_id: "pp_stripe_stripe" })).status).toBe(200)
    customers.cus_staff.metadata.staff_access_revoked = true
    expect((await request(`/STORE/CARTS/${cartId}/COMPLETE`, {})).status).toBe(403)
    customers.cus_staff.metadata.staff_access_revoked = false
    expect((await request(`/STORE/CARTS/${cartId}/COMPLETE`, {})).status).toBe(200)
  })
  it("rejects raw fragments before payment provider and stock checks", async () => {
    await prepared(); await add()
    expect((await rawRequest("/store/payment-collections/paycol_1/payment-sessions#x", { provider_id: "pp_system_default" })).status).toBe(403)
    variant.inventory_quantity = 0
    expect((await rawRequest("/store/carts/cart_1/complete#x", {})).status).toBe(403)
    expect(paymentRun).not.toHaveBeenCalled()
    expect(completeRun).not.toHaveBeenCalled()
  })

  it.each(["list", "select", "validate"])("calendar %s retains staff authority without demanding inventory payment readiness", async action => {
    await prepared("collect_card_now"); variant.inventory_quantity = 0; await add(true)
    // Existing date-bound override is stale; a quote must allow choosing its replacement.
    carts.cart_1.metadata.scheduledDate = "2099-01-01"
    const body = { cart_id: "cart_1", action }
    expect((await request("/store/grillers/checkout/fulfillment-calendar", body, true)).status).toBe(200)
    expect((await request("/store/grillers/checkout/fulfillment-calendar", body)).status).toBe(403)
    expect((await request("/store/grillers/checkout/place-order", body, true)).status).toBe(403)
    expect((await request("/store/payment-collections/paycol_1/payment-sessions", { provider_id: "pp_stripe_stripe" }, true)).status).toBe(403)
    customers.cus_staff.metadata.staff_access_revoked = true
    expect((await request("/store/grillers/checkout/fulfillment-calendar", body, true)).status).toBe(403)
    expect(paymentRun).not.toHaveBeenCalled(); expect(completeRun).not.toHaveBeenCalled()
  })

  it.each(["staff_actor_customer_id", "staff_phone_order", "gp_staff_cart_authority", "payment_workflow", "final_charge_status", "finalization_status", "fulfillment_gate_status"])("rejects forged public %s before native creation", async key => {
    expect((await request("/store/carts", { email: "customer@example.test", metadata: { [key]: "forged" } })).status).toBe(403)
    expect(createRun).not.toHaveBeenCalled()
  })
  it("guards inline public items and preserves ordinary native cart creation", async () => {
    expect((await request("/store/carts", { items: [{ variant_id: "variant_1", quantity: 1, metadata: { inventory_override_reason: "forged" } }] })).status).toBe(403)
    expect((await request("/store/carts", { email: "customer@example.test", metadata: { giftNotes: "A gift" } })).status).toBe(200)
    expect(carts.cart_1.metadata).toEqual({ giftNotes: "A gift" })
  })
  it.each(["customer", "picker", "packer", "merchandising_reviewer"])("denies %s creating a staff cart", async role => {
    customers.cus_staff.metadata.gp_staff_role = role
    expect((await request("/admin/grillers/staff-carts", {}, true)).status).toBe(403)
    expect(createRun).not.toHaveBeenCalled()
  })
  it("binds the actual buyer and backend actor, ignoring supplied actor/audit fields", async () => {
    const cart = await prepared("collect_card_now")
    expect(cart.customer_id).toBe("cus_target")
    expect(verifiedStaffCartAuthority(cart, secret)).toMatchObject({ cart_id: cart.id, actor_id: "cus_staff", actor_email: "office@example.test", access_version: 2 })
    expect(JSON.parse(cart.metadata.staff_audit_log)[0].staff_actor_customer_id).toBe("cus_staff")
    expect((await request("/store/carts/cart_1", undefined, false, { method: "GET" })).status).toBe(403)
    expect((await request("/store/carts/cart_1", undefined, true, { method: "GET" })).status).toBe(200)
  })
  it("rejects recipient mismatch and stale creation sessions before any cart write", async () => {
    expect((await request("/admin/grillers/staff-carts", { source: "staff_impersonation", customer_id: "cus_target", email: "other@example.test" }, true)).status).toBe(403)
    customers.cus_staff.metadata.staff_access_valid_after = now()
    expect((await request("/admin/grillers/staff-carts", {}, true)).status).toBe(403)
    expect(createRun).not.toHaveBeenCalled()
  })
  it("binds the customer found by the native workflow when no account was selected", async () => {
    const result = await request("/admin/grillers/staff-carts", { source: "staff_phone_order", email: "customer@example.test", metadata: { staff_payment_mode: "send_checkout_link", staff_customer_verified: true } }, true)
    expect(result.status).toBe(200)
    expect(verifiedStaffCartAuthority(result.body.cart, secret)?.customer_id).toBe("cus_target")
    expect(JSON.parse(result.body.cart.metadata.staff_audit_log)[0].staff_selected_customer_id).toBe("cus_target")
  })
  it("fails closed if cart sealing fails, without preparing a payment", async () => {
    cartWrite.mockRejectedValueOnce(new Error("isolated write failure"))
    const result = await request("/admin/grillers/staff-carts", { source: "staff_impersonation", customer_id: "cus_target", email: "customer@example.test" }, true)
    expect(result.status).toBe(503)
    expect((await request("/store/carts/cart_1/complete", {}, true)).status).toBe(403)
    expect(completeRun).not.toHaveBeenCalled(); expect(paymentRun).not.toHaveBeenCalled()
  })
  it("rejects legacy markers, cross-cart receipt replay and unauthorized metadata edits", async () => {
    await prepared(); const receipt = carts.cart_1.metadata[STAFF_CART_AUTHORITY]
    carts.cart_other = { ...carts.cart_1, id: "cart_other", metadata: { ...carts.cart_1.metadata } }
    expect((await request("/store/carts/cart_other/complete", {}, true)).status).toBe(403)
    for (const metadata of [{ staff_actor_customer_id: "cus_other" }, { [STAFF_CART_AUTHORITY]: receipt + "x" }, { payment_workflow: "invoice_ar" }, { gp_order_promise_snapshot_id: "gpos_forged" }, null]) {
      expect((await request("/store/carts/cart_1", { metadata })).status).toBe(403)
    }
    delete carts.cart_1.metadata[STAFF_CART_AUTHORITY]
    expect((await request("/store/carts/cart_1/complete", {}, true)).status).toBe(403)
    expect(completeRun).not.toHaveBeenCalled(); expect(workflow).not.toHaveBeenCalled()
  })
  it.each(["revoked", "regranted", "stale token"])("denies every payment/completion entry for %s without provider effects", async state => {
    await prepared(); await add(); workflow.mockClear(); otherEffects.mockClear()
    if (state === "revoked") customers.cus_staff.metadata.staff_access_revoked = true
    if (state === "regranted") { customers.cus_staff.metadata.staff_access_version = 3; customers.cus_staff.metadata.staff_access_valid_after = now() - 1 }
    const badToken = state === "stale token" ? token("cus_other") : undefined
    for (const endpoint of paymentPaths) {
      const result = await request(endpoint, { cart_id: "cart_1", provider_id: "pp_stripe_stripe" }, state === "stale token", { jwt: badToken })
      expect(result.status).toBe(403)
    }
    expect(paymentRun).not.toHaveBeenCalled(); expect(completeRun).not.toHaveBeenCalled(); expect(workflow).not.toHaveBeenCalled(); expect(otherEffects).not.toHaveBeenCalled()
  })
  it("rejects a stale JWT even while the creator's receipt remains current", async () => {
    await prepared(); customers.cus_staff.metadata.staff_access_valid_after = now() - 20
    expect((await request("/store/carts/cart_1", {}, true, { jwt: token("cus_staff", { iat: now() - 30 }) })).status).toBe(403)
    expect(workflow).not.toHaveBeenCalled()
  })
  it("permits a current customer handoff but cannot transfer or retarget its buyer", async () => {
    await prepared(); await add()
    expect((await request("/store/carts/cart_1", undefined, false, { method: "GET" })).status).toBe(200)
    expect((await request("/store/carts/cart_1/customer", {}, false, { authorization: `Bearer ${token("cus_target")}` })).status).toBe(200)
    expect((await request("/store/carts/cart_1/customer", {}, false, { authorization: `Bearer ${token("cus_other")}` })).status).toBe(403)
    expect((await request("/store/carts/cart_1", { email: "other@example.test" })).status).toBe(403)
    expect((await request("/store/payment-collections/paycol_1/payment-sessions", { provider_id: "pp_stripe_stripe" })).status).toBe(200)
    expect(paymentRun).toHaveBeenCalledWith({ input: expect.objectContaining({ customer_id: "cus_target" }) })
  })
  it("cannot use a body cart ID to bypass the payment collection's actual staff cart", async () => {
    await prepared(); await add()
    carts.cart_public = { id: "cart_public", metadata: {}, items: [] }
    customers.cus_staff.metadata.staff_access_revoked = true
    expect((await request("/store/payment-collections/paycol_1/payment-sessions", { cart_id: "cart_public", provider_id: "pp_stripe_stripe" })).status).toBe(403)
    expect(paymentRun).not.toHaveBeenCalled()
  })
  it("does not prepare a staff payment for a different signed-in buyer or a public system-provider bypass", async () => {
    await prepared(); await add()
    expect((await request("/store/payment-collections/paycol_1/payment-sessions", { provider_id: "pp_stripe_stripe" }, false, { authorization: `Bearer ${token("cus_other")}` })).status).toBe(403)
    expect((await request("/store/payment-collections/paycol_1/payment-sessions", { provider_id: "pp_system_default" })).status).toBe(403)
    expect(paymentRun).not.toHaveBeenCalled()
  })
  it("requires a backend-signed override and binds it to quantity/date before payment", async () => {
    await prepared(); variant.inventory_quantity = 0
    expect((await request("/store/carts/cart_1/line-items", { variant_id: "variant_1", quantity: 2, metadata: { inventory_override_reason: "forged", inventory_override_note: "forged" } })).status).toBe(403)
    await add(true)
    const cart = carts.cart_1, line = cart.items[0], proof = verifiedStaffCartAuthority(cart, secret)
    expect(verifiedStaffLineOverride(cart, line, proof, secret)).toBe(true)
    expect(line.metadata.staff_actor_customer_id).toBe("cus_staff")
    line.quantity = 3
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(403)
    line.quantity = 2; cart.metadata.scheduledDate = "2099-01-01"
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(403)
    expect(completeRun).not.toHaveBeenCalled()
  })
  it("denies unapproved shortages and inactive items, including a signed override", async () => {
    await prepared(); variant.inventory_quantity = 0; await add()
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(403)
    carts.cart_1.items = []; await add(true); variant.metadata.availability_lifecycle = "seasonal_inactive"
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(403)
    expect(completeRun).not.toHaveBeenCalled()
  })
  it("preserves verified staff attribution through native completion and actual allocation logic", async () => {
    await prepared(); variant.inventory_quantity = 0; await add(true)
    const completed = await request("/store/carts/cart_1/complete", {})
    expect(completed.status).toBe(200); expect(completed.body.type).toBe("order")
    const order = orders.order_1
    order.metadata.staff_actor_customer_id = "cus_forged_after_order"
    customers.cus_staff.metadata.staff_access_revoked = true
    const result = await createAllocationsForOrder({ db, query, orderId: "order_1", staffAuthoritySecret: secret })
    expect(result).toEqual({ created: 1, skipped: 0, blocked: 1 })
    expect(inserts.find(i => i.table === "gp_inventory_allocation")?.data).toMatchObject({ source: "staff_phone_order", staff_actor_customer_id: "cus_staff", override_reason: "confirmed_restock" })
    expect(inserts.find(i => i.table === "gp_inventory_allocation_audit")?.data).toMatchObject({ actor_type: "staff", actor_id: "cus_staff" })
  })
  it("keeps native completion retries available after stock is reserved and prevents new payment preparation", async () => {
    await prepared(); await add()
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(200)
    variant.inventory_quantity = 0
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(200)
    expect((await request("/store/payment-collections/paycol_1/payment-sessions", { provider_id: "pp_stripe_stripe" })).status).toBe(403)
    expect(paymentRun).not.toHaveBeenCalled()
  })
  it("does not turn unverified historical order metadata into a staff allocation or override", async () => {
    orders.order_1 = { id: "order_1", cart_id: "cart_forged", email: "customer@example.test", customer_id: "cus_target",
      metadata: { source: "staff_phone_order", staff_actor_customer_id: "cus_staff" }, items: [{ id: "line_1", quantity: 2, variant,
        metadata: { inventory_override_reason: "forged", inventory_override_note: "forged", [STAFF_LINE_OVERRIDE]: "forged" } }] }
    variant.inventory_quantity = 0
    await createAllocationsForOrder({ db, query, orderId: "order_1", source: "staff_phone_order", staffAuthoritySecret: secret })
    expect(inserts.find(i => i.table === "gp_inventory_allocation")?.data).toMatchObject({ source: "customer_web", staff_actor_customer_id: null, override_reason: null })
    expect(inserts.find(i => i.table === "gp_inventory_allocation_audit")?.data.actor_type).toBe("system")
  })
  it("returns a retryable failure on authority lookup error before payment", async () => {
    await prepared(); await add(); customerRead.mockRejectedValueOnce(new Error("isolated lookup failure"))
    expect((await request("/store/carts/cart_1/complete", {})).status).toBe(503)
    expect(completeRun).not.toHaveBeenCalled()
  })
  it("keeps unsigned legacy carts available in log mode without issuing new receipts", async () => {
    process.env.GP_STAFF_BOUNDARY_MODE = "log"
    expect((await request("/admin/grillers/staff-carts", {}, true)).status).toBe(404)
    expect(createRun).not.toHaveBeenCalled()
    carts.cart_1 = { id: "cart_1", customer_id: "cus_target", email: "customer@example.test", items: [], metadata: { staff_phone_order: true } }
    expect((await request("/store/carts/cart_1", undefined, true, { method: "GET" })).status).toBe(200)
    expect((await request("/store/carts/cart_1", { metadata: { [STAFF_CART_AUTHORITY]: "forged" } }, true)).status).toBe(403)
  })
  it("never downgrades an already signed cart after rollback to log", async () => {
    await prepared(); await add()
    process.env.GP_STAFF_BOUNDARY_MODE = "log"
    customers.cus_staff.metadata.staff_access_revoked = true
    expect((await request("/store/carts/cart_1/complete", {}, true)).status).toBe(403)
    expect(completeRun).not.toHaveBeenCalled()
  })

})
