import { Modules } from "@medusajs/framework/utils"
import { GET } from "../route"
import { POST as setup } from "../setup-intent/route"
import { DELETE } from "../[id]/route"
import { POST as setDefault } from "../[id]/default/route"
import { canManageCustomerPaymentMethods } from "../../../../lib/staff-access-policy"
import { getPaymentContextCustomer, STAFF_TARGET_CUSTOMER_ID_HEADER } from "../utils"

jest.mock("../../../../lib/ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true })) }))

function fixture(metadata: Record<string, unknown>, email = "staff@example.test") {
  const staff = { id: "cus_staff", email, metadata }
  const target = { id: "cus_target", metadata: {}, account_holders: [{ id: "ach_fixture", provider_id: "pp_stripe_stripe", data: { id: "cus_stripe_fixture" } }] }
  const query = { graph: jest.fn(async ({ filters }: any) => ({ data: filters.id === staff.id ? [staff] : filters.id === target.id ? [target] : [] })) }
  const payment = { listPaymentMethods: jest.fn(async () => []), createPaymentMethods: jest.fn() }
  const customer = { updateCustomers: jest.fn() }
  const logger = { error: jest.fn(), warn: jest.fn() }
  const services: any = { query, [Modules.PAYMENT]: payment, [Modules.CUSTOMER]: customer, logger }
  const req: any = {
    auth_context: { actor_id: staff.id, actor_type: "customer" },
    headers: { [STAFF_TARGET_CUSTOMER_ID_HEADER]: target.id, "x-gp-staff-actor-customer-id": "cus_owner_forged" },
    params: { id: "pm_fixture" }, body: { staff_actor_customer_id: "cus_owner_forged", staff_actor_email: "owner@example.test" },
    scope: { resolve: jest.fn((key: string) => {
      if (!(key in services)) throw new Error(`Unexpected service ${key}`)
      return services[key]
    }) },
  }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  return { req, res, staff, target, query, payment, customer, logger }
}

describe("customer-context saved-card capabilities", () => {
  let fetchSpy: jest.SpyInstance
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => { throw new Error("Provider access is forbidden in this fixture") })
  })
  afterEach(() => fetchSpy.mockRestore())

  const denied = [
    ["customer", { gp_staff_role: "customer", is_staff: true }],
    ["picker", { gp_staff_role: "picker", is_staff: true, final_charge_enabled: true }],
    ["packer", { gp_staff_role: "packer", is_staff: true, final_charge_enabled: true }],
    ["merchandising", { gp_staff_role: "merchandising_reviewer", is_staff: true }],
    ["unknown", { gp_staff_role: "unknown", is_staff: true }],
    ["revoked manager", { gp_staff_role: "manager", staff_access_revoked: true }],
    ["revoked bootstrap owner", { gp_staff_role: "super_admin", staff_access_revoked: "true" }],
  ] as const
  describe.each([["list", GET], ["setup", setup], ["delete", DELETE], ["default", setDefault]] as const)("%s", (_name, handler) => {
    it.each(denied)("denies %s before target reads or provider/mutation effects", async (name, metadata) => {
      const f = fixture(metadata, name.includes("bootstrap") ? "PeterSwerdlow@gmail.com" : undefined)
      await handler(f.req, f.res)
      expect(f.res.status).toHaveBeenCalledWith(403)
      expect(f.query.graph).toHaveBeenCalledTimes(1)
      expect(f.query.graph).toHaveBeenCalledWith(expect.objectContaining({ filters: { id: "cus_staff" } }))
      expect(f.req.scope.resolve).toHaveBeenCalledTimes(1)
      expect(f.payment.listPaymentMethods).not.toHaveBeenCalled()
      expect(f.payment.createPaymentMethods).not.toHaveBeenCalled()
      expect(f.customer.updateCustomers).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(f.logger.error).not.toHaveBeenCalled()
    })
  })

  it.each(["staff", "office", "manager", "super_admin"])("allows %s to list the intended customer's cards", async (role) => {
    const f = fixture({ gp_staff_role: role })
    await GET(f.req, f.res)
    expect(f.res.json).toHaveBeenCalledWith({ payment_methods: [] })
    expect(f.payment.listPaymentMethods).toHaveBeenCalledTimes(1)
    expect(f.query.graph).toHaveBeenNthCalledWith(2, expect.objectContaining({ filters: { id: "cus_target" } }))
  })

  it("rechecks revocation even when the same authenticated request is reused", async () => {
    const f = fixture({ gp_staff_role: "manager" })
    await expect(getPaymentContextCustomer(f.req)).resolves.toMatchObject({ staffCustomer: { id: "cus_staff" } })
    f.staff.metadata.staff_access_revoked = true
    await expect(getPaymentContextCustomer(f.req)).rejects.toThrow("office permission")
    expect(f.query.graph).toHaveBeenCalledTimes(3)
  })

  it("preserves self-service cards without a staff target", async () => {
    const f = fixture({ gp_staff_role: "customer", staff_access_revoked: true })
    delete f.req.headers[STAFF_TARGET_CUSTOMER_ID_HEADER]
    await expect(getPaymentContextCustomer(f.req)).resolves.toMatchObject({ customer: f.staff, staffCustomer: null })
    expect(f.query.graph).toHaveBeenCalledTimes(1)
  })

  it.each([GET, setup, DELETE, setDefault])("rejects an old session after access is regranted for each saved-card action", async handler => {
    const f = fixture({ gp_staff_role: "super_admin", staff_access_valid_after: 100 })
    f.req.auth_context.iat = 99
    await handler(f.req, f.res)
    expect(f.res.status).toHaveBeenCalledWith(403)
    expect(f.query.graph).toHaveBeenCalledTimes(1)
    expect(f.payment.listPaymentMethods).not.toHaveBeenCalled()
    expect(f.payment.createPaymentMethods).not.toHaveBeenCalled()
    expect(f.customer.updateCustomers).not.toHaveBeenCalled()
  })

  it.each([true, 1, "true", "1", "yes"])("revocation %p outranks bootstrap compatibility", (value) => {
    expect(canManageCustomerPaymentMethods({ email: "peter@grillerspride.com", metadata: { staff_access_revoked: value } })).toBe(false)
  })

  it("retains legacy office aliases but refuses narrow roles with broad stale flags", () => {
    expect(canManageCustomerPaymentMethods({ metadata: { phone_order_staff: "1" } })).toBe(true)
    expect(canManageCustomerPaymentMethods({ metadata: { staff_role: "customer_service" } })).toBe(true)
    expect(canManageCustomerPaymentMethods({ metadata: { role: "merchandising", staff: true } })).toBe(false)
  })
})
