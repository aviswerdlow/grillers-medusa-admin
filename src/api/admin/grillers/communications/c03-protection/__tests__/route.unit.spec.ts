import { POST } from "../route"
import { protectC03UnsubscribedFromContainer } from "../../../../../../lib/communications/cc-protective-suppression"

jest.mock("../../../../../../lib/communications/cc-protective-suppression", () => ({
  ...jest.requireActual("../../../../../../lib/communications/cc-protective-suppression"),
  protectC03UnsubscribedFromContainer: jest.fn(),
}))

function response() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  return res
}

describe("C03 protective suppression admin route", () => {
  beforeEach(() => jest.clearAllMocks())

  it("denies communications service credentials and ordinary staff", async () => {
    for (const principal of [
      { id: "service", kind: "service", role: "customer" },
      { id: "staff", kind: "customer", role: "staff" },
    ]) {
      const res = response()
      await POST({ gp_staff_principal: principal, body: { destinations: [] } } as any, res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    expect(protectC03UnsubscribedFromContainer).not.toHaveBeenCalled()
  })

  it("uses verified super-admin identity and returns counts only", async () => {
    const mocked = protectC03UnsubscribedFromContainer as jest.Mock
    mocked.mockResolvedValue({ audit_run_id: "run", target_count: 117, before_count: 0, after_count: 117, inserted_count: 117, replayed: false })
    const scope = { resolve: jest.fn() }
    const res = response()
    await POST({ gp_staff_principal: { id: "verified_owner", kind: "customer", role: "super_admin" }, scope,
      body: { destinations: ["protected@example.com"] } } as any, res)
    expect(mocked).toHaveBeenCalledWith(scope, ["protected@example.com"], "verified_owner")
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, before_count: 0, after_count: 117 }))
  })
})
