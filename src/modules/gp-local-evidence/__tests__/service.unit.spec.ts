import { PutObjectCommand } from "@aws-sdk/client-s3"
import GpLocalEvidenceFileService from "../service"

const key = `local-evidence/order_fixture/upload_private_01/${"a".repeat(64)}.jpg`
const options = {
  bucket: "gp-private-evidence-fixture", endpoint: "https://fixture.storage.supabase.co/storage/v1/s3",
  region: "fixture", access_key_id: "fixture-id", secret_access_key: "fixture-secret",
}

describe("#367 private Medusa file provider", () => {
  const original = process.env.GP_LOCAL_MILESTONES_ENABLED
  beforeEach(() => { process.env.GP_LOCAL_MILESTONES_ENABLED = "true" })
  afterAll(() => { if (original === undefined) delete process.env.GP_LOCAL_MILESTONES_ENABLED; else process.env.GP_LOCAL_MILESTONES_ENABLED = original })

  it("uploads to a separate bucket with no ACL or public URL", async () => {
    const provider = new GpLocalEvidenceFileService({}, options)
    const send = jest.fn(async (_command: unknown) => ({}))
    ;(provider as any).client_ = { send }
    const result = await provider.upload({ filename: key, mimeType: "image/jpeg", content: "abc", access: "private" })
    const command = send.mock.calls[0][0] as PutObjectCommand
    expect(command.input).toMatchObject({ Bucket: options.bucket, Key: key, ContentType: "image/jpeg", CacheControl: "private, no-store" })
    expect(command.input).not.toHaveProperty("ACL")
    expect(result).toEqual({ key, url: "" })
    await expect(provider.upload({ filename: key, mimeType: "image/jpeg", content: "abc", access: "public" })).rejects.toThrow("invalid_evidence_upload")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("signs only bounded GET links and remains off without the master flag", async () => {
    const provider = new GpLocalEvidenceFileService({}, options)
    const url = new URL(await provider.getPresignedDownloadUrl({ fileKey: key, expiresInSeconds: 60 }))
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60")
    expect(url.pathname).toContain(`/${options.bucket}/`)
    await expect(provider.getPresignedDownloadUrl({ fileKey: key, expiresInSeconds: 301 })).rejects.toThrow("invalid_evidence_link_lifetime")
    process.env.GP_LOCAL_MILESTONES_ENABLED = "false"
    await expect(provider.getPresignedDownloadUrl({ fileKey: key })).rejects.toThrow("local_milestones_disabled")
  })
})
