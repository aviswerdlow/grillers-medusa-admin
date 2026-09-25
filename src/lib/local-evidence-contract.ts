import { createHash } from "node:crypto"

/** Contract shared by the private provider, durable upload ledger and tests. */
export type EvidenceContentType = "image/jpeg" | "image/png" | "image/webp" | "image/heic"
export type EvidenceStatus = "pending" | "stored_private"

export type EvidenceUpload = {
  uploadId: string
  orderId: string
  contentType: EvidenceContentType
  sizeBytes: number
  sha256: string
}

export type EvidenceRecord = EvidenceUpload & {
  evidenceId: string
  status: EvidenceStatus
  storedAt: string | null
  retainUntil: string | null
}

export type EvidenceRetention = { days: number | null }

/** The adapter writes without an ACL header into a dedicated private bucket. */
export interface PrivateEvidenceObjectStore {
  readonly access: "private"
  putObject(input: { key: string; bytes: Uint8Array; contentType: EvidenceContentType }): Promise<void>
  signGetObject(input: { key: string; expiresInSeconds: number }): Promise<string>
}

export interface LocalEvidenceStorage {
  prepare(input: EvidenceUpload): Promise<{ record: EvidenceRecord; duplicate: boolean }>
  complete(input: { uploadId: string; orderId: string; bytes: Uint8Array }): Promise<{ record: EvidenceRecord; duplicate: boolean }>
  signDownload(input: { evidenceId: string; actorId: string; ttlSeconds: number; now?: Date }): Promise<{ url: string; expiresAt: string }>
}

export class LocalEvidenceError extends Error {
  constructor(readonly code: string) { super(code) }
}

const MAX_SIZE_BYTES = 10 * 1024 * 1024
const MAX_SIGNED_LINK_SECONDS = 300
const types: EvidenceContentType[] = ["image/jpeg", "image/png", "image/webp", "image/heic"]

export function validateEvidenceUpload(input: EvidenceUpload) {
  if (!/^[a-zA-Z0-9_:-]{8,128}$/.test(input.uploadId) ||
    !/^order_[a-zA-Z0-9_:-]{4,128}$/.test(input.orderId) ||
    !types.includes(input.contentType) ||
    !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_SIZE_BYTES ||
    !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new LocalEvidenceError("invalid_evidence_upload")
  }
}

export function validateEvidenceBytes(input: EvidenceUpload, bytes: Uint8Array) {
  validateEvidenceUpload(input)
  if (bytes.byteLength !== input.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
    throw new LocalEvidenceError("evidence_content_mismatch")
  }
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const ascii = (start: number, value: string) => Buffer.from(bytes.slice(start, start + value.length)).toString("ascii") === value
  const valid = input.contentType === "image/jpeg" ? starts(0xff, 0xd8, 0xff)
    : input.contentType === "image/png" ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    : input.contentType === "image/webp" ? ascii(0, "RIFF") && ascii(8, "WEBP")
    : ascii(4, "ftyp") && ["heic", "heix", "hevc", "mif1"].includes(Buffer.from(bytes.slice(8, 12)).toString("ascii"))
  if (!valid) throw new LocalEvidenceError("unsupported_evidence_bytes")
}

export function evidenceRetentionUntil(storedAt: Date, policy: EvidenceRetention): string | null {
  if (policy.days === null) return null
  if (!Number.isSafeInteger(policy.days) || policy.days < 1 || policy.days > 3650)
    throw new LocalEvidenceError("invalid_evidence_retention")
  return new Date(storedAt.getTime() + policy.days * 24 * 60 * 60 * 1000).toISOString()
}

export function validateEvidenceLinkLifetime(ttlSeconds: number) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_LINK_SECONDS)
    throw new LocalEvidenceError("invalid_evidence_link_lifetime")
}
