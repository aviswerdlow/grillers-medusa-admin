import { createHash } from "node:crypto"
import { LocalEvidenceError } from "../local-evidence-contract"
import { PgLocalEvidenceStorage } from "../local-evidence-storage"

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const intent = {
  uploadId: "upload_retry_01", orderId: "order_fixture", contentType: "image/jpeg" as const,
  sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
}

/** Narrow SQL double: persists rows across service instances and models unique upload IDs. */
function ledgerDouble() {
  const rows = new Map<string, any>()
  const db = (_table: string) => {
    let match: Record<string, unknown> = {}
    const selected = () => [...rows.values()].filter(row => Object.entries(match).every(([key, value]) => row[key] === value))
    const query: any = {
      where(filters: Record<string, unknown>) { match = { ...match, ...filters }; return query },
      first: async () => selected()[0],
      insert(row: any) { return { onConflict: () => ({ ignore: () => ({ returning: async () => {
        if (rows.has(row.upload_id)) return []
        rows.set(row.upload_id, { ...row })
        return [{ ...row }]
      } }) }) } },
      update(changes: any) { return { returning: async () => {
        const found = selected()
        for (const row of found) Object.assign(row, changes)
        return found.map(row => ({ ...row }))
      } } },
    }
    return query
  }
  return { db, rows }
}

describe("#367 durable private evidence upload", () => {
  it("retains pending identity after a failed provider call and completes one retry", async () => {
    const { db, rows } = ledgerDouble()
    const provider: any = { upload: jest.fn().mockRejectedValueOnce(new Error("storage timeout")).mockResolvedValue({ key: "private", url: "" }) }
    const storage = new PgLocalEvidenceStorage(db, provider, "cus_driver", async () => true, { days: 30 })
    const first = await storage.prepare(intent)
    expect(first.record.status).toBe("pending")
    await expect(storage.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes })).rejects.toThrow("storage timeout")
    expect(rows.get(intent.uploadId).status).toBe("pending")
    expect((await storage.prepare(intent)).record.evidenceId).toBe(first.record.evidenceId)
    const done = await storage.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes })
    expect(done.record.status).toBe("stored_private")
    expect(done.record.retainUntil).not.toBeNull()
    expect((await storage.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes })).duplicate).toBe(true)
    expect(provider.upload).toHaveBeenCalledTimes(2)
    await expect(storage.prepare({ ...intent, sha256: "a".repeat(64) })).rejects.toThrow("evidence_upload_id_conflict")
    await expect(storage.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes: Buffer.from([1, 2]) })).rejects.toThrow("evidence_content_mismatch")
  })

  it("denies an unauthorized evidence link before signing", async () => {
    const { db } = ledgerDouble()
    const provider: any = { upload: jest.fn(async () => ({})), getPresignedDownloadUrl: jest.fn(async () => "https://signed.fixture.test") }
    const storage = new PgLocalEvidenceStorage(db, provider, "cus_driver", async actor => actor === "cus_driver", { days: null })
    const { record } = await storage.prepare(intent)
    await storage.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes })
    await expect(storage.signDownload({ evidenceId: record.evidenceId, actorId: "anonymous", ttlSeconds: 60 })).rejects.toThrow(LocalEvidenceError)
    expect(provider.getPresignedDownloadUrl).not.toHaveBeenCalled()
    const signed = await storage.signDownload({ evidenceId: record.evidenceId, actorId: "cus_driver", ttlSeconds: 60 })
    expect(signed.url).toBe("https://signed.fixture.test")
    expect(provider.getPresignedDownloadUrl).toHaveBeenCalledWith(expect.objectContaining({ expiresInSeconds: 60 }))
  })
})
