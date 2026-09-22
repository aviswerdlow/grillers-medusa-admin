import path from "node:path"
import type { Server } from "node:http"
import { asValue, createContainer } from "awilix"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { captureCartMeasurementResponse } from "../middlewares/cart-measurement"

// Installed native handlers/refetch shape over real HTTP. Workflows and SQL are
// synthetic; this is not a deployed native workflow or event-bus receipt.
const medusa = path.dirname(require.resolve("@medusajs/medusa/package.json"))
const add = require(path.join(
  medusa,
  "dist/api/store/carts/[id]/line-items/route.js"
))
const line = require(path.join(
  medusa,
  "dist/api/store/carts/[id]/line-items/[line_id]/route.js"
))
const express = require("express")
const env = { ...process.env }
let server: Server, base: string
const run = jest.fn(async (_workflow: any, _input: any) => undefined)
const emit = jest.fn(async (_event: any) => undefined)
const nativeCart = {
  id: "cart_http",
  total: 12.5,
  currency_code: "usd",
  updated_at: new Date().toISOString(),
  items: [{ id: "item_http", quantity: 1 }],
}
const remoteQuery = jest.fn(async (_query: any) => [nativeCart])
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  const root = createContainer().register({
    [Modules.WORKFLOW_ENGINE]: asValue({ run }),
    [Modules.EVENT_BUS]: asValue({ emit }),
    [ContainerRegistrationKeys.REMOTE_QUERY]: asValue(remoteQuery),
    logger: asValue({ warn: jest.fn() }),
  })
  app.use((req: any, _res: any, next: any) => {
    req.scope = root.createScope()
    req.validatedBody = req.body
    req.queryConfig = { fields: ["id", "total", "items.*", "updated_at"] }
    next()
  })
  const handler = (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res)).catch(next)
  app.post(
    "/store/carts/:id/line-items",
    captureCartMeasurementResponse,
    handler(add.POST)
  )
  app.post(
    "/store/carts/:id/line-items/:line_id",
    captureCartMeasurementResponse,
    handler(line.POST)
  )
  app.delete(
    "/store/carts/:id/line-items/:line_id",
    captureCartMeasurementResponse,
    handler(line.DELETE)
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
    GP_CART_MEASUREMENT_ENABLED: "true",
    STRIPE_API_KEY: "sk_live_fixture",
  }
  jest.clearAllMocks()
})
afterEach(() => {
  process.env = { ...env }
})
it.each([
  ["POST", ""],
  ["POST", "/item_http"],
  ["DELETE", "/item_http"],
])(
  "captures the installed %s item handler response %s",
  async (method, suffix) => {
    const response = await fetch(
      `${base}/store/carts/cart_http/line-items${suffix}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST"
          ? {
              body: JSON.stringify({ variant_id: "variant_http", quantity: 1 }),
            }
          : {}),
      }
    )
    expect(response.status).toBe(200)
    const body: any = await response.json()
    expect(method === "DELETE" ? body.parent : body.cart).toEqual(nativeCart)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0].data).toMatchObject({
      lane: "production",
      context: null,
      cart: { id: "cart_http", value: 12.5, item_count: 1 },
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(remoteQuery).toHaveBeenCalledTimes(1)
  }
)
it("does not capture a native workflow failure or fabricate a success response", async () => {
  run.mockRejectedValueOnce(new Error("fixture"))
  const response = await fetch(`${base}/store/carts/cart_http/line-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_id: "variant_http", quantity: 1 }),
  })
  expect(response.status).toBe(500)
  expect(emit).not.toHaveBeenCalled()
  expect(remoteQuery).not.toHaveBeenCalled()
})
