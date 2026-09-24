import { sendTrackedEmail } from "../communications/core"

jest.mock("../communications/hebrew-calendar", () => ({
  isInSendBlackout: jest.fn(() => ({ blocked: false })),
  nextAllowedSendTime: jest.fn(() => new Date("2026-07-08T12:00:00Z")),
}))

jest.mock("../communications/destinations", () => ({
  writeEventDestinations: jest.fn(async () => undefined),
}))

jest.mock("../ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

const { isInSendBlackout } = jest.requireMock(
  "../communications/hebrew-calendar"
)

/**
 * Minimal chainable fake knex. Reads resolve from `state` per table;
 * writes are recorded in `writes`. `.count()` resolves the countRows
 * configured for the table.
 */
function fakeDb() {
  const state: Record<string, any[]> = {}
  const countRows: Record<string, any[]> = {}
  const writes: Array<{ table: string; op: string; data?: any }> = []

  const db: any = (table: string) => {
    const chain: any = {
      _table: table,
      _isCount: false,
      _op: null as string | null,
      _data: undefined as any,
    }
    const self = (ret?: any) => chain
    for (const method of [
      "whereNull",
      "whereNotNull",
      "where",
      "whereIn",
      "whereRaw",
      "andWhere",
      "orWhere",
      "select",
      "groupBy",
      "orderBy",
      "limit",
      "onConflict",
      "ignore",
      "returning",
    ]) {
      chain[method] = self
    }
    chain.count = () => {
      chain._isCount = true
      return chain
    }
    chain.first = async () => (state[table] || [])[0]
    chain.insert = (data: any) => {
      chain._op = "insert"
      chain._data = data
      writes.push({ table, op: "insert", data })
      return chain
    }
    chain.update = (data: any) => {
      chain._op = "update"
      chain._data = data
      writes.push({ table, op: "update", data })
      return chain
    }
    chain.then = (resolve: any, reject: any) => {
      const value = chain._op
        ? []
        : chain._isCount
        ? countRows[table] || [{ count: 0 }]
        : state[table] || []
      return Promise.resolve(value).then(resolve, reject)
    }
    return chain
  }
  db.raw = (sql: string) => ({ __raw: sql })
  return { db, state, countRows, writes }
}

function fakeContainer(db: any, notification: any) {
  return {
    resolve: (key: string) => {
      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }
      if (
        key === "notification" ||
        key === "Notification" ||
        key === "notificationModuleService"
      ) {
        return notification
      }
      // PG_CONNECTION and anything else
      if (String(key).toLowerCase().includes("notification"))
        return notification
      return db
    },
  } as any
}

function consentedProfile(overrides: Record<string, any> = {}) {
  return {
    id: "gpcprof_test",
    email: "operator@grillerspride.com",
    email_lower: "operator@grillerspride.com",
    email_consent: false,
    email_consent_at: null,
    preferences: null,
    ...overrides,
  }
}

function baseInput(overrides: Record<string, any> = {}) {
  return {
    to: "operator@grillerspride.com",
    subject: "Test subject",
    html: "<p>Hi</p>",
    stream: "broadcast" as const,
    purpose: "broadcast" as const,
    template_key: "gp-e2e-canvas-check",
    topic: "promotions",
    idempotency_key: `test:${Math.floor(Math.random() * 1e9)}`,
    ...overrides,
  }
}

