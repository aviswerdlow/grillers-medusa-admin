import {
  CC_EMAIL_CONSENT_SOURCE,
  CC_EMAIL_DECISION_REF,
  hasQualifyingEmailMarketingConsent,
} from "../communications/core"
import {
  constantContactSha256,
  importConstantContactRows,
  planConstantContactImport,
  type ConstantContactImportBatch,
  type ProtectedEligibility,
} from "../communications/imports"

const hash = (letter: string) => letter.repeat(64)

function batch(
  rows: Record<string, any>[],
  decisions: Array<Partial<ProtectedEligibility>>,
  batchId = "c04-reviewed-001"
): ConstantContactImportBatch {
  const eligibility = rows.map((row, index) => ({
    row_sha256: constantContactSha256(row),
    email: String(row.email || "").trim().toLowerCase() || null,
    email_eligible: false,
    exclusion_reason: "review_hold",
    ...decisions[index],
  })) as ProtectedEligibility[]
  return {
    batch_id: batchId,
    manifest_sha256: hash("a"),
    source_sha256: hash("b"),
    eligibility_sha256: constantContactSha256(eligibility),
    decision_ref: CC_EMAIL_DECISION_REF,
    rows,
    eligibility,
  }
}

function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    gp_import_run: [],
    gp_suppression_preference: [],
    gp_customer_profile: [],
    ...seed,
  }
  const writes: Array<{ table: string; op: string; data: any }> = []
  const db: any = (table: string) => {
    const predicates: Array<(row: any) => boolean> = []
    let insertData: any = null
    const matched = () => (tables[table] || []).filter((row) => predicates.every((p) => p(row)))
    const chain: any = {
      whereNull(name: string) {
        predicates.push((row) => row[name] == null)
        return chain
      },
      where(name: string | Record<string, unknown>, value?: unknown) {
        if (typeof name === "object") {
          for (const [key, expected] of Object.entries(name)) predicates.push((row) => row[key] === expected)
        } else predicates.push((row) => row[name] === value)
        return chain
      },
      whereIn(name: string, values: unknown[]) {
        predicates.push((row) => values.includes(row[name]))
        return chain
      },
      forUpdate() { return chain },
      first: async () => matched()[0],
      insert(data: any) { insertData = data; return chain },
      onConflict() { return chain },
      ignore() { return chain },
      async returning() { return applyInsert() },
      async update(data: any) {
        const rows = matched()
        for (const row of rows) {
          const patch = { ...data }
          if (patch.metadata?.__raw) {
            patch.metadata = { ...(row.metadata || {}), ...JSON.parse(patch.metadata.bindings[0]) }
          }
          Object.assign(row, patch)
          writes.push({ table, op: "update", data: patch })
        }
        return rows.length
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(applyInsert()).then(resolve, reject)
      },
    }
    function applyInsert() {
      if (!insertData) return []
      const candidate = insertData
      insertData = null
      const conflicts = table === "gp_import_run"
        ? tables[table].some((row) => row.source === candidate.source && row.batch_id === candidate.batch_id)
        : table === "gp_customer_profile"
          ? tables[table].some((row) => row.email_lower === candidate.email_lower)
          : table === "gp_suppression_preference"
            ? tables[table].some((row) => row.email_lower === candidate.email_lower && row.scope === candidate.scope && !row.resubscribed_at)
            : false
      if (conflicts) return []
      tables[table].push(candidate)
      writes.push({ table, op: "insert", data: candidate })
      return [{ id: candidate.id }]
    }
    return chain
  }
  db.raw = (sql: string, bindings: unknown[]) => ({ __raw: sql, bindings })
  db.transaction = async (fn: any) => fn(db)
  return { db, tables, writes }
}

