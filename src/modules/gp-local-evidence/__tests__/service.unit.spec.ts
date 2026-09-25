import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import GpLocalEvidenceFileService from "../service"

const key = `local-evidence/order_fixture/upload_private_01/${"a".repeat(64)}.jpg`
const options = {
  bucket: "gp-private-evidence-fixture", endpoint: "https://fixture.storage.supabase.co/storage/v1/s3",
  region: "fixture", access_key_id: "fixture-id", secret_access_key: "fixture-secret",
}

describe("#367 private Medusa file provider", () => {
  const original = process.env.GP_LOCAL_MILESTONES_ENABLED
  const originalPublicBucket = process.env.S3_BUCKET
  beforeEach(() => { process.env.GP_LOCAL_MILESTONES_ENABLED = "true" })
  afterEach(() => {
    if (originalPublicBucket === undefined) delete process.env.S3_BUCKET
    else process.env.S3_BUCKET = originalPublicBucket
  })
  afterAll(() => { if (original === undefined) delete process.env.GP_LOCAL_MILESTONES_ENABLED; else process.env.GP_LOCAL_MILESTONES_ENABLED = original })

  it("uploads to a separate bucket with no ACL or public URL", async () => {
    const provider = new GpLocalEvidenceFileService({}, options)
    const send = jest.fn(async (_command: unknown) => ({}))
    ;(provider as any).client_ = { send }
    const abortSignal = AbortSignal.timeout(30_000)
    const result = await provider.upload(
      { filename: key, mimeType: "image/jpeg", content: "abc", access: "private" },
      { abortSignal },
    )
    const command = send.mock.calls[0][0] as PutObjectCommand
    expect(send).toHaveBeenCalledWith(command, { abortSignal })
    expect(command.input).toMatchObject({ Bucket: options.bucket, Key: key, ContentType: "image/jpeg", CacheControl: "private, no-store" })
    expect(command.input).not.toHaveProperty("ACL")
    expect(result).toEqual({ key, url: "" })
    await expect(provider.upload({ filename: key, mimeType: "image/jpeg", content: "abc", access: "public" })).rejects.toThrow("invalid_evidence_upload")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("signs only bounded GET links and remains off without the master flag", async () => {
    const provider = new GpLocalEvidenceFileService({}, options)
    const url = new URL(await provider.getPresignedDownloadUrl({ fileKey: key, expiresInSeconds: 60 }))
    expect((provider as any).client_.config.forcePathStyle).toBe(true)
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60")
    expect(url.pathname).toContain(`/${options.bucket}/`)
    await expect(provider.getPresignedDownloadUrl({ fileKey: key, expiresInSeconds: 301 })).rejects.toThrow("invalid_evidence_link_lifetime")
    process.env.GP_LOCAL_MILESTONES_ENABLED = "false"
    await expect(provider.getPresignedDownloadUrl({ fileKey: key })).rejects.toThrow("local_milestones_disabled")
  })

  it("rejects the public media bucket and each missing private setting", async () => {
    process.env.S3_BUCKET = options.bucket
    await expect(new GpLocalEvidenceFileService({}, options)
      .getPresignedDownloadUrl({ fileKey: key })).rejects.toThrow("private_evidence_provider_unconfigured")
    delete process.env.S3_BUCKET
    for (const setting of Object.keys(options) as (keyof typeof options)[]) {
      const provider = new GpLocalEvidenceFileService({}, { ...options, [setting]: undefined })
      await expect(provider.getPresignedDownloadUrl({ fileKey: key }))
        .rejects.toThrow("private_evidence_provider_unconfigured")
    }
  })

  it("rejects an oversized provider body before S3 receives it", async () => {
    const provider = new GpLocalEvidenceFileService({}, options)
    const send = jest.fn()
    ;(provider as any).client_ = { send }
    await expect(provider.upload({
      filename: key, mimeType: "image/jpeg",
      content: Buffer.alloc(10 * 1024 * 1024 + 1).toString("binary"), access: "private",
    })).rejects.toThrow("invalid_evidence_upload")
    expect(send).not.toHaveBeenCalled()
  })

  it("forwards the prune deadline to S3 delete", async () => {
    const provider = new GpLocalEvidenceFileService({}, options)
    const send = jest.fn(async (_command: unknown) => ({}))
    ;(provider as any).client_ = { send }
    const abortSignal = AbortSignal.timeout(30_000)
    await provider.delete({ fileKey: key }, { abortSignal })
    const command = send.mock.calls[0][0] as DeleteObjectCommand
    expect(command.input).toMatchObject({ Bucket: options.bucket, Key: key })
    expect(send).toHaveBeenCalledWith(command, { abortSignal })
  })

  it("uses virtual-hosted URLs for Railway and accepts an explicit path-style override", async () => {
    const railway = { ...options, endpoint: "https://s3.railway.fixture.test" }
    const provider = new GpLocalEvidenceFileService({}, railway)
    await provider.getPresignedDownloadUrl({ fileKey: key })
    expect((provider as any).client_.config.forcePathStyle).toBe(false)

    const overridden = new GpLocalEvidenceFileService({}, { ...railway, force_path_style: "true" })
    await overridden.getPresignedDownloadUrl({ fileKey: key })
    expect((overridden as any).client_.config.forcePathStyle).toBe(true)

    const supabaseOverride = new GpLocalEvidenceFileService({}, { ...options, force_path_style: "false" })
    await supabaseOverride.getPresignedDownloadUrl({ fileKey: key })
    expect((supabaseOverride as any).client_.config.forcePathStyle).toBe(false)

    const invalid = new GpLocalEvidenceFileService({}, { ...railway, force_path_style: "maybe" })
    await expect(invalid.getPresignedDownloadUrl({ fileKey: key }))
      .rejects.toThrow("private_evidence_provider_unconfigured")
  })
})
