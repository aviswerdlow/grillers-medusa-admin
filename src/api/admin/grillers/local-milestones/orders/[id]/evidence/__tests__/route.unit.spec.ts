import { StaffAccessDenied, resolveStaffPrincipal } from "../../../../../../../../lib/staff-principal"
import { readEvidenceBytes } from "../../../../../../../../lib/local-evidence-http"
import { GET } from "../route"
import { PUT } from "../[uploadId]/route"

jest.mock("../../../../../../../../lib/staff-principal", () => ({
  ...jest.requireActual("../../../../../../../../lib/staff-principal"),
  resolveStaffPrincipal: jest.fn(),
}))

describe("#367 evidence route authentication", () => {
  const original = process.env.GP_LOCAL_MILESTONES_ENABLED
  const response = () => {
    const res: any = { statusCode: 200, body: null }
    res.status = (status: number) => { res.statusCode = status; return res }
    res.json = (body: unknown) => { res.body = body; return res }
    return res
  }
  beforeEach(() => { process.env.GP_LOCAL_MILESTONES_ENABLED = "true"; jest.clearAllMocks() })
  afterAll(() => { if (original === undefined) delete process.env.GP_LOCAL_MILESTONES_ENABLED; else process.env.GP_LOCAL_MILESTONES_ENABLED = original })

  it("denies unauthenticated list and upload before DB or object-store access", async () => {
    ;(resolveStaffPrincipal as jest.Mock).mockRejectedValue(new StaffAccessDenied("missing auth"))
    const resolve = jest.fn()
    const req: any = { params: { id: "order_fixture", uploadId: "upload_private_01" },
      scope: { resolve }, headers: { "content-type": "image/jpeg" } }
    const list = response(), upload = response()
    await GET(req, list)
    await PUT(req, upload)
    expect(list.statusCode).toBe(403)
    expect(upload.statusCode).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("hides both routes when the master flag is off", async () => {
    process.env.GP_LOCAL_MILESTONES_ENABLED = "false"
    const req: any = { params: { id: "order_fixture", uploadId: "upload_private_01" } }
    const list = response(), upload = response()
    await GET(req, list)
    await PUT(req, upload)
    expect(list.statusCode).toBe(404)
    expect(upload.statusCode).toBe(404)
    expect(resolveStaffPrincipal).not.toHaveBeenCalled()
  })

  it("bounds a chunked raw body before it reaches storage", async () => {
    const request: any = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(10 * 1024 * 1024)
        yield Buffer.from([1])
      },
    }
    await expect(readEvidenceBytes(request, 10 * 1024 * 1024 + 1))
      .rejects.toThrow("evidence_too_large")
  })
})
