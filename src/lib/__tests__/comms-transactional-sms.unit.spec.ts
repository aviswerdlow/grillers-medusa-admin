import crypto from "crypto"
import {
  ORDER_SMS_CONSENT_DISCLOSURE,
  ORDER_SMS_CONSENT_METHOD,
  ORDER_SMS_CONSENT_PROVIDER,
  ORDER_SMS_CONSENT_PURPOSE,
  ORDER_SMS_CONSENT_SOURCE,
  ORDER_SMS_CONSENT_VERSION,
  ORDER_SMS_PROGRAM,
  ORDER_SMS_TEMPLATE_ENROLLMENT_CONFIRMATION,
  ORDER_SMS_TEMPLATE_SHIPPED,
  applyTransactionalSmsKeyword,
  applyTransactionalSmsStatus,
  buildOrderSmsEnrollmentConfirmation,
  buildOrderShippedSms,
  classifyTransactionalInboundSms,
  orderShippedSmsFulfillmentEligibility,
  sanitizeOrderSmsConsentMetadata,
  resumeBlackoutDeferredOrderSms,
  sendOrderSmsEnrollmentConfirmation,
  sendOrderShippedSms,
  transactionalSmsConfigured,
  transactionalSmsStatusWebhookUrlForMessage,
  validateTransactionalTwilioWebhookTarget,
  validateOrderDeliverySmsContent,
  validateOrderSmsConsent,
  verifyTransactionalTwilioSignature,
} from "../communications/transactional-sms"

jest.mock("../communications/destinations", () => ({
  writeEventDestinations: jest.fn(async () => undefined),
}))

jest.mock("../communications/queue", () => ({
  enqueueCommunicationEvent: jest.fn(async () => true),
}))

jest.mock("../communications/hebrew-calendar", () => ({
  isInSendBlackout: jest.fn(() => ({ blocked: false })),
  nextAllowedSendTime: jest.fn(() => new Date("2026-07-12T02:00:00Z")),
}))

jest.mock("../emails/order-fetch", () => ({
  fetchOrderForEmail: jest.fn(),
}))

const { isInSendBlackout } = jest.requireMock("../communications/hebrew-calendar")
const { fetchOrderForEmail } = jest.requireMock("../emails/order-fetch")

function orderSmsConsent(overrides: Record<string, any> = {}) {
  return {
    granted: true,
    phone: "+14045550100",
    timestamp: "2026-07-11T01:00:00.000Z",
    version: ORDER_SMS_CONSENT_VERSION,
    disclosure: ORDER_SMS_CONSENT_DISCLOSURE,
    source: ORDER_SMS_CONSENT_SOURCE,
    provider: ORDER_SMS_CONSENT_PROVIDER,
    program: ORDER_SMS_PROGRAM,
    purpose: ORDER_SMS_CONSENT_PURPOSE,
    method: ORDER_SMS_CONSENT_METHOD,
    ...overrides,
  }
}

