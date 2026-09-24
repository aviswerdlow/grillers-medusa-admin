import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { enforceStaffCapabilities } from "../../api/middlewares/staff-capabilities"
import { resolveStaffPrincipal, STAFF_AUTHORIZATION_HEADER } from "../staff-principal"

jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true })) }))
const jwt = require("jsonwebtoken")

describe("native service-user staff boundary", () => {
  const originalEnv = { ...process.env }
  const secret = "isolated-native-service-user-fixture"
  const userRead = jest.fn(async (id: string) => ({ id, email: `${id}@example.test` }))
  const customerRead = jest.fn(async (id: string) => ({ id, email: "staff@example.test", first_name: "Staff", last_name: "Manager", metadata: { gp_staff_role: "manager" } }))

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.GP_STAFF_BOUNDARY_MODE = "enforce"
    process.env.GP_STAFF_GATEWAY_USER_ID = "usr_gateway"
    process.env.GP_ADMIN_READ_ONLY_USER_IDS = "usr_reader"
    process.env.GP_PRIVILEGED_ADMIN_USER_IDS = "usr_recovery"
  })
  afterEach(() => { process.env = { ...originalEnv } })

  function staffToken() {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign({ actor_type: "customer", actor_id: "cus_staff", auth_identity_id: "auth_staff", iat: now - 10, exp: now + 3600 }, secret)
  }
  function request(actorId: string, method: string, path: string, forwarded = false): any {
    return {
      method, path, headers: forwarded ? { [STAFF_AUTHORIZATION_HEADER]: `Bearer ${staffToken()}` } : {},
      auth_context: { actor_type: "user", actor_id: actorId, auth_identity_id: `auth_${actorId}` },
      scope: { resolve(key: string) {
        if (key === ContainerRegistrationKeys.CONFIG_MODULE) return { projectConfig: { http: { jwtSecret: secret } } }
        if (key === Modules.USER) return { retrieveUser: userRead }
        if (key === Modules.CUSTOMER) return { retrieveCustomer: customerRead }
        throw new Error(`Unexpected dependency ${key}`)
      } },
    }
  }
  async function boundary(req: any) {
    const res: any = { code: 200, status(code: number) { this.code = code; return this }, json(body: any) { this.body = body; return this } }
    const next = jest.fn()
    await enforceStaffCapabilities(req, res, next)
    return { res, next }
  }

  it("uses the gateway user's transport only with a signed, current staff customer", async () => {
    const req = request("usr_gateway", "GET", "/admin/orders/o", true)
    const { res, next } = await boundary(req)
    expect(res.code).toBe(200)
    expect(next).toHaveBeenCalledTimes(1)
    expect(req.gp_staff_principal).toMatchObject({ kind: "customer", id: "cus_staff", transport_id: "usr_gateway", role: "manager" })
    expect(req.gp_staff_principal.capabilities.has("orders.read")).toBe(true)
    expect(req.auth_context.actor_id).toBe("cus_staff")
    expect(customerRead).toHaveBeenCalledWith("cus_staff", expect.anything())

    process.env.GP_PRIVILEGED_ADMIN_USER_IDS = "usr_gateway,usr_recovery"
    expect((await boundary(request("usr_gateway", "GET", "/admin/orders/o"))).res.code).toBe(403)
    expect(userRead).toHaveBeenCalledWith("usr_gateway")
  })

  it("limits the native reader to enumerated GETs even if also listed as an operator", async () => {
    process.env.GP_PRIVILEGED_ADMIN_USER_IDS = "usr_reader,usr_recovery"
    const get = request("usr_reader", "GET", "/admin/products")
    const allowed = await boundary(get)
    expect(allowed.res.code).toBe(200)
    expect(allowed.next).toHaveBeenCalledTimes(1)
    expect(get.gp_staff_principal).toMatchObject({ kind: "service", service_role: "read_only", transport_id: "usr_reader" })

    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const denied = await boundary(request("usr_reader", method, "/admin/products"))
      expect(denied.res.code).toBe(403)
      expect(denied.next).not.toHaveBeenCalled()
    }
    expect((await boundary(request("usr_reader", "GET", "/admin/users"))).res.code).toBe(403)
    expect((await boundary(request("usr_reader", "GET", "/admin/products", true))).res.code).toBe(403)
  })

  it("does not activate an unconfigured or deleted native service user", async () => {
    expect((await boundary(request("usr_unknown", "GET", "/admin/products"))).res.code).toBe(403)
    userRead.mockResolvedValueOnce(null as any)
    expect((await boundary(request("usr_reader", "GET", "/admin/products"))).res.code).toBe(403)
    process.env.GP_ADMIN_READ_ONLY_USER_IDS = "usr_gateway,usr_reader"
    expect((await boundary(request("usr_gateway", "GET", "/admin/orders/o", true))).res.code).toBe(403)
  })
})