describe("protected Constant Contact C04 import", () => {
  it("refuses status-inferred consent and mismatched protected evidence before writes", () => {
    const active = [{ email: "active@example.com", status: "Active" }]
    const held = batch(active, [{}])
    expect(planConstantContactImport(held).stats.eligible).toBe(0)
    const missing = { ...held, eligibility: [] }
    expect(() => planConstantContactImport(missing)).toThrow(/each source row/)
    const badHash = { ...held, eligibility: [{ ...held.eligibility[0], row_sha256: hash("f") }] }
    badHash.eligibility_sha256 = constantContactSha256(badHash.eligibility)
    expect(() => planConstantContactImport(badHash)).toThrow(/source row digest/)
    const badDecision = { ...held, decision_ref: "https://example.com/other" }
    expect(() => planConstantContactImport(badDecision)).toThrow(/approved email decision/)
  })

  it("vetoes pending, deleted, bounced, unsubscribed, duplicate and SMS decisions", () => {
    for (const status of ["Pending", "Deleted", "Bounced", "Unsubscribed"]) {
      const value = batch([{ email: "shopper@example.com", status }], [{ email_eligible: true, exclusion_reason: undefined }])
      expect(() => planConstantContactImport(value)).toThrow(/source veto/)
    }
    const duplicate = batch(
      [{ email: "shopper@example.com", status: "Active" }, { email: "SHOPPER@example.com", status: "Active" }],
      [{ email_eligible: true, exclusion_reason: undefined }, { email_eligible: true, exclusion_reason: undefined }]
    )
    expect(() => planConstantContactImport(duplicate)).toThrow(/duplicate eligible/)
    const sms = batch([{ email: "shopper@example.com", sms_channel: "opted_in" }], [{ email_eligible: true, exclusion_reason: undefined, sms_eligible: true } as any])
    expect(() => planConstantContactImport(sms)).toThrow(/SMS requires separate/)
  })

  it("writes suppressions before policy consent, preserves stronger GP state, and never creates SMS consent or flow events", async () => {
    const rows = [
      { email: "new@example.com", status: "Active", phone: "2125550100" },
      { email: "unsub@example.com", status: "Unsubscribed" },
      { email: "strong@example.com", status: "Confirmed" },
      { email: "postmark@example.com", status: "Active" },
    ]
    const input = batch(rows, [
      { email_eligible: true, exclusion_reason: undefined },
      { exclusion_reason: "cc_unsubscribed" },
      { email_eligible: true, exclusion_reason: undefined },
      { exclusion_reason: "postmark_suppression", suppression: { scope: "marketing", reason: "postmark_unsubscribe", source: "postmark" } },
    ])
    const priorAt = new Date("2026-01-01T00:00:00Z")
    const { db, tables, writes } = fakeDb({
      gp_customer_profile: [{
        id: "profile_strong", email: "strong@example.com", email_lower: "strong@example.com",
        email_consent: true, email_consent_at: priorAt, metadata: { consent_source: "site_signup" },
        preferences: { promotions: false },
      }],
      gp_suppression_preference: [{
        id: "prior_supp", email: "unsub@example.com", email_lower: "unsub@example.com",
        scope: "marketing", reason: "customer_unsubscribe", source: "preferences_page",
        unsubscribed_at: priorAt, resubscribed_at: null,
      }],
    })
    const result = await importConstantContactRows(db, input)
    expect(result.status).toBe("completed")
    expect(result.stats).toMatchObject({ total: 4, eligible: 2, excluded: 2, imported: 1, preserved: 1 })
    const consentIndex = writes.findIndex((write) => write.table === "gp_customer_profile" && write.op === "update" && write.data.email_consent === true)
    const suppressionIndex = writes.findIndex((write) => write.table === "gp_suppression_preference" && write.op === "insert")
    expect(suppressionIndex).toBeGreaterThanOrEqual(0)
    expect(suppressionIndex).toBeLessThan(consentIndex)
    const fresh = tables.gp_customer_profile.find((row) => row.email_lower === "new@example.com")
    expect(fresh).toMatchObject({ email_consent: true, email_consent_at: null, sms_consent: false })
    expect(fresh.metadata).toMatchObject({ consent_source: CC_EMAIL_CONSENT_SOURCE, consent_decision_ref: CC_EMAIL_DECISION_REF })
    expect(tables.gp_customer_profile.find((row) => row.id === "profile_strong")).toMatchObject({
      email_consent_at: priorAt, metadata: { consent_source: "site_signup" }, preferences: { promotions: false },
    })
    expect(tables.gp_suppression_preference.find((row) => row.id === "prior_supp")).toMatchObject({
      reason: "customer_unsubscribe", unsubscribed_at: priorAt,
    })
    expect(writes.some((write) => write.table === "gp_communication_event" || write.table === "gp_flow_enrollment")).toBe(false)
    expect(JSON.stringify(tables.gp_import_run[0].metadata)).not.toContain("new@example.com")
  })

  it("replays the same batch without writes and rejects changed content under its identity", async () => {
    const input = batch([{ email: "new@example.com", status: "Active" }], [{ email_eligible: true, exclusion_reason: undefined }])
    const { db, writes } = fakeDb()
    const first = await importConstantContactRows(db, input)
    const writeCount = writes.length
    const replay = await importConstantContactRows(db, input)
    expect(replay).toMatchObject({ import_run_id: first.import_run_id, replayed: true })
    expect(writes).toHaveLength(writeCount)
    const changed = batch([{ email: "different@example.com", status: "Active" }], [{ email_eligible: true, exclusion_reason: undefined }])
    await expect(importConstantContactRows(db, changed)).rejects.toThrow(/different protected input/)
  })

  it("vetoes a newer active GP suppression even when the frozen eligibility allowed email", async () => {
    const input = batch([{ email: "new@example.com", status: "Active" }], [{ email_eligible: true, exclusion_reason: undefined }])
    const priorAt = new Date("2026-09-25T12:00:00Z")
    const { db, tables } = fakeDb({
      gp_suppression_preference: [{
        id: "later_unsubscribe", email_lower: "new@example.com", scope: "marketing",
        reason: "customer_unsubscribe", unsubscribed_at: priorAt, resubscribed_at: null,
      }],
    })
    const result = await importConstantContactRows(db, input)
    expect(result.stats).toMatchObject({ eligible: 1, imported: 0, suppressed: 1 })
    expect(tables.gp_customer_profile[0]).toMatchObject({ email_consent: false, email_consent_at: null })
    expect(tables.gp_suppression_preference[0]).toMatchObject({ reason: "customer_unsubscribe", unsubscribed_at: priorAt })
  })

  it("requires protected suppression evidence for a cross-source veto", () => {
    const input = batch([{ email: "hold@example.com", status: "Active" }], [{ exclusion_reason: "postmark_suppression" }])
    expect(() => planConstantContactImport(input)).toThrow(/protected suppression evidence/)
  })

  it("holds policy grants behind the email send gate without inventing opt-in time", () => {
    const profile = {
      email: "new@example.com", email_consent: true, email_consent_at: null,
      metadata: {
        consent_source: CC_EMAIL_CONSENT_SOURCE,
        consent_decision_ref: CC_EMAIL_DECISION_REF,
        consent_batch_id: "c04-reviewed-001",
        consent_manifest_sha256: hash("a"),
      },
    }
    expect(hasQualifyingEmailMarketingConsent(profile, "new@example.com")).toBe(true)
    expect(hasQualifyingEmailMarketingConsent(profile, "other@example.com")).toBe(false)
    expect(hasQualifyingEmailMarketingConsent({ ...profile, metadata: {} }, "new@example.com")).toBe(false)
    expect(hasQualifyingEmailMarketingConsent({ ...profile, email_consent: false }, "new@example.com")).toBe(false)
  })
})
