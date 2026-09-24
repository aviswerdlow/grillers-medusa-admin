import { Modules } from "@medusajs/framework/utils"
import { POST } from "../route"
import { emitOpsAlert } from "../../../../../../../lib/ops-alert"

jest.mock("../../../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: any) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeReq({
  customerId = "cus_1",
  actorId = "user_avi",
  body = {},
  userModule,
  customerModule,
}: any) {
  return {
    params: { id: customerId },
    body,
    auth_context: { actor_id: actorId },
    scope: {
      resolve: (key: string) => {
        if (key === Modules.USER) return userModule
        if (key === Modules.CUSTOMER) return customerModule
        if (key === "logger") return { info: jest.fn(), error: jest.fn() }
        return undefined
      },
    },
  } as any
}

const APPROVERS = "peter@gp.com,avi@gp.com,julie@gp.com"

describe("offline-payment approval route (#279/#282)", () => {
  const prev = process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS
  beforeEach(() => {
    ;(emitOpsAlert as jest.Mock).mockClear()
  })

  afterEach(() => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = prev
  })

  const userModuleFor = (email: string) => ({
    retrieveUser: jest.fn(async () => ({ id: "user_avi", email })),
  })
  const okCustomerModule = () => ({
    retrieveCustomer: jest.fn(async () => ({ id: "cus_1", metadata: {} })),
    updateCustomers: jest.fn(async () => ({ id: "cus_1" })),
  })

  it("does not accept a customer's matching approver email without an approved immutable ID", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const savedIds = process.env.GP_INVOICE_APPROVER_CUSTOMER_IDS
    delete process.env.GP_INVOICE_APPROVER_CUSTOMER_IDS
    const customerModule = okCustomerModule()
    const req = makeReq({ userModule: userModuleFor("avi@gp.com"), customerModule })
    req.gp_staff_principal = { id: "cus_unapproved", kind: "customer", email: "avi@gp.com", name: "Fixture" }
    const res = makeRes()
    await POST(req, res)
    expect(res.statusCode).toBe(403)
    expect(customerModule.retrieveCustomer).not.toHaveBeenCalled()
    expect(customerModule.updateCustomers).not.toHaveBeenCalled()
    if (savedIds === undefined) delete process.env.GP_INVOICE_APPROVER_CUSTOMER_IDS
    else process.env.GP_INVOICE_APPROVER_CUSTOMER_IDS = savedIds
  })

  it("403s when the approver allowlist is not configured", async () => {
    delete process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS
    const customerModule = okCustomerModule()
    const res = makeRes()
    await POST(
      makeReq({ userModule: userModuleFor("avi@gp.com"), customerModule, body: { approved: false } }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(customerModule.updateCustomers).not.toHaveBeenCalled()
  })

  it("403s when the acting user is not an approver", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = okCustomerModule()
    const res = makeRes()
    await POST(
      makeReq({ userModule: userModuleFor("chris@gp.com"), customerModule, body: { approved: true, methods: ["zelle"], credit_limit: 1000, payment_terms: "Net 10" } }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(customerModule.updateCustomers).not.toHaveBeenCalled()
  })

  it("400s on invalid input from an approver", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = okCustomerModule()
    const res = makeRes()
    await POST(
      makeReq({ userModule: userModuleFor("avi@gp.com"), customerModule, body: { approved: true, methods: [], credit_limit: 0 } }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.errors.methods).toBeDefined()
    expect(customerModule.updateCustomers).not.toHaveBeenCalled()
  })

  it("approves an account and writes an audited metadata update", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = okCustomerModule()
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("avi@gp.com"),
        customerModule,
        body: { approved: true, methods: ["zelle", "wire"], credit_limit: 11750, payment_terms: "Net 10" },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.offline_payment).toMatchObject({
      approved: true,
      methods: ["zelle", "wire"],
      credit_limit: 11750,
      payment_terms: "Net 10",
    })
    const update: any = (customerModule.updateCustomers as jest.Mock).mock.calls[0][1]
    expect(update.metadata).toMatchObject({
      gp_offline_payment_approved: true,
      gp_offline_methods: ["zelle", "wire"],
      gp_credit_limit: 11750,
      gp_payment_terms: "Net 10",
    })
    // audited
    const audit = JSON.parse(update.metadata.staff_audit_log)
    expect(audit[audit.length - 1]).toMatchObject({
      action: "offline_payment_terms_updated",
      staff_actor_email: "avi@gp.com",
    })
  })

  it("revokes (approved=false) and clears the fields", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = {
      retrieveCustomer: jest.fn(async () => ({
        id: "cus_1",
        metadata: {
          gp_offline_payment_approved: true,
          gp_offline_methods: ["zelle"],
          gp_credit_limit: 5000,
          gp_payment_terms: "Net 30",
        },
      })),
      updateCustomers: jest.fn(async () => ({ id: "cus_1" })),
    }
    const res = makeRes()
    await POST(
      makeReq({ userModule: userModuleFor("julie@gp.com"), customerModule, body: { approved: false } }),
      res
    )
    expect(res.statusCode).toBe(200)
    const update: any = (customerModule.updateCustomers as jest.Mock).mock.calls[0][1]
    expect(update.metadata).toMatchObject({
      gp_offline_payment_approved: false,
      gp_offline_methods: [],
      gp_credit_limit: 0,
      gp_payment_terms: null,
    })
  })

  it("approving a customer with a pending application marks it approved (#291)", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = {
      retrieveCustomer: jest.fn(async () => ({
        id: "cus_1",
        metadata: {
          gp_invoice_application_status: "pending",
          gp_invoice_application: { business_name: "Beth Shalom" },
        },
      })),
      updateCustomers: jest.fn(async () => ({ id: "cus_1" })),
    }
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("peter@gp.com"),
        customerModule,
        body: { approved: true, methods: ["wire"], credit_limit: 5000, payment_terms: "Net 10" },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.application_status).toBe("approved")
    const update: any = (customerModule.updateCustomers as jest.Mock).mock.calls[0][1]
    expect(update.metadata.gp_invoice_application_status).toBe("approved")
    expect(update.metadata.gp_invoice_application_decided_by).toBe("peter@gp.com")
    const audit = JSON.parse(update.metadata.staff_audit_log)
    expect(audit[audit.length - 1].action).toBe("invoice_application_approved")
  })

  it("declining a pending application sets declined without terms (#291)", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = {
      retrieveCustomer: jest.fn(async () => ({
        id: "cus_1",
        metadata: { gp_invoice_application_status: "pending" },
      })),
      updateCustomers: jest.fn(async () => ({ id: "cus_1" })),
    }
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("julie@gp.com"),
        customerModule,
        body: { decline_application: true },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.application_status).toBe("declined")
    const update: any = (customerModule.updateCustomers as jest.Mock).mock.calls[0][1]
    expect(update.metadata.gp_invoice_application_status).toBe("declined")
    expect(update.metadata.gp_offline_payment_approved).toBe(false)
    const audit = JSON.parse(update.metadata.staff_audit_log)
    expect(audit[audit.length - 1].action).toBe("invoice_application_declined")
  })

  it("declining an account with no pending application is rejected (#291 Codex P2)", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = {
      // already approved, no pending application — a decline here would otherwise wipe terms
      retrieveCustomer: jest.fn(async () => ({
        id: "cus_1",
        metadata: {
          gp_offline_payment_approved: true,
          gp_offline_methods: ["wire"],
          gp_credit_limit: 5000,
          gp_payment_terms: "Net 10",
        },
      })),
      updateCustomers: jest.fn(async () => ({ id: "cus_1" })),
    }
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("avi@gp.com"),
        customerModule,
        body: { decline_application: true },
      }),
      res
    )
    expect(res.statusCode).toBe(409)
    expect(customerModule.updateCustomers).not.toHaveBeenCalled()
  })

  it("declining an approved account with stale pending metadata is rejected (#291 Codex P2 x2)", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = {
      // inconsistent: approved AND a stale `pending` application status — must NOT wipe terms
      retrieveCustomer: jest.fn(async () => ({
        id: "cus_1",
        metadata: {
          gp_offline_payment_approved: true,
          gp_offline_methods: ["wire"],
          gp_credit_limit: 5000,
          gp_payment_terms: "Net 10",
          gp_invoice_application_status: "pending",
        },
      })),
      updateCustomers: jest.fn(async () => ({ id: "cus_1" })),
    }
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("avi@gp.com"),
        customerModule,
        body: { decline_application: true },
      }),
      res
    )
    expect(res.statusCode).toBe(409)
    expect(customerModule.updateCustomers).not.toHaveBeenCalled()
  })

  it("approving a customer with NO application leaves application status untouched (#291)", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = okCustomerModule()
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("avi@gp.com"),
        customerModule,
        body: { approved: true, methods: ["zelle"], credit_limit: 1000, payment_terms: "Net 10" },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.application_status).toBeUndefined()
    const update: any = (customerModule.updateCustomers as jest.Mock).mock.calls[0][1]
    expect(update.metadata.gp_invoice_application_status).toBeUndefined()
    const audit = JSON.parse(update.metadata.staff_audit_log)
    expect(audit[audit.length - 1].action).toBe("offline_payment_terms_updated")
  })

  it("emits a page alert when an approved terms update fails", async () => {
    process.env.GP_OFFLINE_PAYMENT_APPROVER_EMAILS = APPROVERS
    const customerModule = {
      retrieveCustomer: jest.fn(async () => ({ id: "cus_1", metadata: {} })),
      updateCustomers: jest.fn(async () => {
        throw new Error("customer metadata write failed")
      }),
    }
    const res = makeRes()
    await POST(
      makeReq({
        userModule: userModuleFor("avi@gp.com"),
        customerModule,
        body: {
          approved: true,
          methods: ["zelle"],
          credit_limit: 1000,
          payment_terms: "Net 10",
        },
      }),
      res
    )

    expect(res.statusCode).toBe(500)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "staff_offline_payment_error",
        severity: "page",
        fingerprint: "staff_offline_payment:update_500",
        meta: expect.objectContaining({
          customer_id: "cus_1",
          staff_actor_id: "user_avi",
          staff_actor_email: "avi@gp.com",
          error_message: "customer metadata write failed",
        }),
      })
    )
  })
})
