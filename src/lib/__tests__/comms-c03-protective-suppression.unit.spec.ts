import crypto from "crypto"
import {
  C03ProtectionInputError,
  planC03ProtectiveSuppression,
  protectC03UnsubscribedDestinations,
} from "../communications/cc-protective-suppression"

const emails = ["a@example.com", "b@example.com"]
const spec = {
  count: 2,
  targetSha256: crypto.createHash("sha256").update("a@example.com\nb@example.com\n").digest("hex"),
  classificationSha256: "a".repeat(64),
  batchId: "c03-test-two-unsubscribed",
}

function fakeDb() {
  const tables: Record<string, any[]> = {
    gp_customer_profile: emails.map((email, index) => ({
      id: `profile_${index}`, email, email_lower: email, email_consent: true,
      email_consent_at: new Date("2026-07-08T00:00:00Z"),
    })),
    gp_suppression_preference: [{
      id: "prior", email: emails[0], email_lower: emails[0], scope: "marketing", topic: null,
      reason: "earlier_unsubscribe", source: "preferences_page", resubscribed_at: null,
    }],
    gp_import_run: [],
  }
  const writes: Array<{ table: string; op: string }> = []
  const db: any = (table: string) => {
    const tests: Array<(row: any) => boolean> = []
    let inserted: any
    const matched = () => (tables[table] || []).filter((row) => tests.every((test) => test(row)))
    const chain: any = {
      whereNull(field: string) { tests.push((row) => row[field] == null); return chain },
      where(field: string | Record<string, unknown>, value?: unknown) {
        if (typeof field === "object") {
          for (const [key, expected] of Object.entries(field)) tests.push((row) => row[key] === expected)
        } else tests.push((row) => row[field] === value)
        return chain
      },
      whereIn(field: string, values: unknown[]) { tests.push((row) => values.includes(row[field])); return chain },
      select() { return Promise.resolve(matched()) },
      first() { return Promise.resolve(matched()[0]) },
      insert(value: any) { inserted = value; return chain },
      onConflict() { return chain },
      ignore() { return chain },
      async returning() {
        const conflict = table === "gp_import_run"
          ? tables[table].some((row) => row.source === inserted.source && row.batch_id === inserted.batch_id)
          : table === "gp_suppression_preference"
            ? tables[table].some((row) => row.email_lower === inserted.email_lower && row.scope === inserted.scope &&
                row.topic == null && row.resubscribed_at == null && row.deleted_at == null)
            : false
        if (conflict) return []
        tables[table].push(inserted)
        writes.push({ table, op: "insert" })
        return [{ id: inserted.id }]
      },
      async update(value: any) {
        for (const row of matched()) Object.assign(row, value)
        writes.push({ table, op: "update" })
      },
    }
    return chain
  }
  db.transaction = async (callback: any) => callback(db)
  return { db, tables, writes }
}

describe("C03 protected unsubscribe batch", () => {
  it("requires the exact normalized destination set before any write", () => {
    expect(planC03ProtectiveSuppression([" B@EXAMPLE.COM ", "a@example.com"], spec).emails).toEqual(emails)
    expect(() => planC03ProtectiveSuppression([emails[0]], spec)).toThrow(C03ProtectionInputError)
    expect(() => planC03ProtectiveSuppression([emails[0], emails[0]], spec)).toThrow(/Duplicate/)
    expect(() => planC03ProtectiveSuppression([emails[0], "other@example.com"], spec)).toThrow(/digest mismatch/)
  })

  it("inserts only missing marketing holds, retains prior reason and consent, and audits idempotent replay", async () => {
    const { db, tables, writes } = fakeDb()
    const first = await protectC03UnsubscribedDestinations(db, emails, "staff_verified", spec)
    expect(first).toMatchObject({ target_count: 2, before_count: 1, after_count: 2, inserted_count: 1, replayed: false })
    expect(tables.gp_suppression_preference[0]).toMatchObject({ reason: "earlier_unsubscribe", source: "preferences_page" })
    expect(tables.gp_suppression_preference[1]).toMatchObject({
      scope: "marketing", topic: null, reason: "constant_contact_unsubscribe", source: "constant_contact",
      metadata: { classification_sha256: spec.classificationSha256, target_sha256: spec.targetSha256 },
    })
    expect(tables.gp_customer_profile.every((row) => row.email_consent && row.email_consent_at)).toBe(true)
    expect(writes.every((write) => ["gp_import_run", "gp_suppression_preference"].includes(write.table))).toBe(true)
    const count = writes.length
    const replay = await protectC03UnsubscribedDestinations(db, emails, "staff_verified", spec)
    expect(replay).toMatchObject({ audit_run_id: first.audit_run_id, replayed: true, before_count: 1, after_count: 2 })
    expect(writes).toHaveLength(count)
  })

  it("rejects an unaudited actor and missing GP identity", async () => {
    const { db, tables, writes } = fakeDb()
    await expect(protectC03UnsubscribedDestinations(db, emails, "", spec)).rejects.toThrow(/Verified staff actor/)
    expect(writes).toHaveLength(0)
    tables.gp_customer_profile.pop()
    await expect(protectC03UnsubscribedDestinations(db, emails, "staff_verified", spec))
      .rejects.toThrow(/exactly one active GP profile/)
  })
})
