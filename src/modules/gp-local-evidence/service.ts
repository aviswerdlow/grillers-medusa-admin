import {
  DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { FileTypes } from "@medusajs/framework/types"
import { AbstractFileProviderService } from "@medusajs/framework/utils"
import type { Readable } from "node:stream"
import { LocalEvidenceError, validateEvidenceLinkLifetime } from "../../lib/local-evidence-contract"

export type PrivateEvidenceOptions = {
  bucket?: string
  endpoint?: string
  region?: string
  access_key_id?: string
  secret_access_key?: string
  force_path_style?: string
}

function evidenceForcePathStyle(endpoint: string, setting?: string) {
  const value = setting?.trim().toLowerCase()
  if (value === "true") return true
  if (value === "false") return false
  if (value) throw new LocalEvidenceError("private_evidence_provider_unconfigured")
  // Supabase's S3 path requires the bucket in the URL path. Railway uses
  // virtual-hosted bucket URLs unless explicitly configured otherwise.
  return new URL(endpoint).hostname.endsWith(".supabase.co")
}

const evidenceKey = (key: string) => {
  if (!/^local-evidence\/order_[a-zA-Z0-9_:-]{4,128}\/[a-zA-Z0-9_:-]{8,128}\/[a-f0-9]{64}\.(?:jpg|png|webp|heic)$/.test(key))
    throw new LocalEvidenceError("invalid_evidence_key")
  return key
}

/** A Medusa file-provider implementation isolated from the public FILE module. */
export default class GpLocalEvidenceFileService extends AbstractFileProviderService {
  static identifier = "gp-local-evidence"
  private client_: S3Client | undefined

  constructor(_container: Record<string, unknown>, private readonly options_: PrivateEvidenceOptions = {}) {
    super()
  }

  private configured() {
    if (process.env.GP_LOCAL_MILESTONES_ENABLED !== "true")
      throw new LocalEvidenceError("local_milestones_disabled")
    const { bucket, endpoint, region, access_key_id, secret_access_key, force_path_style } = this.options_
    if (!bucket || bucket === process.env.S3_BUCKET || !endpoint || !region || !access_key_id || !secret_access_key ||
      !/^https:\/\//.test(endpoint)) throw new LocalEvidenceError("private_evidence_provider_unconfigured")
    const forcePathStyle = evidenceForcePathStyle(endpoint, force_path_style)
    if (!this.client_) this.client_ = new S3Client({
      region, endpoint, forcePathStyle,
      credentials: { accessKeyId: access_key_id, secretAccessKey: secret_access_key },
    })
    return { client: this.client_, bucket }
  }

  async upload(
    file: FileTypes.ProviderUploadFileDTO,
    options?: { abortSignal?: AbortSignal },
  ): Promise<FileTypes.ProviderFileResultDTO> {
    const key = evidenceKey(file.filename)
    if (file.access === "public" || !["image/jpeg", "image/png", "image/webp", "image/heic"].includes(file.mimeType))
      throw new LocalEvidenceError("invalid_evidence_upload")
    const body = Buffer.from(file.content, "binary")
    if (!body.length || body.length > 10 * 1024 * 1024)
      throw new LocalEvidenceError("invalid_evidence_upload")
    const { client, bucket } = this.configured()
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: file.mimeType,
      CacheControl: "private, no-store",
      // Supabase's S3 endpoint rejects x-amz-acl, even for private objects.
    }), options?.abortSignal ? { abortSignal: options.abortSignal } : {})
    // There is deliberately no public object URL to persist or return.
    return { key, url: "" }
  }

  async getPresignedDownloadUrl(file: FileTypes.ProviderGetFileDTO): Promise<string> {
    const key = evidenceKey(file.fileKey)
    const seconds = file.expiresInSeconds === undefined ? 60 : Number(file.expiresInSeconds)
    validateEvidenceLinkLifetime(seconds)
    const { client, bucket } = this.configured()
    return this.presign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), seconds)
  }

  protected presign(client: S3Client, command: GetObjectCommand, expiresIn: number) {
    return getSignedUrl(client, command, { expiresIn })
  }

  async delete(
    files: FileTypes.ProviderDeleteFileDTO | FileTypes.ProviderDeleteFileDTO[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<void> {
    const { client, bucket } = this.configured()
    for (const file of Array.isArray(files) ? files : [files])
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: evidenceKey(file.fileKey) }),
        options?.abortSignal ? { abortSignal: options.abortSignal } : {},
      )
  }

  async getDownloadStream(file: FileTypes.ProviderGetFileDTO): Promise<Readable> {
    const { client, bucket } = this.configured()
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: evidenceKey(file.fileKey) }))
    if (!result.Body) throw new LocalEvidenceError("evidence_object_missing")
    return result.Body as Readable
  }

  async getAsBuffer(file: FileTypes.ProviderGetFileDTO): Promise<Buffer> {
    const stream = await this.getDownloadStream(file)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
}
