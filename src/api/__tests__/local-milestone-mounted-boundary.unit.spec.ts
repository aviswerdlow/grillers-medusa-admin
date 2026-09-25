import type { Server } from "node:http"
import { enforceStaffCapabilities } from "../middlewares/staff-capabilities"
import { resolveStaffPrincipal } from "../../lib/staff-principal"

jest.mock("../../lib/staff-principal", () => ({
  ...jest.requireActual("../../lib/staff-principal"),
  resolveStaffPrincipal: jest.fn(),
}))

const express = require("express")

describe("#367 staff capabilities on Medusa's app.use mount", () => {
  const original = process.env.GP_STAFF_BOUNDARY_MODE
  const paths: string[] = []
  let server: Server, baseUrl: string

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use("/admin/*", (req: any, res: any, next: any) => {
      paths.push(req.path)
      Promise.resolve(enforceStaffCapabilities(req, res, next)).catch(next)
    })
    app.all("/admin/*", (_req: any, res: any) => res.json({ admitted: true }))
    server = await new Promise(resolve => { const running = app.listen(0, "127.0.0.1", () => resolve(running)) })
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
  })
  beforeEach(() => { process.env.GP_STAFF_BOUNDARY_MODE = "enforce"; paths.length = 0; jest.clearAllMocks() })
  afterAll(async () => {
    if (original === undefined) delete process.env.GP_STAFF_BOUNDARY_MODE
    else process.env.GP_STAFF_BOUNDARY_MODE = original
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  const request = (path: string, method = "GET") => fetch(baseUrl + path, { method })
  const actor = (capabilities: string[]) => ({ id: "cus_driver", kind: "customer", role: "driver",
    capabilities: new Set(capabilities), auth: {}, transport_id: "gateway" })

  it("matches the original URL for assigned-driver routes and denies correction or generic orders", async () => {
    ;(resolveStaffPrincipal as jest.Mock).mockResolvedValue(actor(["milestones.drive"]))
    expect((await request("/admin/grillers/local-milestones/orders/order_fixture")).status).toBe(200)
    expect((await request("/admin/grillers/local-milestones/orders/order_fixture/events", "POST")).status).toBe(200)
    expect((await request("/admin/grillers/local-milestones/orders/order_fixture/evidence/upload_123456", "PUT")).status).toBe(200)
    expect((await request("/admin/grillers/local-milestones/orders/order_fixture/corrections", "POST")).status).toBe(403)
    expect((await request("/admin/orders/order_fixture")).status).toBe(403)
    expect(paths.every(path => path === "/")).toBe(true)
  })

  it("permits office corrections and denies ambiguous encoded paths", async () => {
    ;(resolveStaffPrincipal as jest.Mock).mockResolvedValue(actor(["milestones.drive", "milestones.office", "milestones.correct"]))
    expect((await request("/admin/grillers/local-milestones/orders/order_fixture/corrections", "POST")).status).toBe(200)
    expect((await request("/admin/grillers/local-milestones/orders/%6Frder_fixture/events", "POST")).status).toBe(403)
  })

  it("allows uppercase Medusa IDs and matches fixed route parts case-insensitively", async () => {
    ;(resolveStaffPrincipal as jest.Mock).mockResolvedValue(actor(["milestones.drive"]))
    const orderId = "order_01M3B31CA3FAWNE6SMC4VMMJFF"
    expect((await request(`/ADMIN/GRILLERS/LOCAL-MILESTONES/ORDERS/${orderId}/EVENTS`, "POST")).status).toBe(200)
    expect((await request(`/admin/grillers/local-milestones/orders/${orderId}/evidence/upload_123456`, "PUT")).status).toBe(200)
    expect((await request(`/admin/grillers/local-milestones/orders/${orderId}/CORRECTIONS`, "POST")).status).toBe(403)
  })
})