describe("sendTrackedEmail gates", () => {
  let notification: { createNotifications: jest.Mock }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(isInSendBlackout as jest.Mock).mockReturnValue({ blocked: false })
    notification = {
      createNotifications: jest.fn(async () => [
        {
          id: "noti_fixture",
          provider_id: "postmark",
          external_id: "pm_msg_1",
          status: "success",
        },
      ]),
    }
  })

  it("suppresses a broadcast to a non-consented profile", async () => {
    const { db, state, writes } = fakeDb()
    state.gp_customer_profile = [consentedProfile({ email_consent: false })]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(container, baseInput())

    expect(result).toEqual({ ok: true, skipped: true })
    expect(notification.createNotifications).not.toHaveBeenCalled()
    const eventInsert = writes.find(
      (w) => w.table === "gp_communication_event" && w.op === "insert"
    )
    expect(eventInsert?.data?.event_name).toBe("email_suppressed")
    expect(eventInsert?.data?.properties?.reason).toBe(
      "missing_marketing_consent"
    )
    // Nothing written to the message log for a suppressed send.
    expect(writes.find((w) => w.table === "gp_message_log")).toBeUndefined()
  })

  it("staff_test bypasses the consent gate and sends", async () => {
    const { db, state, writes } = fakeDb()
    state.gp_customer_profile = [consentedProfile({ email_consent: false })]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({ staff_test: true })
    )

    expect(result.ok).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(notification.createNotifications).toHaveBeenCalledTimes(1)
    const logInsert = writes.find(
      (w) => w.table === "gp_message_log" && w.op === "insert"
    )
    expect(logInsert?.data?.status).toBe("queued")
    expect(logInsert?.data?.channel).toBe("email")
  })

  it("frequency cap suppresses the 4th weekly marketing email", async () => {
    const { db, state, countRows, writes } = fakeDb()
    state.gp_customer_profile = [
      consentedProfile({
        email_consent: true,
        email_consent_at: new Date("2026-01-01"),
      }),
    ]
    countRows.gp_message_log = [{ count: 3 }]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(container, baseInput())

    expect(result).toEqual({ ok: true, skipped: true })
    expect(notification.createNotifications).not.toHaveBeenCalled()
    const eventInsert = writes.find(
      (w) => w.table === "gp_communication_event" && w.op === "insert"
    )
    expect(eventInsert?.data?.properties?.reason).toBe("frequency_cap")
  })

  it("staff_test bypasses the frequency cap", async () => {
    const { db, state, countRows } = fakeDb()
    state.gp_customer_profile = [
      consentedProfile({
        email_consent: true,
        email_consent_at: new Date("2026-01-01"),
      }),
    ]
    countRows.gp_message_log = [{ count: 99 }]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({ staff_test: true })
    )

    expect(result.ok).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(notification.createNotifications).toHaveBeenCalledTimes(1)
  })

  it("staff_test still honors the suppression list", async () => {
    const { db, state } = fakeDb()
    state.gp_customer_profile = [consentedProfile({ email_consent: false })]
    // hasSuppression reads gp_suppression_preference rows for the email.
    state.gp_suppression_preference = [
      {
        id: "gpsup_1",
        email_lower: "operator@grillerspride.com",
        scope: "marketing",
        topic: null,
        reason: "unsubscribe",
        resubscribed_at: null,
      },
    ]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({ staff_test: true })
    )

    expect(result).toEqual({ ok: true, skipped: true })
    expect(notification.createNotifications).not.toHaveBeenCalled()
  })

  it("frequency cap applies to marketing_1to1 riding the transactional stream", async () => {
    // Cart-recovery flows use the transactional Postmark stream for inbox
    // placement but are still marketing — stream is a deliverability
    // choice, not a semantic classification. The cap must apply.
    const { db, state, countRows } = fakeDb()
    state.gp_customer_profile = [
      consentedProfile({
        email_consent: true,
        email_consent_at: new Date("2026-01-01"),
      }),
    ]
    countRows.gp_message_log = [{ count: 3 }]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({
        stream: "transactional",
        purpose: "marketing_1to1",
        template_key: "cart-abandoned-1",
      })
    )

    expect(result).toEqual({ ok: true, skipped: true })
    expect(notification.createNotifications).not.toHaveBeenCalled()
  })

  it("blackout applies to marketing_1to1 riding the transactional stream", async () => {
    ;(isInSendBlackout as jest.Mock).mockReturnValue({
      blocked: true,
      reason: "shabbat",
      until: new Date("2026-07-11T02:00:00Z"),
    })
    const { db, state } = fakeDb()
    state.gp_customer_profile = [
      consentedProfile({
        email_consent: true,
        email_consent_at: new Date("2026-01-01"),
      }),
    ]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({ stream: "transactional", purpose: "marketing_1to1" })
    )

    expect(result.deferred).toBe(true)
    expect(notification.createNotifications).not.toHaveBeenCalled()
  })

  it("plain transactional receipts stay exempt from cap and blackout", async () => {
    ;(isInSendBlackout as jest.Mock).mockReturnValue({
      blocked: true,
      reason: "shabbat",
      until: new Date("2026-07-11T02:00:00Z"),
    })
    const { db, state, countRows } = fakeDb()
    state.gp_customer_profile = [consentedProfile({ email_consent: false })]
    countRows.gp_message_log = [{ count: 99 }]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({
        stream: "transactional",
        purpose: "transactional",
        template_key: "order-placed",
      })
    )

    expect(result.ok).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(notification.createNotifications).toHaveBeenCalledTimes(1)
  })

  it("staff_test still defers during the send blackout", async () => {
    ;(isInSendBlackout as jest.Mock).mockReturnValue({
      blocked: true,
      reason: "shabbat",
      until: new Date("2026-07-11T02:00:00Z"),
    })
    const { db, state } = fakeDb()
    state.gp_customer_profile = [consentedProfile({ email_consent: false })]
    const container = fakeContainer(db, notification)

    const result = await sendTrackedEmail(
      container,
      baseInput({ staff_test: true })
    )

    expect(result.ok).toBe(false)
    expect(result.deferred).toBe(true)
    expect(notification.createNotifications).not.toHaveBeenCalled()
  })

  it("records Postmark's external receipt rather than the provider or internal notification ID", async () => {
    const { db, state, writes } = fakeDb()
    state.gp_customer_profile = [consentedProfile()]
    const result = await sendTrackedEmail(
      fakeContainer(db, notification),
      baseInput({
        stream: "transactional",
        purpose: "service",
        template_key: "account-service",
      })
    )
    expect(result).toEqual({ ok: true, messageId: "pm_msg_1" })
    expect(
      writes.find((w) => w.table === "gp_message_log" && w.op === "update")
        ?.data
    ).toMatchObject({ status: "sent", postmark_message_id: "pm_msg_1" })
  })

  it("keeps a successful notification without an external receipt unconfirmed", async () => {
    const { db, state, writes } = fakeDb()
    state.gp_customer_profile = [consentedProfile()]
    notification.createNotifications.mockResolvedValue([
      { id: "noti_internal", provider_id: "postmark", status: "success" },
    ])
    const result = await sendTrackedEmail(
      fakeContainer(db, notification),
      baseInput({
        stream: "transactional",
        purpose: "service",
        template_key: "account-service",
      })
    )
    expect(result).toEqual({
      ok: false,
      error: "notification_provider_receipt_unconfirmed",
    })
    expect(
      writes.find((w) => w.table === "gp_message_log" && w.op === "update")
        ?.data
    ).toMatchObject({
      status: "queued",
      error_message: "notification_provider_receipt_unconfirmed",
    })
    expect(
      writes.filter(
        (w) =>
          w.table === "gp_communication_event" &&
          w.data?.event_name === "email_sent"
      )
    ).toHaveLength(0)
  })

  it("neither resends nor confirms an existing queued notification", async () => {
    const { db, state, writes } = fakeDb()
    state.gp_customer_profile = [consentedProfile()]
    state.gp_message_log = [
      { id: "queued_log", status: "queued", postmark_message_id: null },
    ]
    const result = await sendTrackedEmail(
      fakeContainer(db, notification),
      baseInput({
        stream: "transactional",
        purpose: "service",
        template_key: "account-service",
      })
    )
    expect(result).toEqual({
      ok: false,
      error: "notification_provider_receipt_unconfirmed",
    })
    expect(notification.createNotifications).not.toHaveBeenCalled()
    expect(
      writes.filter(
        (w) =>
          w.table === "gp_communication_event" &&
          w.data?.event_name === "email_sent"
      )
    ).toHaveLength(0)
  })

  it("holds an uncertain prior decline notice for provider reconciliation", async () => {
    const { db, state } = fakeDb()
    state.gp_customer_profile = [consentedProfile()]
    state.gp_message_log = [{ id: "prior_decline", status: "failed", postmark_message_id: null }]
    const result = await sendTrackedEmail(
      fakeContainer(db, notification),
      baseInput({
        stream: "transactional",
        purpose: "transactional",
        template_key: "order-final-charge-declined",
      })
    )
    expect(result).toEqual({ ok: false, error: "final_charge_decline_provider_reconciliation_required" })
    expect(notification.createNotifications).not.toHaveBeenCalled()
  })

  it("deduplicates a decline notice with a confirmed Postmark receipt", async () => {
    const { db, state } = fakeDb()
    state.gp_customer_profile = [consentedProfile()]
    state.gp_message_log = [{
      id: "sent_decline", status: "sent", postmark_message_id: "pm_original",
      provider_response: { status: "success", external_id: "pm_original" },
    }]
    const result = await sendTrackedEmail(
      fakeContainer(db, notification),
      baseInput({
        stream: "transactional",
        purpose: "transactional",
        template_key: "order-final-charge-declined",
      })
    )
    expect(result).toEqual({ ok: true, skipped: true, messageId: "pm_original" })
    expect(notification.createNotifications).not.toHaveBeenCalled()
  })
})