function fakeDb(options: {
  count?: number
  messageRow?: Record<string, any> | null
  orderRows?: Record<string, any>[]
  suppressionRow?: Record<string, any> | null
} = {}) {
  let messageRow = options.messageRow || null
  let suppressionRow = options.suppressionRow || null
  let customerProfile: Record<string, any> | null = null
  const writes: Array<{ table: string; op: string; data: any }> = []
  const raws: string[] = []

  const db: any = (table: string) => {
    const chain: any = {
      _count: false,
      _select: false,
      _filters: [] as Array<[string, any]>,
    }
    for (const method of [
      "whereNull",
      "whereNot",
      "whereIn",
      "orderBy",
      "limit",
      "onConflict",
      "ignore",
    ]) {
      chain[method] = (..._args: any[]) => chain
    }
    chain.where = (key: string, ...rest: any[]) => {
      chain._filters.push([key, rest.at(-1)])
      return chain
    }
    chain.whereRaw = (sql: string) => {
      raws.push(sql)
      return chain
    }
    chain.first = async () => {
      if (table === "gp_sms_program_suppression") return suppressionRow
      if (table === "gp_message_log") return messageRow
      if (table === "gp_customer_profile") return customerProfile
      return undefined
    }
    chain.count = () => {
      chain._count = true
      return chain
    }
    chain.select = () => {
      chain._select = true
      return chain
    }
    chain.insert = (data: any) => {
      writes.push({ table, op: "insert", data })
      if (table === "gp_message_log") messageRow = { ...data }
      if (table === "gp_sms_program_suppression") {
        suppressionRow = { ...data }
      }
      if (table === "gp_customer_profile") customerProfile = { ...data }
      return chain
    }
    chain.update = (data: any) => {
      writes.push({ table, op: "update", data })
      if (table === "gp_message_log" && messageRow) {
        messageRow = { ...messageRow, ...data }
      }
      if (table === "gp_sms_program_suppression" && suppressionRow) {
        suppressionRow = { ...suppressionRow, ...data }
      }
      if (table === "gp_customer_profile" && customerProfile) {
        customerProfile = { ...customerProfile, ...data }
      }
      return chain
    }
    chain.then = (resolve: (value: any) => void) =>
      Promise.resolve(
        chain._count
          ? [{ count: options.count || 0 }]
          : chain._select && table === "order"
            ? options.orderRows || []
            : table === "gp_message_log" &&
                chain._filters.some(
                  ([key, value]: [string, any]) =>
                    key === "status" && value === "deferred"
                ) &&
                messageRow?.status === "deferred"
              ? [messageRow]
            : []
      ).then(resolve)
    return chain
  }
  db.raw = (sql: string) => {
    raws.push(sql)
    return sql
  }
  db.transaction = async (callback: (trx: any) => Promise<any>) => callback(db)
  return {
    db,
    raws,
    writes,
    get messageRow() {
      return messageRow
    },
    get suppressionRow() {
      return suppressionRow
    },
  }
}

describe("order-scoped transactional SMS consent", () => {
  const now = new Date("2026-07-11T13:00:00.000Z")

  it("requires the exact versioned disclosure and normalizes the phone", () => {
    const result = validateOrderSmsConsent(
      orderSmsConsent({ phone: "(404) 555-0100" }),
      { now }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.consent.phone).toBe("+14045550100")

    expect(
      validateOrderSmsConsent(
        orderSmsConsent({ disclosure: "Send me order updates." }),
        { now }
      )
    ).toEqual({ ok: false, reason: "disclosure_mismatch" })
    expect(
      validateOrderSmsConsent(orderSmsConsent({ granted: false }), { now })
    ).toEqual({ ok: false, reason: "not_granted" })
  })

  it("sanitizes a fresh customer snapshot and strips extras", () => {
    const metadata = sanitizeOrderSmsConsentMetadata(
      {
        keep_me: true,
        order_sms_consent: orderSmsConsent({ injected: "ignored" }),
      },
      { now }
    )
    expect(metadata.keep_me).toBe(true)
    expect(metadata.order_sms_consent).toEqual(orderSmsConsent())
    expect(metadata.order_sms_consent.injected).toBeUndefined()
  })

  it("fails closed for stale, malformed, or staff-created snapshots", () => {
    expect(
      sanitizeOrderSmsConsentMetadata(
        { order_sms_consent: orderSmsConsent() },
        { now: new Date("2026-07-20T13:00:00.000Z") }
      ).order_sms_consent
    ).toBeUndefined()
    expect(
      sanitizeOrderSmsConsentMetadata(
        {
          staff_phone_order: true,
          order_sms_consent: orderSmsConsent(),
        },
        { now }
      ).order_sms_consent
    ).toBeUndefined()
    expect(
      sanitizeOrderSmsConsentMetadata(
        {
          source: "staff_impersonation",
          order_sms_consent: orderSmsConsent(),
        },
        { now }
      ).order_sms_consent
    ).toBeUndefined()
  })
})

