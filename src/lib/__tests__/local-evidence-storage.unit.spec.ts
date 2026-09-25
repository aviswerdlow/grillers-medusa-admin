import { createHash } from "node:crypto"
import { LocalEvidenceError } from "../local-evidence-contract"
import { PgLocalEvidenceStorage, pruneExpiredEvidence } from "../local-evidence-storage"

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const intent = {
  uploadId: "upload_retry_01", orderId: "order_fixture", contentType: "image/jpeg" as const,
  sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
}

/** Narrow SQL double: persists rows across service instances and models unique upload IDs. */
function ledgerDouble() {
  const rows = new Map<string, any>()
  const db: any = (_table: string) => {
    const filters: ((row: any) => boolean)[] = []
    let sortColumn: string | null = null
    let take = Infinity
    const selected = () => {
      const result = [...rows.values()].filter(row => filters.every(filter => filter(row)))
      if (sortColumn) result.sort((a, b) => String(a[sortColumn!]).localeCompare(String(b[sortColumn!])))
      return result.slice(0, take)
    }
    const query: any = {
      where(key: Record<string, unknown> | string, operator?: string, value?: unknown) {
        if (typeof key === "string") {
          filters.push(row => operator === ">" ? row[key] > value! : row[key] <= value!)
        } else {
          filters.push(row => Object.entries(key).every(([name, expected]) => row[name] === expected))
        }
        return query
      },
      forUpdate() { return query },
      skipLocked() { return query },
      orderBy(column: string) { sortColumn = column; return query },
      limit(count: number) { take = count; return query },
      first: async () => selected()[0],
      insert(row: any) { return { onConflict: () => ({ ignore: () => ({ returning: async () => {
        if (rows.has(row.upload_id)) return []
        const inserted = { created_at: new Date(), stored_at: null, retain_until: null, ...row }
        rows.set(row.upload_id, inserted)
        return [{ ...inserted }]
      } }) }) } },
      update(changes: any) {
        let updated: any[] | null = null
        const apply = () => {
          if (updated) return updated
          const found = selected()
          for (const row of found) Object.assign(row, changes)
          updated = found.map(row => ({ ...row }))
          return updated
        }
        return {
          returning: async () => apply(),
          then: (resolve: (count: number) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(apply().length).then(resolve, reject),
        }
      },
      then: (resolve: (value: any[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(selected()).then(resolve, reject),
    }
    return query
  }
  db.transaction = async (work: (tx: any) => Promise<unknown>) => work(db)
  return { db, rows }
}

describe("#367 durable private evidence upload", () => {
  it("retains pending identity after a failed provider call and completes one retry", async () => {
    const { db, rows } = ledgerDouble()
    const provider: any = { upload: jest.fn().mockRejectedValueOnce(new Error("storage timeout")).mockResolvedValue({ key: "private", url: "" }) }
    const storage = new PgLocalEvidenceStorage(db, provider, "cus_driver", async () => true, { days: 120 })
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

  it("bounds the S3 upload while holding the row lock and leaves a timeout retryable", async () => {
    const { db, rows } = ledgerDouble()
    const signal = AbortSignal.abort(new Error("storage timeout"))
    const deadline = jest.spyOn(AbortSignal, "timeout").mockReturnValue(signal)
    const provider: any = { upload: jest.fn(async (_file: unknown, options: { abortSignal: AbortSignal }) => {
      expect(options.abortSignal).toBe(signal)
      throw options.abortSignal.reason
    }) }
    const storage = new PgLocalEvidenceStorage(db, provider, "cus_driver", async () => true, { days: 120 })
    try {
      await storage.prepare(intent)
      await expect(storage.complete({ uploadId: intent.uploadId, orderId: intent.orderId, bytes }))
        .rejects.toThrow("storage timeout")
      expect(deadline).toHaveBeenCalledWith(30_000)
      expect(provider.upload).toHaveBeenCalledTimes(1)
      expect(rows.get(intent.uploadId).status).toBe("pending")
    } finally {
      deadline.mockRestore()
    }
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

  it("applies a later retention policy and drains more than 50 expired and abandoned uploads", async () => {
    const { db, rows } = ledgerDouble()
    const provider: any = {
      upload: jest.fn(async () => ({})), delete: jest.fn(async () => {}),
      getPresignedDownloadUrl: jest.fn(async () => "https://signed.fixture.test"),
    }
    const noPolicy = new PgLocalEvidenceStorage(db, provider, "cus_driver", async () => true, { days: null })
    const now = new Date("2026-12-10T00:00:00Z")
    for (let index = 0; index < 51; index++) {
      const upload = { ...intent, uploadId: `upload_abandoned_${String(index).padStart(3, "0")}` }
      await noPolicy.prepare(upload)
      rows.get(upload.uploadId).created_at = new Date("2026-12-01T00:00:00Z")
    }
    const old = { ...intent, uploadId: "upload_stored_old" }
    const { record } = await noPolicy.prepare(old)
    await noPolicy.complete({ uploadId: old.uploadId, orderId: old.orderId, bytes })
    Object.assign(rows.get(old.uploadId), {
      stored_at: new Date("2026-08-01T00:00:00Z"), retain_until: null,
    })
    const storedRecent = { ...intent, uploadId: "upload_stored_recent" }
    await noPolicy.prepare(storedRecent)
    await noPolicy.complete({ uploadId: storedRecent.uploadId, orderId: storedRecent.orderId, bytes })
    Object.assign(rows.get(storedRecent.uploadId), {
      stored_at: new Date("2026-12-01T00:00:00Z"), retain_until: null,
    })
    const recent = { ...intent, uploadId: "upload_pending_new" }
    await noPolicy.prepare(recent)
    rows.get(recent.uploadId).created_at = new Date("2026-12-09T00:00:00Z")

    const withPolicy = new PgLocalEvidenceStorage(db, provider, "cus_driver", async () => true, { days: 120 })
    await expect(withPolicy.signDownload({ evidenceId: record.evidenceId, actorId: "cus_driver", ttlSeconds: 60, now }))
      .rejects.toThrow("evidence_access_denied")
    expect(provider.getPresignedDownloadUrl).not.toHaveBeenCalled()
    await expect(pruneExpiredEvidence(db, provider, now, { days: 119 }))
      .rejects.toThrow("invalid_evidence_retention")
    expect(provider.delete).not.toHaveBeenCalled()
    const reports: any[] = []
    expect(await pruneExpiredEvidence(db, provider, now, { days: 120 }, report => reports.push(report))).toBe(52)
    expect(reports).toEqual([{ deleted: 52, pendingDeleted: 51, storedDeleted: 1, failed: 0, errorCodes: {} }])
    expect(provider.delete).toHaveBeenCalledTimes(52)
    expect(provider.delete.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal)
    expect(rows.get(old.uploadId).retain_until).toBe("2026-11-29T00:00:00.000Z")
    expect(rows.get(old.uploadId).status).toBe("deleted")
    expect(rows.get(storedRecent.uploadId).retain_until).toBe("2027-03-31T00:00:00.000Z")
    expect(rows.get(storedRecent.uploadId).status).toBe("stored_private")
    expect(rows.get(recent.uploadId).status).toBe("pending")
    expect(await pruneExpiredEvidence(db, provider, now, { days: 120 })).toBe(0)
  })

  it("keeps a failed deletion retryable while pruning later rows", async () => {
    const { db, rows } = ledgerDouble()
    const provider: any = { delete: jest.fn().mockRejectedValueOnce(new Error("object store failed")).mockResolvedValue(undefined) }
    const now = new Date("2026-10-10T00:00:00Z")
    for (const uploadId of ["upload_failed_01", "upload_later_02"]) {
      await new PgLocalEvidenceStorage(db, provider, "cus_driver", async () => true, { days: null })
        .prepare({ ...intent, uploadId })
      rows.get(uploadId).created_at = new Date("2026-10-01T00:00:00Z")
    }
    const reports: any[] = []
    await expect(pruneExpiredEvidence(db, provider, now, { days: null }, report => reports.push(report)))
      .rejects.toThrow("evidence_prune_failed")
    expect(reports).toEqual([{ deleted: 1, pendingDeleted: 1, storedDeleted: 0, failed: 1, errorCodes: { Error: 1 } }])
    expect(provider.delete.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal)
    expect([...rows.values()].filter(row => row.status === "deleted")).toHaveLength(1)
    expect(await pruneExpiredEvidence(db, provider, now, { days: null })).toBe(1)
    expect([...rows.values()].filter(row => row.status === "deleted")).toHaveLength(2)
  })
})
