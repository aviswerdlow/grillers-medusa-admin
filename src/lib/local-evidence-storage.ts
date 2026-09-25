import { randomUUID } from "node:crypto"
import {
  evidenceRetentionUntil, LocalEvidenceError, validateEvidenceBytes,
  validateEvidenceLinkLifetime, validateEvidenceUpload,
  type EvidenceRecord, type EvidenceRetention, type EvidenceUpload, type LocalEvidenceStorage,
} from "./local-evidence-contract"
import type GpLocalEvidenceFileService from "../modules/gp-local-evidence/service"

const extension: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
}

export function configuredEvidenceRetention(): EvidenceRetention {
  const raw = process.env.GP_LOCAL_EVIDENCE_RETENTION_DAYS?.trim()
  if (!raw) return { days: null }
  const days = Number(raw)
  // This validates the configured value, even when no upload has completed yet.
  evidenceRetentionUntil(new Date(), { days })
  return { days }
}

function publicRecord(row: any): EvidenceRecord {
  return {
    evidenceId: row.evidence_id, uploadId: row.upload_id, orderId: row.order_id,
    contentType: row.content_type, sizeBytes: row.size_bytes, sha256: row.sha256,
    status: row.status, storedAt: row.stored_at ? new Date(row.stored_at).toISOString() : null,
    retainUntil: row.retain_until ? new Date(row.retain_until).toISOString() : null,
  }
}

/** The DB identity is committed before upload, so a lost response is retryable. */
export class PgLocalEvidenceStorage implements LocalEvidenceStorage {
  constructor(
    private readonly db: any,
    private readonly provider: GpLocalEvidenceFileService,
    private readonly actorId: string,
    private readonly canRead: (actorId: string, orderId: string) => Promise<boolean>,
    private readonly retention: EvidenceRetention = configuredEvidenceRetention(),
  ) {}

  async prepare(input: EvidenceUpload) {
    validateEvidenceUpload(input)
    const objectKey = `local-evidence/${input.orderId}/${input.uploadId}/${input.sha256}.${extension[input.contentType]}`
    const inserted = await this.db("gp_local_evidence").insert({
      evidence_id: `evidence_${randomUUID()}`, upload_id: input.uploadId,
      order_id: input.orderId, content_type: input.contentType,
      size_bytes: input.sizeBytes, sha256: input.sha256, object_key: objectKey,
      status: "pending", uploaded_by: this.actorId,
    }).onConflict("upload_id").ignore().returning("*")
    const row = inserted[0] || await this.db("gp_local_evidence").where({ upload_id: input.uploadId }).first()
    if (!row || row.order_id !== input.orderId || row.content_type !== input.contentType ||
      row.size_bytes !== input.sizeBytes || row.sha256 !== input.sha256 || row.status === "deleted")
      throw new LocalEvidenceError("evidence_upload_id_conflict")
    return { record: publicRecord(row), duplicate: !inserted.length }
  }

  async complete(input: { uploadId: string; orderId: string; bytes: Uint8Array }) {
    const row = await this.db("gp_local_evidence").where({ upload_id: input.uploadId, order_id: input.orderId }).first()
    if (!row || row.status === "deleted") throw new LocalEvidenceError("evidence_upload_not_found")
    validateEvidenceBytes(publicRecord(row), input.bytes)
    if (row.status === "stored_private") return { record: publicRecord(row), duplicate: true }
    await this.provider.upload({
      filename: row.object_key, mimeType: row.content_type,
      content: Buffer.from(input.bytes).toString("binary"), access: "private",
    })
    const storedAt = new Date()
    const rows = await this.db("gp_local_evidence")
      .where({ upload_id: input.uploadId, status: "pending" })
      .update({ status: "stored_private", stored_at: storedAt,
        retain_until: evidenceRetentionUntil(storedAt, this.retention) }).returning("*")
    const stored = rows[0] || await this.db("gp_local_evidence").where({ upload_id: input.uploadId }).first()
    if (stored?.status !== "stored_private") throw new LocalEvidenceError("evidence_completion_uncertain")
    return { record: publicRecord(stored), duplicate: !rows.length }
  }

  async listOrder(orderId: string): Promise<EvidenceRecord[]> {
    const rows = await this.db("gp_local_evidence").where({ order_id: orderId })
      .whereNot({ status: "deleted" }).orderBy("created_at", "asc")
    return rows.map(publicRecord)
  }

  async signDownload(input: { evidenceId: string; actorId: string; ttlSeconds: number; now?: Date }) {
    validateEvidenceLinkLifetime(input.ttlSeconds)
    const row = await this.db("gp_local_evidence").where({ evidence_id: input.evidenceId, status: "stored_private" }).first()
    if (!row || !await this.canRead(input.actorId, row.order_id))
      throw new LocalEvidenceError("evidence_access_denied")
    if (row.retain_until && new Date(row.retain_until).getTime() <= Date.now())
      throw new LocalEvidenceError("evidence_access_denied")
    const url = await this.provider.getPresignedDownloadUrl({ fileKey: row.object_key, expiresInSeconds: input.ttlSeconds })
    return { url, expiresAt: new Date((input.now || new Date()).getTime() + input.ttlSeconds * 1000).toISOString() }
  }
}

/** The worker removes expired objects before marking their ledger rows deleted. */
export async function pruneExpiredEvidence(db: any, provider: GpLocalEvidenceFileService, now = new Date()) {
  const rows = await db("gp_local_evidence").where({ status: "stored_private" })
    .whereNotNull("retain_until").where("retain_until", "<=", now).orderBy("retain_until", "asc").limit(50)
  for (const row of rows) {
    await provider.delete({ fileKey: row.object_key })
    await db("gp_local_evidence").where({ evidence_id: row.evidence_id, status: "stored_private" })
      .update({ status: "deleted", deleted_at: new Date() })
  }
  return rows.length
}