describe("delivery-only transactional SMS policy", () => {
  it("builds the required recurring-program enrollment confirmation", () => {
    const body = buildOrderSmsEnrollmentConfirmation()
    expect(body).toBe(
      "Griller's Pride Order Updates: Enrolled for recurring automated UPS shipping/tracking texts (up to 6/order). Msg & data rates may apply. Reply STOP to opt out or HELP for help."
    )
    expect(validateOrderDeliverySmsContent(body)).toBeNull()
  })

  it("builds branded shipment copy with STOP and no promotional language", () => {
    const body = buildOrderShippedSms({
      displayId: 114391,
      trackingNumber: "1Z 123-ABC",
    })
    expect(body).toContain("Griller's Pride")
    expect(body).toContain("has shipped")
    expect(body).toContain("Reply STOP")
    expect(body).toContain("1Z 123-ABC")
    expect(validateOrderDeliverySmsContent(body)).toBeNull()
  })

  it("rejects promotional content even if it mentions an order", () => {
    expect(
      validateOrderDeliverySmsContent(
        "Griller's Pride: your order shipped. Special offer inside. Reply STOP."
      )
    ).toBe("sms_marketing_content_not_allowed")
  })

  it("has program-specific STOP, START, and HELP copy", () => {
    expect(classifyTransactionalInboundSms("STOP").action).toBe("stop")
    expect(classifyTransactionalInboundSms("START").action).toBe("start")
    expect(classifyTransactionalInboundSms("UNSTOP").action).toBe("start")
    expect(classifyTransactionalInboundSms("YES").action).toBe("none")
    expect(classifyTransactionalInboundSms("REVOKE").action).toBe("stop")
    expect(classifyTransactionalInboundSms("OPTOUT").action).toBe("stop")
    expect(classifyTransactionalInboundSms("HALT").action).toBe("stop")
    const help = classifyTransactionalInboundSms("HELP")
    expect(help.action).toBe("help")
    expect(classifyTransactionalInboundSms("SUPPORT").action).toBe("help")
    expect(help.reply).toBe(
      "Griller's Pride Order Updates: UPS shipping/tracking help at (770) 454-8108 or peter@grillerspride.com. Up to 6 msgs/order. Msg & data rates may apply. Reply STOP to unsubscribe."
    )
  })

  it("allows only UPS shipping for the has-shipped template", () => {
    expect(
      orderShippedSmsFulfillmentEligibility({
        metadata: { fulfillmentType: "ups_shipping" },
      })
    ).toEqual({ eligible: true, fulfillmentType: "ups_shipping" })
    expect(
      orderShippedSmsFulfillmentEligibility({
        metadata: { fulfillmentType: "plant_pickup" },
      })
    ).toEqual({ eligible: false, reason: "plant_pickup_not_shipped" })
    for (const fulfillmentType of [
      "atlanta_delivery",
      "southeast_pickup",
      "unknown",
    ]) {
      expect(
        orderShippedSmsFulfillmentEligibility({
          metadata: { fulfillmentType },
        })
      ).toEqual({
        eligible: false,
        reason: "fulfillment_mode_not_shippable",
      })
    }
  })
})

