import path from "node:path"
import type { Server } from "node:http"
import { asValue, createContainer } from "awilix"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { captureAccountWelcomeResponse } from "../middlewares/account-welcome"
import { captureWelcomeCustomers } from "../../lib/account-welcome"

// Exercise the installed Store handler/refetch over real HTTP. The workflow
// and event bus are controlled fixtures; nested scope propagation and
// real bus retention still need the integrated native rehearsal.
jest.mock("@medusajs/core-flows", () => ({
  // Account creation uses a local SDK runner, so replace the workflow factory
  // itself instead of registering the unrelated persistent workflow engine.
  createCustomerAccountWorkflow: (scope: any) =>
    scope.resolve("fixtureAccountWorkflow"),
}))
const medusa = path.dirname(require.resolve("@medusajs/medusa/package.json"))
const native = require(path.join(medusa, "dist/api/store/customers/route.js"))
const express = require("express")
const env = { ...process.env }
const customer = {
  id: "cus_http",
  email: "original@example.test",
  first_name: "Original",
  has_account: true,
  created_at: new Date("2026-09-01T12:00:00Z").toISOString(),
}
const emit = jest.fn(async (_event: any) => undefined)
const remoteQuery = jest.fn(async (_query: any): Promise<any[]> => [customer])
let server: Server,
  base: string,
  failAfterCreate = false
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  const root = createContainer().register({
    [Modules.EVENT_BUS]: asValue({ emit }),
    [ContainerRegistrationKeys.REMOTE_QUERY]: asValue(remoteQuery),
    logger: asValue({ warn: jest.fn() }),
  })
  app.use((req: any, _res: any, next: any) => {
    req.scope = root.createScope()
    req.scope.register({
      fixtureAccountWorkflow: asValue({
        run: async () => {
          captureWelcomeCustomers(customer, {
            container: req.scope,
            transactionId: "tx_http",
          })
          if (failAfterCreate) throw new Error("fixture auth-link failure")
          return { result: customer }
        },
      }),
    })
    req.validatedBody = req.body
    req.auth_context = { auth_identity_id: "auth_fixture" }
    req.queryConfig = { fields: ["id"] }
    next()
  })
  app.post(
    "/store/customers",
    captureAccountWelcomeResponse,
    (req: any, res: any, next: any) =>
      Promise.resolve(native.POST(req, res)).catch(next)
  )
  app.use((_err: any, _req: any, res: any, _next: any) =>
    res.status(500).json({ error: "fixture workflow failure" })
  )
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
})
beforeEach(() => {
  process.env = {
    ...env,
    GP_ACCOUNT_WELCOME_ENABLED: "true",
    STRIPE_API_KEY: "sk_live_fixture",
  }
  jest.clearAllMocks()
  failAfterCreate = false
  remoteQuery.mockResolvedValue([customer])
})
afterEach(() => {
  process.env = { ...env }
})
const signup = () =>
  fetch(`${base}/store/customers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: customer.email,
      first_name: customer.first_name,
    }),
  })
it("captures a successful account with the release defaults and analytics disabled", async () => {
  delete process.env.GP_ACCOUNT_WELCOME_ENABLED
  delete process.env.GP_CUSTOMER_MEASUREMENT_ENABLED
  delete process.env.GP_CART_MEASUREMENT_ENABLED
  const response = await signup()
  expect(response.status).toBe(200)
  expect(emit).toHaveBeenCalledTimes(1)
  expect(emit.mock.calls[0][0].data).toMatchObject({
    lane: "production", context: null, customer: { email: customer.email },
  })
})
it.each([
  { id: customer.id },
  { ...customer, email: "later@example.test", first_name: "Later" },
])(
  "uses original native details when the response refetch is sparse or changed: %j",
  async (refetched) => {
    remoteQuery.mockResolvedValue([refetched])
    const response = await signup()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ customer: refetched })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({
      name: "gp.account_welcome_captured",
      data: {
        transaction_id: "tx_http",
        lane: "production",
        context: null,
        customer: {
          id: customer.id,
          email: customer.email,
          first_name: customer.first_name,
        },
      },
    })
  }
)
it("does not release the inner customer creation after outer auth linking fails", async () => {
  failAfterCreate = true
  const response = await signup()
  expect(response.status).toBe(500)
  expect(remoteQuery).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
})
it("does not release an unsuccessful native refetch", async () => {
  remoteQuery.mockRejectedValueOnce(new Error("fixture query failure"))
  expect((await signup()).status).toBe(500)
  expect(emit).not.toHaveBeenCalled()
})
it("keeps account success distinct from event-bus acceptance", async () => {
  emit.mockRejectedValueOnce(new Error("fixture bus unavailable"))
  const response = await signup()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ customer })
  expect(emit).toHaveBeenCalledTimes(1)
})
