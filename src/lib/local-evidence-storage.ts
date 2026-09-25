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
const DAY_MS = 24 * 60 * 60 * 1000
const PENDING_GRACE_DAYS = 7
const PRUNE_BATCH_SIZE = 100
const S3_UPLOAD_TIMEOUT_MS = 30_000

export function configuredEvidenceRetention(): EvidenceRetention {
  const raw = process.env.GP_LOCAL_EVIDENCE_RETENTION_DAYS?.trim()
  if (!raw) return { days: null }
  const days = Number(raw)
  // This validates the configured value, even when no upload has completed yet.
  evidenceRetentionUntil(new Date(), { days })
  return { days }
}

function effectiveRetainUntil(row: any, retention: EvidenceRetention) {
  // A policy set after upload applies to existing photos as well.
  const storedAt = row.stored_at || row.created_at
  if (!storedAt) throw new LocalEvidenceError("evidence_stored_at_missing")
  return evidenceRetentionUntil(new Date(storedAt), retention)
}

function publicRecord(row: any, retention: EvidenceRetention): EvidenceRecord {
  return {
    evidenceId: row.evidence_id, uploadId: row.upload_id, orderId: row.order_id,
    contentType: row.content_type, sizeBytes: row.size_bytes, sha256: row.sha256,
    status: row.status, storedAt: row.stored_at ? new Date(row.stored_at).toISOString() : null,
    retainUntil: row.status === "stored_private" ? effectiveRetainUntil(row, retention) : null,
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
    return { record: publicRecord(row, this.retention), duplicate: !inserted.length }
  }

  async complete(input: { uploadId: string; orderId: string; bytes: Uint8Array }) {
    // Hold the row lock through the object write. A stale-pending sweep cannot
    // delete an object while an authorized retry is completing it.
    return this.db.transaction(async (tx: any) => {
      const row = await tx("gp_local_evidence")
        .where({ upload_id: input.uploadId, order_id: input.orderId }).forUpdate().first()
      if (!row || row.status === "deleted") throw new LocalEvidenceError("evidence_upload_not_found")
      validateEvidenceBytes(publicRecord(row, this.retention), input.bytes)
      if (row.status === "stored_private") return { record: publicRecord(row, this.retention), duplicate: true }
      await this.provider.upload({
        filename: row.object_key, mimeType: row.content_type,
        content: Buffer.from(input.bytes).toString("binary"), access: "private",
      }, { abortSignal: AbortSignal.timeout(S3_UPLOAD_TIMEOUT_MS) })
      const storedAt = new Date()
      const rows = await tx("gp_local_evidence")
        .where({ upload_id: input.uploadId, status: "pending" })
        .update({ status: "stored_private", stored_at: storedAt,
          retain_until: evidenceRetentionUntil(storedAt, this.retention) }).returning("*")
      const stored = rows[0] || await tx("gp_local_evidence").where({ upload_id: input.uploadId }).first()
      if (stored?.status !== "stored_private") throw new LocalEvidenceError("evidence_completion_uncertain")
      return { record: publicRecord(stored, this.retention), duplicate: !rows.length }
    })
  }

  async listOrder(orderId: string): Promise<EvidenceRecord[]> {
    const rows = await this.db("gp_local_evidence").where({ order_id: orderId })
      .whereNot({ status: "deleted" }).orderBy("created_at", "asc")
    return rows.map((row: any) => publicRecord(row, this.retention))
  }

  async signDownload(input: { evidenceId: string; actorId: string; ttlSeconds: number; now?: Date }) {
    validateEvidenceLinkLifetime(input.ttlSeconds)
    const row = await this.db("gp_local_evidence").where({ evidence_id: input.evidenceId, status: "stored_private" }).first()
    if (!row || !await this.canRead(input.actorId, row.order_id))
      throw new LocalEvidenceError("evidence_access_denied")
    const retainUntil = effectiveRetainUntil(row, this.retention)
    if (retainUntil && new Date(retainUntil).getTime() <= (input.now || new Date()).getTime())
      throw new LocalEvidenceError("evidence_access_denied")
    const url = await this.provider.getPresignedDownloadUrl({ fileKey: row.object_key, expiresInSeconds: input.ttlSeconds })
    return { url, expiresAt: new Date((input.now || new Date()).getTime() + input.ttlSeconds * 1000).toISOString() }
  }
}

/** Drain all due rows in batches. Failed deletes remain retryable on the next run. */
export async function pruneExpiredEvidence(
  db: any, provider: GpLocalEvidenceFileService, now = new Date(),
  retention: EvidenceRetention = configuredEvidenceRetention(),
) {
  evidenceRetentionUntil(now, retention)
  const pendingCutoff = new Date(now.getTime() - PENDING_GRACE_DAYS * DAY_MS)
  let deleted = 0
  let failed = 0

  async function sweep(status: "pending" | "stored_private") {
    let cursor = ""
    while (true) {
      const query = db("gp_local_evidence").where({ status })
        .where("evidence_id", ">", cursor).orderBy("evidence_id", "asc").limit(PRUNE_BATCH_SIZE)
      if (status === "pending") query.where("created_at", "<=", pendingCutoff)
      const rows = await query
      if (!rows.length) break
      cursor = rows[rows.length - 1].evidence_id

      for (const row of rows) {
        const retainUntil = status === "stored_private" ? effectiveRetainUntil(row, retention) : null
        if (status === "stored_private") {
          const stamped = row.retain_until ? new Date(row.retain_until).toISOString() : null
          if (stamped !== retainUntil)
            await db("gp_local_evidence").where({ evidence_id: row.evidence_id, status })
              .update({ retain_until: retainUntil })
          if (!retainUntil || new Date(retainUntil).getTime() > now.getTime()) continue
        }

        try {
          const removed = await db.transaction(async (tx: any) => {
            const locked = await tx("gp_local_evidence")
              .where({ evidence_id: row.evidence_id, status }).forUpdate().skipLocked().first()
            if (!locked) return false
            const due = status === "pending"
              ? new Date(locked.created_at).getTime() <= pendingCutoff.getTime()
              : (() => {
                  const expiry = effectiveRetainUntil(locked, retention)
                  return !!expiry && new Date(expiry).getTime() <= now.getTime()
                })()
            if (!due) return false
            // S3 delete is idempotent, so an interrupted delete can be retried.
            await provider.delete({ fileKey: locked.object_key })
            await tx("gp_local_evidence").where({ evidence_id: locked.evidence_id, status })
              .update({ status: "deleted", deleted_at: now, retain_until: retainUntil })
            return true
          })
          if (removed) deleted++
        } catch {
          failed++
        }
      }
    }
  }

  // Pending identities can outlive a failed provider write even without a
  // configured photo-retention policy. Delete their deterministic object key.
  await sweep("pending")
  if (retention.days !== null) await sweep("stored_private")
  if (failed) throw new LocalEvidenceError("evidence_prune_failed")
  return deleted
}