describe("transactional Twilio transport", () => {
  const savedEnv = { ...process.env }
  const savedFetch = global.fetch

  afterEach(() => {
    process.env = { ...savedEnv }
    global.fetch = savedFetch
    jest.restoreAllMocks()
  })

  it("defers order SMS during blackout when the new policy is enabled", async () => {
    process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED = "true"
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`
    process.env.TWILIO_TRANSACTIONAL_STATUS_WEBHOOK_URL =
      "https://backend.example.com/webhooks/twilio/sms/transactional/status"
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    ;(isInSendBlackout as jest.Mock).mockReturnValue({
      blocked: true,
      reason: "shabbat",
      until: new Date("2026-07-11T02:00:00Z"),
    })
    const state = fakeDb()
    global.fetch = jest.fn() as any

    const result = await sendOrderShippedSms(
      { resolve: () => state.db } as any,
      { order: order(), fulfillmentId: "ful_123", trackingNumber: "TRACK123" }
    )

    expect(result).toMatchObject({ ok: false, deferred: true })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(state.messageRow?.status).toBe("deferred")
    expect(state.messageRow?.metadata.defer_until).toBe(
      "2026-07-11T02:00:00.000Z"
    )

    ;(isInSendBlackout as jest.Mock).mockReturnValue({ blocked: false })
    const messageSid = `SM${"d".repeat(32)}`
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ sid: messageSid, status: "queued" }),
    })) as any
    const resumed = await sendOrderShippedSms(
      { resolve: () => state.db } as any,
      { order: order(), fulfillmentId: "ful_123", trackingNumber: "TRACK123" }
    )
    expect(resumed).toEqual({ ok: true, messageSid })
    expect(
      state.writes.filter(
        (write) => write.table === "gp_message_log" && write.op === "insert"
      )
    ).toHaveLength(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it("rechecks the original phone before replaying a deferred SMS", async () => {
    process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED = "true"
    ;(fetchOrderForEmail as jest.Mock).mockResolvedValue({
      ...order(),
      shipping_address: { phone: "(404) 555-0199" },
    })
    const state = fakeDb({
      messageRow: {
        id: "gpmsg_deferred123",
        status: "deferred",
        channel: "sms",
        order_id: "order_123",
        template_key: ORDER_SMS_TEMPLATE_SHIPPED,
        metadata: {
          program: ORDER_SMS_PROGRAM,
          phone: "+14045550100",
          fulfillment_id: "ful_123",
          tracking_number: "TRACK123",
          defer_until: "2026-07-11T02:00:00.000Z",
        },
      },
    })
    global.fetch = jest.fn() as any
    const summary = await resumeBlackoutDeferredOrderSms(
      { resolve: () => state.db } as any
    )
    expect(summary).toMatchObject({ processed: 1, skipped: 1, sent: 0 })
    expect(state.messageRow?.status).toBe("suppressed")
    expect(global.fetch).not.toHaveBeenCalled()
  })

  function order() {
    return {
      id: "order_123",
      display_id: 114391,
      email: "shopper@example.com",
      metadata: {
        fulfillmentType: "ups_shipping",
        order_sms_consent: orderSmsConsent(),
      },
      shipping_address: { phone: "(404) 555-0100" },
    }
  }

  it("sends one idempotent enrollment confirmation through the shared order cap", async () => {
    const messageSid = `SM${"e".repeat(32)}`
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_STATUS_WEBHOOK_URL =
      "https://backend.example.com/webhooks/twilio/sms/transactional/status"
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    const state = fakeDb()
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ sid: messageSid, status: "queued" }),
    })) as any

    await expect(
      sendOrderSmsEnrollmentConfirmation(
        { resolve: () => state.db } as any,
        { order: order() }
      )
    ).resolves.toEqual({ ok: true, messageSid })

    const request = (global.fetch as jest.Mock).mock.calls[0][1]
    const params = new URLSearchParams(String(request.body))
    expect(params.get("Body")).toBe(buildOrderSmsEnrollmentConfirmation())
    expect(state.messageRow?.template_key).toBe(
      ORDER_SMS_TEMPLATE_ENROLLMENT_CONFIRMATION
    )
    expect(state.messageRow?.idempotency_key).toBe(
      "transactional-sms:order-sms-enrollment-confirmation:order_123:transactional-sms-v2-2026-07-11"
    )
    expect(state.messageRow?.metadata.trigger_event).toBe("order.placed")
    expect(state.messageRow?.metadata.fulfillment_id).toBeNull()
  })

  it("fails closed when consent no longer matches the order phone", async () => {
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    const state = fakeDb()
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as any

    const mismatched = order()
    mismatched.shipping_address.phone = "(404) 555-0199"
    const result = await sendOrderShippedSms(
      { resolve: () => state.db } as any,
      {
        order: mismatched,
        fulfillmentId: "ful_123",
        trackingNumber: "TRACK123",
      }
    )

    expect(result).toEqual({ ok: true, skipped: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      state.writes.find((write) => write.table === "gp_message_log")
    ).toBeUndefined()
  })

  it("fails closed while the approval gate is disabled", async () => {
    delete process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED
    const state = fakeDb()
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as any

    const result = await sendOrderShippedSms(
      { resolve: () => state.db } as any,
      {
        order: order(),
        fulfillmentId: "ful_123",
        trackingNumber: "TRACK123",
      }
    )

    expect(result).toEqual({ ok: true, skipped: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      state.writes.find((write) => write.table === "gp_message_log")
    ).toBeUndefined()
  })

  it("sends only through the dedicated Messaging Service with a callback", async () => {
    const messageSid = `SM${"c".repeat(32)}`
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_STATUS_WEBHOOK_URL =
      "https://backend.example.com/webhooks/twilio/sms/transactional/status"
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18445550199"
    process.env.TWILIO_MESSAGING_FROM = "+18445550198"
    const state = fakeDb()
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ sid: messageSid, status: "queued" }),
    })) as any

    const result = await sendOrderShippedSms(
      { resolve: () => state.db } as any,
      {
        order: order(),
        fulfillmentId: "ful_123",
        trackingNumber: "TRACK123",
      }
    )

    expect(result).toEqual({ ok: true, messageSid })
    const request = (global.fetch as jest.Mock).mock.calls[0][1]
    const params = new URLSearchParams(String(request.body))
    expect(params.get("MessagingServiceSid")).toBe(`MG${"b".repeat(32)}`)
    const callback = new URL(String(params.get("StatusCallback")))
    expect(`${callback.origin}${callback.pathname}`).toBe(
      "https://backend.example.com/webhooks/twilio/sms/transactional/status"
    )
    expect(callback.searchParams.get("gp_message_id")).toBe(
      state.messageRow?.id
    )
    expect(callback.hash).toBe("#rc=3&rp=5xx,ct,rt&rt=3000&tt=15000")
    expect(params.get("From")).toBeNull()
    expect(params.get("Body")).toContain("has shipped")
    expect(state.messageRow?.metadata.program).toBe(ORDER_SMS_PROGRAM)
    expect(state.messageRow?.idempotency_key).toBe(
      "transactional-sms:order-shipped:order_123:TRACK123"
    )
  })

  it("requires webhook auth, a valid dedicated sender, and sender separation", () => {
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    expect(transactionalSmsConfigured()).toBe(true)

    delete process.env.TWILIO_AUTH_TOKEN
    process.env.TWILIO_API_KEY_SID = `SK${"c".repeat(32)}`
    process.env.TWILIO_API_KEY_SECRET = "secret"
    expect(transactionalSmsConfigured()).toBe(false)

    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_FROM = "+1555"
    expect(transactionalSmsConfigured()).toBe(false)

    process.env.TWILIO_TRANSACTIONAL_FROM = "+18447485332"
    expect(transactionalSmsConfigured()).toBe(false)
  })

  it("does not reclaim after an ambiguous provider timeout", async () => {
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    const state = fakeDb()
    global.fetch = jest.fn(async () => {
      throw new Error("network timeout")
    }) as any

    await expect(
      sendOrderShippedSms({ resolve: () => state.db } as any, {
        order: order(),
        fulfillmentId: "ful_ambiguous",
      })
    ).resolves.toEqual({ ok: false, error: "network timeout" })
    expect(state.messageRow?.status).toBe("queued")
    expect(state.messageRow?.metadata.provider_outcome).toBe("unknown")
    expect(state.messageRow?.metadata.provider_outcome_at).toEqual(
      expect.any(String)
    )
  })

  it("retries a definite 429 once and never retries a provider 5xx", async () => {
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    const acceptedSid = `SM${"c".repeat(32)}`
    const state429 = fakeDb()
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        json: async () => ({ message: "rate limited" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: { get: () => null },
        json: async () => ({ sid: acceptedSid, status: "queued" }),
      }) as any
    await expect(
      sendOrderShippedSms({ resolve: () => state429.db } as any, {
        order: order(),
        fulfillmentId: "ful_429",
      })
    ).resolves.toEqual({ ok: true, messageSid: acceptedSid })
    expect(global.fetch).toHaveBeenCalledTimes(2)

    const state500 = fakeDb()
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({ message: "provider unavailable" }),
    }) as any
    await expect(
      sendOrderShippedSms({ resolve: () => state500.db } as any, {
        order: order(),
        fulfillmentId: "ful_500",
      })
    ).resolves.toEqual({ ok: false, error: "provider unavailable" })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(state500.messageRow?.status).toBe("queued")
    expect(state500.messageRow?.metadata.provider_outcome).toBe("unknown")
  })

  it("reconciles Twilio send error 21610 into program suppression", async () => {
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    const state = fakeDb()
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({
        code: 21610,
        message: "Attempt to send to unsubscribed recipient",
      }),
    }) as any
    await sendOrderShippedSms({ resolve: () => state.db } as any, {
      order: order(),
      fulfillmentId: "ful_21610",
    })
    expect(state.suppressionRow).toEqual(
      expect.objectContaining({
        phone_e164: "+14045550100",
        reason: "twilio_21610",
        source: "twilio_send_error",
      })
    )
  })

  it("enforces six total program/purpose message logs per order", async () => {
    process.env.TWILIO_TRANSACTIONAL_SMS_ENABLED = "true"
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "auth_test"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    const state = fakeDb({ count: 6 })
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy as any
    await expect(
      sendOrderShippedSms({ resolve: () => state.db } as any, {
        order: order(),
        fulfillmentId: "ful_seventh",
      })
    ).resolves.toEqual({ ok: true, skipped: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(state.raws).toContain("metadata->>'purpose' = ?")
  })
})

describe("program suppression and status callbacks", () => {
  const messagingServiceSid = `MG${"b".repeat(32)}`
  const savedMessagingServiceSid =
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID

  beforeEach(() => {
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID =
      messagingServiceSid
  })

  afterAll(() => {
    if (savedMessagingServiceSid === undefined) {
      delete process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID
    } else {
      process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID =
        savedMessagingServiceSid
    }
  })

  it("STOP writes only the phone+program suppression table", async () => {
    const state = fakeDb()
    const result = await applyTransactionalSmsKeyword(state.db, {
      phone: "+14045550100",
      action: "stop",
      messageSid: "SM_stop_123",
      now: new Date("2026-07-11T14:00:00.000Z"),
    })
    expect(result).toEqual({ updated: 1, eligible: true })
    expect(state.suppressionRow).toEqual(
      expect.objectContaining({
        phone_e164: "+14045550100",
        program: ORDER_SMS_PROGRAM,
        reason: "keyword_stop",
      })
    )
    expect(
      state.writes.some(
        (write) => write.table === "gp_suppression_preference"
      )
    ).toBe(false)
  })

  it("START restores only when a qualifying order consent still exists", async () => {
    const suppression = {
      id: "gpsmssupp_1",
      phone_e164: "+14045550100",
      program: ORDER_SMS_PROGRAM,
      restored_at: null,
      metadata: {},
    }
    const eligible = fakeDb({
      suppressionRow: suppression,
      orderRows: [
        {
          id: "order_123",
          status: "pending",
          created_at: new Date("2026-07-11T12:00:00.000Z"),
          metadata: {
            fulfillmentType: "ups_shipping",
            order_sms_consent: orderSmsConsent(),
          },
        },
      ],
    })
    const result = await applyTransactionalSmsKeyword(eligible.db, {
      phone: "+14045550100",
      action: "start",
      now: new Date("2026-07-11T14:00:00.000Z"),
    })
    expect(result).toEqual({ updated: 1, eligible: true })
    expect(eligible.suppressionRow?.restored_at).toEqual(
      new Date("2026-07-11T14:00:00.000Z")
    )

    const ineligible = fakeDb({ suppressionRow: suppression, orderRows: [] })
    await expect(
      applyTransactionalSmsKeyword(ineligible.db, {
        phone: "+14045550100",
        action: "start",
        now: new Date("2026-07-11T14:00:00.000Z"),
      })
    ).resolves.toEqual({ updated: 0, eligible: false })

    const completed = fakeDb({
      suppressionRow: suppression,
      orderRows: [
        {
          id: "order_completed",
          status: "completed",
          created_at: new Date("2026-07-11T12:00:00.000Z"),
          metadata: {
            fulfillmentType: "ups_shipping",
            order_sms_consent: orderSmsConsent(),
          },
        },
      ],
    })
    await expect(
      applyTransactionalSmsKeyword(completed.db, {
        phone: "+14045550100",
        action: "start",
        now: new Date("2026-07-11T14:00:00.000Z"),
      })
    ).resolves.toEqual({ updated: 0, eligible: false })
  })

  it("applies delivery states monotonically and never downgrades delivered", async () => {
    const state = fakeDb({
      messageRow: {
        id: "gpmsg_status01",
        channel: "sms",
        status: "queued",
        postmark_message_id: "SM_status_123",
        metadata: {
          program: ORDER_SMS_PROGRAM,
          messaging_service_sid: messagingServiceSid,
        },
        provider_response: { sid: "SM_status_123" },
        email: "shopper@example.com",
        order_id: "order_123",
        template_key: "order-shipped",
      },
    })
    await expect(
      applyTransactionalSmsStatus(state.db, {
        messageLogId: "gpmsg_status01",
        messageSid: "SM_status_123",
        messagingServiceSid,
        messageStatus: "sent",
        now: new Date("2026-07-11T14:01:00.000Z"),
      })
    ).resolves.toEqual({ found: true, updated: true, status: "sent" })
    await expect(
      applyTransactionalSmsStatus(state.db, {
        messageLogId: "gpmsg_status01",
        messageSid: "SM_status_123",
        messagingServiceSid,
        messageStatus: "delivered",
        now: new Date("2026-07-11T14:02:00.000Z"),
      })
    ).resolves.toEqual({ found: true, updated: true, status: "delivered" })
    await expect(
      applyTransactionalSmsStatus(state.db, {
        messageLogId: "gpmsg_status01",
        messageSid: "SM_status_123",
        messagingServiceSid,
        messageStatus: "failed",
        errorCode: "30007",
        errorMessage: "Filtered",
        now: new Date("2026-07-11T14:03:00.000Z"),
      })
    ).resolves.toEqual({ found: true, updated: false, status: "delivered" })
    expect(state.messageRow?.status).toBe("delivered")
    expect(state.messageRow?.error_message).toBeNull()
  })

  it("captures terminal Twilio error code and message", async () => {
    const state = fakeDb({
      messageRow: {
        id: "gpmsg_status02",
        channel: "sms",
        status: "queued",
        postmark_message_id: "SM_failed_123",
        metadata: {
          program: ORDER_SMS_PROGRAM,
          messaging_service_sid: messagingServiceSid,
        },
        provider_response: {},
      },
    })
    await applyTransactionalSmsStatus(state.db, {
      messageLogId: "gpmsg_status02",
      messageSid: "SM_failed_123",
      messagingServiceSid,
      messageStatus: "undelivered",
      errorCode: "30003",
      errorMessage: "Unreachable destination",
      now: new Date("2026-07-11T14:01:00.000Z"),
    })
    expect(state.messageRow?.status).toBe("undelivered")
    expect(state.messageRow?.error_message).toBe(
      "30003: Unreachable destination"
    )
    expect(
      state.messageRow?.provider_response?.status_callback?.error_code
    ).toBe("30003")
  })

  it("binds a provider SID by internal row id without downgrading status", async () => {
    const state = fakeDb({
      messageRow: {
        id: "gpmsg_bind0001",
        channel: "sms",
        status: "delivered",
        postmark_message_id: null,
        metadata: {
          phone: "+14045550100",
          program: ORDER_SMS_PROGRAM,
          messaging_service_sid: messagingServiceSid,
        },
        provider_response: {},
      },
    })
    await expect(
      applyTransactionalSmsStatus(state.db, {
        messageLogId: "gpmsg_bind0001",
        messageSid: "SM_bind_123",
        messagingServiceSid,
        messageStatus: "queued",
      })
    ).resolves.toEqual({ found: true, updated: true, status: "delivered" })
    expect(state.messageRow?.postmark_message_id).toBe("SM_bind_123")
    expect(state.messageRow?.status).toBe("delivered")
  })

  it("enriches a same-status terminal callback and suppresses error 21610", async () => {
    const state = fakeDb({
      messageRow: {
        id: "gpmsg_optout01",
        channel: "sms",
        status: "failed",
        postmark_message_id: "SM_optout_123",
        metadata: {
          phone: "+14045550100",
          program: ORDER_SMS_PROGRAM,
          messaging_service_sid: messagingServiceSid,
        },
        provider_response: {},
      },
    })
    await expect(
      applyTransactionalSmsStatus(state.db, {
        messageLogId: "gpmsg_optout01",
        messageSid: "SM_optout_123",
        messagingServiceSid,
        messageStatus: "failed",
        errorCode: "21610",
        errorMessage: "Attempt to send to unsubscribed recipient",
      })
    ).resolves.toEqual({ found: true, updated: true, status: "failed" })
    expect(state.messageRow?.error_message).toContain("21610")
    expect(state.suppressionRow).toEqual(
      expect.objectContaining({
        phone_e164: "+14045550100",
        reason: "twilio_21610",
        source: "twilio_status_callback",
      })
    )
  })
})

describe("transactional Twilio signature verification", () => {
  const savedToken = process.env.TWILIO_AUTH_TOKEN
  afterEach(() => {
    if (savedToken === undefined) delete process.env.TWILIO_AUTH_TOKEN
    else process.env.TWILIO_AUTH_TOKEN = savedToken
  })

  it("accepts the exact signed URL+form and rejects tampering", () => {
    process.env.TWILIO_AUTH_TOKEN = "transactional_test_token"
    process.env.TWILIO_TRANSACTIONAL_STATUS_WEBHOOK_URL =
      "https://example.com/webhooks/twilio/sms/transactional/status"
    const url = transactionalSmsStatusWebhookUrlForMessage("gpmsg_signed001")!
    expect(url).toContain("?gp_message_id=gpmsg_signed001")
    const params = { MessageSid: "SM_status_123", MessageStatus: "delivered" }
    const data =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key as keyof typeof params]}`)
        .join("")
    const signature = crypto
      .createHmac("sha1", "transactional_test_token")
      .update(Buffer.from(data, "utf8"))
      .digest("base64")

    expect(
      verifyTransactionalTwilioSignature({ signature, url, params })
    ).toBe(true)
    expect(
      verifyTransactionalTwilioSignature({
        signature,
        url,
        params: { ...params, MessageStatus: "failed" },
      })
    ).toBe(false)
  })

  it("validates the exact account, service, and dedicated sender target", () => {
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = "transactional_test_token"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"b".repeat(
      32
    )}`
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    const base = {
      AccountSid: `AC${"a".repeat(32)}`,
      MessagingServiceSid: `MG${"b".repeat(32)}`,
    }
    expect(
      validateTransactionalTwilioWebhookTarget(
        { ...base, To: "+18335747455" },
        "inbound"
      )
    ).toBe(true)
    expect(
      validateTransactionalTwilioWebhookTarget(
        { ...base, To: "+18447485332" },
        "inbound"
      )
    ).toBe(false)
    expect(
      validateTransactionalTwilioWebhookTarget(
        { ...base, From: "+18335747455" },
        "status"
      )
    ).toBe(true)
    expect(
      validateTransactionalTwilioWebhookTarget(
        { ...base, From: "+18447485332" },
        "status"
      )
    ).toBe(false)
  })

  it("fails closed when the Twilio auth token is missing", () => {
    delete process.env.TWILIO_AUTH_TOKEN
    expect(
      verifyTransactionalTwilioSignature({
        signature: "anything",
        url: "https://example.com/webhook",
        params: {},
      })
    ).toBe(false)
  })
})
