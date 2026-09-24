import { sendTrackedEmail } from "../communications/core"
import { emitOpsAlert } from "../ops-alert"
import {
  buildLocalMilestoneEmail, localNoticePolicy, localOrderSmsPermission,
  type LocalNoticePolicy,
} from "../local-milestone-notice-policy"
import { alertOfficeException, claimLocalNotice, sendEmailNotice } from "../local-milestone-notices"

jest.mock("../communications/core", () => ({ sendTrackedEmail: jest.fn() }))
jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true })) }))

const sender = sendTrackedEmail as jest.MockedFunction<typeof sendTrackedEmail>
const alert = emitOpsAlert as jest.MockedFunction<typeof emitOpsAlert>
const policy: LocalNoticePolicy = { version: "issue-359-approved-fixture", approvedAt: "2026-09-24T00:00:00Z",
  startAt: "2026-09-24T00:01:00Z", email: ["pickup_ready", "local_dispatched", "local_delivered"], sms: [] }

function dbFixture() {
  const rows: Record<string, any>[] = []
  const db: any = (table: string) => {
    expect(table).toBe("gp_local_milestone_notice")
    let match: Record<string, any> = {}
    return {
      where(input: Record<string, any>) { match = { ...match, ...input }; return this },
      async first() { return rows.find(row => Object.entries(match).every(([key, value]) => row[key] === value)) },
      async insert(input: Record<string, any>) { rows.push({ ...input }) },
      async update(input: Record<string, any>) {
        const row = rows.find(row => Object.entries(match).every(([key, value]) => row[key] === value))
        if (row) Object.assign(row, input)
      },
    }
  }
  db.raw = jest.fn(async () => undefined)
  db.transaction = async (run: (trx: any) => Promise<any>) => run(db)
  return { db, rows }
}

const event = { event_id: "evt_fixture_18", order_id: "order_fixture", milestone: "pickup_ready",
  kind: "record", recorded_at: new Date("2026-09-24T10:00:00Z"), display_id: 367,
  email: "original@example.com", customer_id: "cus_123", metadata: {} }

describe("#367 local notice policy and claim", () => {
  beforeEach(() => { jest.clearAllMocks() })

  it("F367-16 holds sends until an explicit #359 policy starts and uses accepted-order email", async () => {
    const priorFlag = process.env.GP_LOCAL_MILESTONES_ENABLED
    try {
      delete process.env.GP_LOCAL_MILESTONES_ENABLED
      expect(localNoticePolicy(JSON.stringify({ version: policy.version }))).toBeNull()
      process.env.GP_LOCAL_MILESTONES_ENABLED = "true"
      expect(localNoticePolicy()).toBeNull()
      expect(() => localNoticePolicy(JSON.stringify({ version: "unapproved", approved_at: policy.approvedAt,
        start_at: policy.startAt, email: ["pickup_ready"], sms: [] }))).toThrow("invalid_local_notice_policy")
    } finally {
      if (priorFlag === undefined) delete process.env.GP_LOCAL_MILESTONES_ENABLED
      else process.env.GP_LOCAL_MILESTONES_ENABLED = priorFlag
    }
    sender.mockResolvedValueOnce({ ok: true, messageId: "pm_accepted" })
    const { db } = dbFixture()
    await sendEmailNotice({} as any, db, event, policy)
    expect(sender).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: "original@example.com" }))
    const content = buildLocalMilestoneEmail({ milestone: "pickup_ready", orderId: event.order_id, displayId: 367, correction: false })
    expect(content.subject).toContain("#367")
  })

  it("F367-09 and F367-18 keep one event/destination claim when a provider result is uncertain", async () => {
    const { db, rows } = dbFixture()
    sender.mockResolvedValueOnce({ ok: false, error: "provider_outcome_uncertain" })
    expect(await sendEmailNotice({} as any, db, event, policy)).toBe("needs_reconciliation")
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("needs_reconciliation")
    expect(await sendEmailNotice({} as any, db, event, policy)).toBe("duplicate")
    expect(sender).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ alertKind: "local_milestone_notice_reconciliation" }))
    const differentDestination = await claimLocalNotice(db, { eventId: event.event_id,
      orderId: event.order_id, channel: "email", destination: "other@example.com" })
    expect(differentDestination.claimed).toBe(true)
  })

  it("defers an email under the existing observance result and reclaims it only after the window", async () => {
    const { db, rows } = dbFixture()
    const deferUntil = new Date("2026-09-25T00:00:00Z")
    sender.mockResolvedValueOnce({ ok: false, deferred: true, deferUntil, error: "shabbat_blackout" })
    expect(await sendEmailNotice({} as any, db, event, policy)).toBe("deferred")
    expect(rows[0].status).toBe("deferred")
    expect((await claimLocalNotice(db, { eventId: event.event_id, orderId: event.order_id,
      channel: "email", destination: event.email, now: new Date("2026-09-24T23:59:59Z") })).claimed).toBe(false)
    expect((await claimLocalNotice(db, { eventId: event.event_id, orderId: event.order_id,
      channel: "email", destination: event.email, now: deferUntil })).claimed).toBe(true)
  })

  it("F367-17 suppresses local SMS despite UPS order-text consent", () => {
    expect(localOrderSmsPermission({ order_sms_consent: { granted: true,
      version: "transactional-sms-v2-2026-07-11", phone: "+14045550100" } }))
      .toEqual({ allowed: false, reason: "ups_only_order_sms_consent" })
    expect(localOrderSmsPermission({})).toEqual({ allowed: false, reason: "missing_order_sms_consent" })
  })

  it("F367-06 and F367-20 alert the office once for a failed or corrected event", async () => {
    const { db, rows } = dbFixture()
    const failure = { ...event, event_id: "evt_failure_06", milestone: "local_failed" }
    expect(await alertOfficeException(db, failure)).toBe("alerted")
    expect(await alertOfficeException(db, failure)).toBe("duplicate")
    expect(rows).toHaveLength(1)
    expect(alert).toHaveBeenCalledTimes(1)
  })
})
