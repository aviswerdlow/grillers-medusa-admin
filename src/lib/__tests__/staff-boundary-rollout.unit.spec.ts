jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })) }))

let report: typeof import("../staff-boundary-rollout").reportStaffBoundaryDenial
let emit: jest.Mock
let now: number
const priorMode = process.env.GP_STAFF_BOUNDARY_MODE
beforeEach(() => {
  jest.resetModules()
  now = 1_000_000
  jest.spyOn(Date, "now").mockImplementation(() => now)
  delete process.env.GP_STAFF_BOUNDARY_MODE
  report = require("../staff-boundary-rollout").reportStaffBoundaryDenial
  emit = require("../ops-alert").emitOpsAlert
})
afterEach(() => {
  jest.restoreAllMocks()
  if (priorMode === undefined) delete process.env.GP_STAFF_BOUNDARY_MODE
  else process.env.GP_STAFF_BOUNDARY_MODE = priorMode
})
function fixture() {
  const logger = { warn: jest.fn(), error: jest.fn() }
  const req: any = { method: "GET", path: "/admin/orders?email=private@example.invalid", headers: { authorization: "secret-value" },
    body: { phone: "+14045550100" }, query: { token: "secret-value" },
    auth_context: { actor_type: "api-key", actor_id: "key_fixture" }, scope: { resolve: () => logger } }
  return { req, logger }
}
it("coalesces dashboard traffic across actors and reports the suppressed count after five minutes", () => {
  const { req, logger } = fixture()
  report(req, "admin", "unapproved_capability")
  for (let i = 0; i < 1000; i++) { req.auth_context.actor_id = `key_${i}`; report(req, "admin", "unapproved_capability") }
  expect(emit).toHaveBeenCalledTimes(1)
  expect(logger.warn).toHaveBeenCalledTimes(1)
  now += 5 * 60 * 1000
  report(req, "admin", "unapproved_capability")
  expect(emit).toHaveBeenCalledTimes(2)
  expect(emit.mock.calls[1][0].meta.suppressed_since_previous).toBe(1000)
  expect(logger.warn).toHaveBeenCalledTimes(2)
})
it("does not hide a different boundary, failure reason or rollout mode", () => {
  const { req } = fixture()
  report(req, "admin", "unapproved_capability")
  report(req, "cart", "unsigned_legacy_cart")
  report(req, "admin", "lookup_unavailable")
  process.env.GP_STAFF_BOUNDARY_MODE = "enforce"
  report(req, "admin", "unapproved_capability")
  expect(emit).toHaveBeenCalledTimes(4)
})
it("holds until the window boundary and starts a fresh count after reporting", () => {
  const { req } = fixture()
  report(req, "admin", "lookup_unavailable")
  now += 299999; report(req, "admin", "lookup_unavailable")
  expect(emit).toHaveBeenCalledTimes(1)
  now += 1; report(req, "admin", "lookup_unavailable")
  expect(emit.mock.calls[1][0].meta.suppressed_since_previous).toBe(1)
  now += 300000; report(req, "admin", "lookup_unavailable")
  expect(emit.mock.calls[2][0].meta.suppressed_since_previous).toBe(0)
})
it("keeps failed alert delivery off the request path and throttles retries", async () => {
  const { req } = fixture()
  emit.mockRejectedValueOnce(new Error("Synthetic receiver failure"))
  expect(() => report(req, "admin", "lookup_unavailable")).not.toThrow()
  await Promise.resolve()
  report(req, "admin", "lookup_unavailable")
  expect(emit).toHaveBeenCalledTimes(1)
  now += 300000; report(req, "admin", "lookup_unavailable")
  expect(emit).toHaveBeenCalledTimes(2)
})
it("does not include request bodies, URLs, query strings or credentials in alerts or logs", () => {
  const { req, logger } = fixture()
  report(req, "admin", "unapproved_capability")
  const output = JSON.stringify({ alert: emit.mock.calls[0][0], logs: logger.warn.mock.calls })
  for (const secret of ["private@example.invalid", "secret-value", "+14045550100", "/admin/orders?"]) expect(output).not.toContain(secret)
  expect(emit.mock.calls[0][0]).toMatchObject({ severity: "warn", fingerprint: "staff-boundary:admin:unapproved_capability", meta: { transport_id: "key_fixture", suppressed_since_previous: 0 } })
})
it("recovers if the process clock moves backwards", () => {
  const { req } = fixture()
  report(req, "admin", "lookup_unavailable")
  now -= 60000; report(req, "admin", "lookup_unavailable")
  report(req, "admin", "lookup_unavailable")
  expect(emit).toHaveBeenCalledTimes(2)
})
