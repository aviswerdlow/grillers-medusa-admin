import { createHash, randomUUID } from "node:crypto"
import {
  evidenceRetentionUntil, LocalEvidenceError, validateEvidenceBytes,
  validateEvidenceLinkLifetime, validateEvidenceUpload,
  type EvidenceRecord, type EvidenceRetention, type EvidenceUpload, type LocalEvidenceStorage,
} from "../local-evidence-contract"

/** Test-only in-memory double; there is no production provider or upload route. */
class MemoryPrivateEvidence implements LocalEvidenceStorage {
  private records = new Map<string, EvidenceRecord>()
  private bytes = new Map<string, Uint8Array>()
  private signed = new Map<string, { evidenceId: string; expiresAt: number }>()

  constructor(private retention: EvidenceRetention = { days: null },
    private canRead: (actorId: string, orderId: string) => boolean = () => false) {}

  async prepare(input: EvidenceUpload) {
    validateEvidenceUpload(input)
    const prior = this.records.get(input.uploadId)
    if (prior) {
      if (prior.orderId !== input.orderId || prior.sha256 !== input.sha256 ||
        prior.contentType !== input.contentType || prior.sizeBytes !== input.sizeBytes)
        throw new LocalEvidenceError("evidence_upload_id_conflict")
      return { record: prior, duplicate: true }
    }
    const record: EvidenceRecord = { ...input, evidenceId: `evidence_${randomUUID()}`,
      status: "pending", storedAt: null, retainUntil: null }
    this.records.set(input.uploadId, record)
    return { record, duplicate: false }
  }

  async complete(input: { uploadId: string; orderId: string; bytes: Uint8Array }) {
    const record = this.records.get(input.uploadId)
    if (!record || record.orderId !== input.orderId) throw new LocalEvidenceError("evidence_upload_not_found")
    validateEvidenceBytes(record, input.bytes)
    if (record.status === "stored_private") return { record, duplicate: true }
    const storedAt = new Date()
    const stored = { ...record, status: "stored_private" as const,
      storedAt: storedAt.toISOString(), retainUntil: evidenceRetentionUntil(storedAt, this.retention) }
    this.records.set(input.uploadId, stored)
    this.bytes.set(stored.evidenceId, input.bytes)
    return { record: stored, duplicate: false }
  }

  async signDownload(input: { evidenceId: string; actorId: string; ttlSeconds: number; now?: Date }) {
    validateEvidenceLinkLifetime(input.ttlSeconds)
    const record = [...this.records.values()].find(item => item.evidenceId === input.evidenceId)
    if (!record || record.status !== "stored_private" || !this.canRead(input.actorId, record.orderId))
      throw new LocalEvidenceError("evidence_access_denied")
    const expiresAt = (input.now || new Date()).getTime() + input.ttlSeconds * 1000
    const token = randomUUID()
    this.signed.set(token, { evidenceId: input.evidenceId, expiresAt })
    return { url: `memory-private://${token}`, expiresAt: new Date(expiresAt).toISOString() }
  }

  readSigned(url: string, now = new Date()) {
    const token = url.startsWith("memory-private://") ? url.slice("memory-private://".length) : ""
    const link = this.signed.get(token)
    if (!link || now.getTime() >= link.expiresAt) throw new LocalEvidenceError("evidence_access_denied")
    return this.bytes.get(link.evidenceId)
  }

  readPublic(_evidenceId: string): never { throw new LocalEvidenceError("evidence_access_denied") }
  get(uploadId: string) { return this.records.get(uploadId) }
}

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
function upload(uploadId: string, bytes = jpeg, contentType = "image/jpeg") {
  return { uploadId, orderId: "order_fixture", contentType: contentType as EvidenceUpload["contentType"],
    sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }
}

describe("#367 private evidence contract (in-memory only)", () => {
  it("F367-11 rejects invalid type, size, content, and mismatched bytes", () => {
    expect(() => validateEvidenceUpload(upload("upload_bad_type", jpeg, "text/plain"))).toThrow("invalid_evidence_upload")
    expect(() => validateEvidenceUpload({ ...upload("upload_too_large"), sizeBytes: 10 * 1024 * 1024 + 1 })).toThrow("invalid_evidence_upload")
    expect(() => validateEvidenceBytes(upload("upload_bad_magic", Uint8Array.from([1, 2, 3])), Uint8Array.from([1, 2, 3]))).toThrow("unsupported_evidence_bytes")
    expect(() => validateEvidenceBytes(upload("upload_bad_hash"), Uint8Array.from([0xff, 0xd8, 0xff]))).toThrow("evidence_content_mismatch")
  })

  it("F367-12 keeps one identity across interrupted upload and retry", async () => {
    const store = new MemoryPrivateEvidence()
    const intent = upload("upload_retry_01")
    const first = await store.prepare(intent)
    expect(first.record.status).toBe("pending")
    expect(store.get(intent.uploadId)?.status).toBe("pending")
    expect((await store.prepare(intent)).record.evidenceId).toBe(first.record.evidenceId)
    const completed = await store.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes: jpeg })
    expect(completed.record.status).toBe("stored_private")
    expect(completed.record.evidenceId).toBe(first.record.evidenceId)
    expect((await store.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes: jpeg })).duplicate).toBe(true)
    await expect(store.prepare({ ...intent, sha256: "a".repeat(64) })).rejects.toThrow("evidence_upload_id_conflict")
  })

  it("F367-19 denies public and unauthorized reads and expires signed links", async () => {
    const store = new MemoryPrivateEvidence({ days: null }, (actorId, orderId) => actorId === "cus_office" && orderId === "order_fixture")
    const intent = upload("upload_private_01")
    const prepared = await store.prepare(intent)
    await store.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes: jpeg })
    expect(() => store.readPublic(prepared.record.evidenceId)).toThrow("evidence_access_denied")
    await expect(store.signDownload({ evidenceId: prepared.record.evidenceId, actorId: "anonymous", ttlSeconds: 60 })).rejects.toThrow("evidence_access_denied")
    const now = new Date("2026-09-24T12:00:00Z")
    const link = await store.signDownload({ evidenceId: prepared.record.evidenceId, actorId: "cus_office", ttlSeconds: 60, now })
    expect(store.readSigned(link.url, new Date("2026-09-24T12:00:59Z"))).toEqual(jpeg)
    expect(() => store.readSigned(link.url, new Date("2026-09-24T12:01:00Z"))).toThrow("evidence_access_denied")
    expect(() => validateEvidenceLinkLifetime(301)).toThrow("invalid_evidence_link_lifetime")
  })

  it("defaults to no deletion date and accepts a configured retention period", async () => {
    expect(evidenceRetentionUntil(new Date("2026-09-24T00:00:00Z"), { days: null })).toBeNull()
    expect(evidenceRetentionUntil(new Date("2026-09-24T00:00:00Z"), { days: 120 })).toBe("2027-01-22T00:00:00.000Z")
    expect(() => evidenceRetentionUntil(new Date(), { days: 119 })).toThrow("invalid_evidence_retention")
    expect(() => evidenceRetentionUntil(new Date(), { days: 0 })).toThrow("invalid_evidence_retention")
  })
})
