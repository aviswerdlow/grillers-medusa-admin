import {
  isHardPostmarkBounce,
  postmarkWebhookEventId,
  recordCommunicationEvent,
  updatePostmarkMessageState,
} from "../communications/core"

jest.mock("../communications/destinations", () => ({
  writeEventDestinations: jest.fn(async () => undefined),
}))
jest.mock("../communications/queue", () => ({
  enqueueCommunicationEvent: jest.fn(async () => true),
}))

function webhookDb() {
  const events: Record<string, any>[] = []
  const suppressions: Record<string, any>[] = []
  const updates: Record<string, any>[] = []
  const message: Record<string, any> = {
    id: "gpmsg_1",
    postmark_message_id: "pm-1",
    profile_id: "gpcprof_1",
    email: "controlled@example.test",
    status: "sent",
  }
  const profile = { id: "gpcprof_1", email: message.email }
  const db: any = (table: string) => {
    const predicates: Record<string, any> = {}
    const chain: any = {
      whereNull: () => chain,
      where: (key: string, value: any) => {
        predicates[key] = value
        return chain
      },
      whereRaw: () => chain,
      first: async () => {
        if (table === "gp_communication_event") {
          return events.find((event) => event.event_id === predicates.event_id) || null
        }
        if (table === "gp_message_log") {
          return predicates.postmark_message_id === message.postmark_message_id
            ? message
            : null
        }
        if (table === "gp_customer_profile") {
          return predicates.id === profile.id ? profile : null
        }
        if (table === "gp_suppression_preference") {
          return suppressions.find(
            (row) =>
              row.email_lower === predicates.email_lower &&
              row.scope === predicates.scope
          ) || null
        }
        throw new Error(`Unexpected first(${table})`)
      },
      update: async (patch: Record<string, any>) => {
        if (table !== "gp_message_log") {
          throw new Error(`Unexpected update(${table})`)
        }
        updates.push(patch)
        Object.assign(message, patch)
        return 1
      },
      insert: (row: Record<string, any>) => {
        if (table === "gp_suppression_preference") {
          suppressions.push(row)
          return Promise.resolve([row.id])
        }
        if (table === "gp_communication_event") {
          return {
            onConflict: () => ({
              ignore: () => ({
                returning: async () => {
                  if (events.some((event) => event.event_id === row.event_id)) {
                    return []
                  }
                  events.push(row)
                  return [{ id: row.id }]
                },
              }),
            }),
          }
        }
        throw new Error(`Unexpected insert(${table})`)
      },
    }
    return chain
  }
  db.raw = (sql: string) => sql
  return { db, events, message, suppressions, updates }
}

describe("Postmark webhook gates", () => {
  beforeEach(() => jest.clearAllMocks())

  it("uses the retry-stable trace ID and skips a replay before any side effect", async () => {
    const { db, events, suppressions, updates } = webhookDb()
    const payload = {
      RecordType: "Delivery",
      MessageID: "pm-1",
      Recipient: "controlled@example.test",
      ReceivedAt: "2026-09-24T12:00:00Z",
    }

    await updatePostmarkMessageState(db, payload, "trace-1")
    await updatePostmarkMessageState(db, { ...payload }, "trace-1")

    expect(events).toHaveLength(1)
    expect(events[0].event_id).toBe(postmarkWebhookEventId(payload, "trace-1"))
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe("delivered")
    expect(suppressions).toHaveLength(0)
  })

  it("classifies soft and transient bounces without hard suppression", async () => {
    expect(isHardPostmarkBounce({ TypeCode: 1, Type: "HardBounce" })).toBe(true)
    expect(isHardPostmarkBounce({ TypeCode: 100000, Type: "BadEmailAddress" })).toBe(true)
    expect(isHardPostmarkBounce({ TypeCode: 100002, Type: "ManuallyDeactivated" })).toBe(true)
    expect(isHardPostmarkBounce({ TypeCode: 4096, Type: "SoftBounce" })).toBe(false)
    expect(isHardPostmarkBounce({ TypeCode: 2, Type: "Transient" })).toBe(false)
    expect(isHardPostmarkBounce({ Type: "HardBounce" })).toBe(true)
    expect(isHardPostmarkBounce({ TypeCode: 4096, Type: "HardBounce" })).toBe(false)

    const soft = webhookDb()
    await updatePostmarkMessageState(
      soft.db,
      {
        RecordType: "Bounce",
        Type: "SoftBounce",
        TypeCode: 4096,
        MessageID: "pm-1",
        Email: "controlled@example.test",
      },
      "trace-soft"
    )
    expect(soft.message.status).toBe("sent")
    expect(soft.message.bounced_at).toBeInstanceOf(Date)
    expect(soft.suppressions).toHaveLength(0)
    expect(soft.events[0].properties.bounce_classification).toBe("non_hard")

    const hard = webhookDb()
    await updatePostmarkMessageState(
      hard.db,
      {
        RecordType: "Bounce",
        Type: "HardBounce",
        TypeCode: 1,
        MessageID: "pm-1",
        Email: "controlled@example.test",
      },
      "trace-hard"
    )
    expect(hard.message.status).toBe("bounced")
    expect(hard.suppressions).toHaveLength(1)
    expect(hard.suppressions[0].scope).toBe("hard_bounce")
    expect(hard.events[0].properties.bounce_classification).toBe("hard")
  })

  it.each([
    [100000, "BadEmailAddress"],
    [100002, "ManuallyDeactivated"],
  ])("suppresses permanent Postmark bounce %i (%s)", async (typeCode, type) => {
    const result = webhookDb()
    await updatePostmarkMessageState(result.db, {
      RecordType: "Bounce", TypeCode: typeCode, Type: type,
      MessageID: "pm-1", Email: "controlled@example.test",
    }, `trace-${typeCode}`)
    expect(result.message.status).toBe("bounced")
    expect(result.suppressions).toHaveLength(1)
    expect(result.suppressions[0].scope).toBe("hard_bounce")
    expect(result.events[0].properties.bounce_classification).toBe("hard")
  })

  it("uses a stable payload fallback when Postmark omits the trace header", () => {
    const first = { RecordType: "Delivery", MessageID: "pm-1", Metadata: { b: 2, a: 1 } }
    const reordered = { Metadata: { a: 1, b: 2 }, MessageID: "pm-1", RecordType: "Delivery" }
    expect(postmarkWebhookEventId(first)).toBe(postmarkWebhookEventId(reordered))
    expect(postmarkWebhookEventId(first, "trace-1")).not.toBe(
      postmarkWebhookEventId(first, "trace-2")
    )
  })

  it("returns the unique-index winner after a concurrent event-ID conflict", async () => {
    const winner = { id: "gpcevt_winner", event_id: "postmark-webhook:race" }
    let reads = 0
    const db: any = (table: string) => {
      if (table !== "gp_communication_event") {
        throw new Error(`Unexpected table ${table}`)
      }
      const chain: any = {
        whereNull: () => chain,
        where: () => chain,
        first: async () => (++reads === 1 ? null : winner),
        insert: () => ({
          onConflict: () => ({
            ignore: () => ({ returning: async () => [] }),
          }),
        }),
      }
      return chain
    }
    db.raw = (sql: string) => sql

    const result = await recordCommunicationEvent(db, {
      event_name: "email_delivered",
      event_id: winner.event_id,
    })

    expect(result).toBe(winner)
    expect(reads).toBe(2)
  })
})
