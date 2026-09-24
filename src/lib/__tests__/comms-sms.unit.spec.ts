import crypto from "crypto"
import {
  applyMarketingSmsStatus,
  applyInboundSmsConsentChange,
  canRestoreSmsMarketingConsentByKeyword,
  classifyInboundSms,
  hasSmsCarrierOptOutAfter,
  hasSmsCarrierRestartAfter,
  hasSmsMarketingCarrierPermission,
  isInSmsQuietHours,
  marketingSmsStatusWebhookUrlForMessage,
  resolveSmsPurpose,
  sendTrackedSms,
  smsMarketingCarrierState,
  toE164,
  validateMarketingTwilioWebhookTarget,
  validateSmsMarketingContent,
  verifyTwilioSignature,
} from "../communications/sms"
import {
  SMS_MARKETING_CONSENT_METHOD,
  SMS_MARKETING_CONSENT_PURPOSE,
  SMS_MARKETING_CONSENT_VERSION,
  SMS_MARKETING_DISCLOSURE,
  SMS_MARKETING_PROGRAM,
  SMS_MARKETING_PROVIDER,
} from "../communications/core"

jest.mock("../communications/destinations", () => ({
  writeEventDestinations: jest.fn(async () => undefined),
}))

jest.mock("../communications/queue", () => ({
  enqueueCommunicationEvent: jest.fn(async () => true),
}))

function fakeSmsDb(
  profile: Record<string, any>,
  messageCount = 0,
  options: { profileAfterClaim?: Record<string, any>; customerAfterClaim?: Record<string, any> } = {}
) {
  let messageRow: Record<string, any> | null = null
  const writes: Array<{ table: string; data: any }> = []
  const rawCalls: string[] = []
  const rawBindingCalls: Array<{ sql: string; bindings: any[] }> = []
  const executionOrder: string[] = []
  const db: any = (table: string) => {
    const chain: any = { _write: false, _count: false }
    for (const method of [
      "whereNull",
      "where",
      "whereIn",
      "select",
      "onConflict",
      "ignore",
      "forUpdate",
    ]) {
      chain[method] = () => chain
    }
    chain.whereRaw = (sql: string) => {
      rawCalls.push(sql)
      return chain
    }
    chain.first = async () => {
      if (table === "customer") return messageRow && options.customerAfterClaim ? options.customerAfterClaim : { metadata: {} }
      if (table === "gp_customer_profile") {
        return messageRow && options.profileAfterClaim
          ? { ...profile, ...options.profileAfterClaim }
          : profile
      }
      if (table === "gp_message_log") return messageRow
      return undefined
    }
    chain.insert = (data: any) => {
      chain._write = true
      writes.push({ table, data })
      if (table === "gp_message_log") {
        messageRow = { ...data }
        executionOrder.push("queued_claim")
      }
      return chain
    }
    chain.update = (data: any) => {
      chain._write = true
      const metadataMerge = data.metadata?.__metadataMerge
      const currentMetadata = metadataObjectForTest(profile.metadata)
      const existingCarrier = metadataObjectForTest(
        currentMetadata.sms_carrier_opt_outs
      )
      const resolvedData = metadataMerge
        ? {
            ...data,
            metadata: {
              ...currentMetadata,
              ...metadataMerge.topLevel,
              sms_carrier_opt_outs: metadataMerge.phone
                ? {
                    ...existingCarrier,
                    [metadataMerge.phone]: {
                      ...metadataObjectForTest(
                        existingCarrier[metadataMerge.phone]
                      ),
                      ...metadataMerge.entry,
                    },
                  }
                : { ...existingCarrier, ...metadataMerge.carrierOptOuts },
            },
          }
        : data
      writes.push({ table, data: resolvedData })
      if (table === "gp_message_log" && messageRow) {
        messageRow = { ...messageRow, ...resolvedData }
      }
      if (table === "gp_customer_profile") Object.assign(profile, resolvedData)
      return chain
    }
    chain.count = () => {
      chain._count = true
      return chain
    }
    chain.then = (resolve: (value: any) => void) =>
      Promise.resolve(
        chain._write
          ? table === "gp_customer_profile"
            ? 1
            : []
          : chain._count
            ? [{ count: messageCount }]
          : table === "gp_customer_profile"
            ? [profile]
            : []
      ).then(resolve)
    return chain
  }
  db.raw = (sql: string, ...bindings: any[]) => {
    rawCalls.push(sql)
    rawBindingCalls.push({ sql, bindings })
    if (sql.includes("pg_advisory_xact_lock")) executionOrder.push("lock")
    const values = Array.isArray(bindings[0]) ? bindings[0] : bindings
    if (sql.includes("sms_carrier_opt_outs") && values.length >= 2) {
      return values.length >= 4
        ? {
            __metadataMerge: {
              topLevel: JSON.parse(String(values[0] || "{}")),
              phone: String(values[1] || ""),
              entry: JSON.parse(String(values[3] || "{}")),
            },
          }
        : {
            __metadataMerge: {
              topLevel: JSON.parse(String(values[0] || "{}")),
              carrierOptOuts: JSON.parse(String(values[1] || "{}")),
            },
          }
    }
    return sql
  }
  db.transaction = async (callback: (trx: any) => Promise<any>) => {
    executionOrder.push("transaction_begin")
    const result = await callback(db)
    executionOrder.push("transaction_commit")
    return result
  }
  return { db, writes, rawCalls, rawBindingCalls, executionOrder }
}

function fakeMarketingStatusDb(
  initialRow: Record<string, any>,
  profile: Record<string, any> = {
    id: "gpcprof_1",
    email: "customer@example.com",
    phone: "+14045550100",
    sms_consent: true,
    sms_consent_at: "2026-07-10T12:00:00.000Z",
    metadata: v3ConsentMetadata(),
  }
) {
  let messageRow = { ...initialRow }
  const writes: Array<{ table: string; op: string; data: any }> = []
  const whereRawCalls: Array<{ sql: string; bindings: any[] }> = []
  const db: any = (table: string) => {
    const chain: any = {
      providerOptOutAttemptedAt: null,
      providerOptOutPhone: null,
    }
    for (const method of [
      "whereNull",
      "where",
      "whereIn",
      "select",
      "forUpdate",
    ]) {
      chain[method] = () => chain
    }
    chain.whereRaw = (sql: string, bindings: any[] = []) => {
      whereRawCalls.push({ sql, bindings })
      if (
        table === "gp_customer_profile" &&
        sql.includes("sms_consent_restart_at")
      ) {
        const attemptedAt = bindings.find(
          (value) =>
            typeof value === "string" &&
            /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(value)
        )
        chain.providerOptOutAttemptedAt = attemptedAt
          ? new Date(attemptedAt)
          : null
        chain.providerOptOutPhone =
          bindings.find(
            (value) =>
              typeof value === "string" && /^\+1[0-9]{10}$/.test(value)
          ) || profile.phone
      }
      return chain
    }
    chain.first = async () => {
      if (table === "gp_message_log") return messageRow
      if (table === "gp_customer_profile") return profile
      return undefined
    }
    chain.update = async (data: Record<string, any>) => {
      if (
        table === "gp_customer_profile" &&
        chain.providerOptOutAttemptedAt &&
        (hasSmsCarrierRestartAfter(
          profile,
          chain.providerOptOutPhone,
          chain.providerOptOutAttemptedAt
        ) ||
          hasSmsCarrierOptOutAfter(
            profile,
            chain.providerOptOutPhone,
            chain.providerOptOutAttemptedAt
          ))
      ) {
        return 0
      }
      const metadataMerge = data.metadata?.__metadataMerge
      const resolvedData = metadataMerge
        ? {
            ...data,
            metadata: {
              ...metadataObjectForTest(profile.metadata),
              ...metadataMerge.topLevel,
              sms_carrier_opt_outs: {
                ...metadataObjectForTest(
                  metadataObjectForTest(profile.metadata)
                    .sms_carrier_opt_outs
                ),
                ...metadataMerge.carrierOptOuts,
              },
            },
          }
        : data
      writes.push({ table, op: "update", data: resolvedData })
      if (table === "gp_message_log") {
        messageRow = { ...messageRow, ...resolvedData }
      }
      if (table === "gp_customer_profile") Object.assign(profile, resolvedData)
      return 1
    }
    chain.insert = (data: Record<string, any>) => {
      writes.push({ table, op: "insert", data })
      return chain
    }
    chain.onConflict = () => chain
    chain.ignore = async () => undefined
    chain.then = (resolve: (value: any) => void) =>
      Promise.resolve(table === "gp_customer_profile" ? [profile] : []).then(
        resolve
      )
    return chain
  }
  db.raw = (sql: string, bindings: any[] = []) => {
    if (sql.includes("sms_carrier_opt_outs") && bindings.length >= 2) {
      return {
        __metadataMerge: {
          topLevel: JSON.parse(String(bindings[0] || "{}")),
          carrierOptOuts: JSON.parse(String(bindings[1] || "{}")),
        },
      }
    }
    return sql
  }
  db.transaction = async (callback: (trx: any) => Promise<any>) => callback(db)
  return {
    db,
    getMessageRow: () => messageRow,
    getProfile: () => profile,
    writes,
    whereRawCalls,
  }
}

function metadataObjectForTest(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function v3ConsentMetadata(overrides: Record<string, any> = {}) {
  return {
    sms_consent_at: "2026-07-10T12:00:00.000Z",
    sms_consent_source: "account_signup",
    sms_consent_version: SMS_MARKETING_CONSENT_VERSION,
    sms_consent_text: SMS_MARKETING_DISCLOSURE,
    sms_consent_phone: "4045550100",
    sms_consent_provider: SMS_MARKETING_PROVIDER,
    sms_program: SMS_MARKETING_PROGRAM,
    sms_consent_purpose: SMS_MARKETING_CONSENT_PURPOSE,
    sms_consent_method: SMS_MARKETING_CONSENT_METHOD,
    ...overrides,
  }
}

function configureMarketingSmsTestEnv() {
  process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
  process.env.TWILIO_AUTH_TOKEN = "auth_test"
  delete process.env.TWILIO_API_KEY_SID
  delete process.env.TWILIO_API_KEY_SECRET
  process.env.TWILIO_MESSAGING_FROM = "+18447485332"
  process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`
  process.env.TWILIO_MARKETING_STATUS_WEBHOOK_URL =
    "https://backend.example.com/webhooks/twilio/sms/status"
  process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
  process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"c".repeat(
    32
  )}`
}

function qualifyingMarketingProfile() {
  return {
    id: "gpcprof_v3",
    email: "customer@example.com",
    email_lower: "customer@example.com",
    phone: "4045550100",
    sms_consent: true,
    sms_consent_at: "2026-07-10T12:00:00.000Z",
    metadata: v3ConsentMetadata(),
  }
}

describe("sms inbound classification", () => {
  it("recognizes the carrier STOP words", () => {
    for (const word of [
      "STOP",
      "stop",
      "Unsubscribe",
      "CANCEL",
      "end",
      "QUIT",
      "REVOKE",
      "OPTOUT",
    ]) {
      expect(classifyInboundSms(word).action).toBe("stop")
    }
  })

  it("recognizes START/UNSTOP", () => {
    expect(classifyInboundSms("START").action).toBe("start")
    expect(classifyInboundSms("START").reply).toBeUndefined()
    expect(classifyInboundSms("unstop").action).toBe("start")
    expect(classifyInboundSms("YES").action).toBe("none")
  })

  it("answers HELP with contact info", () => {
    const help = classifyInboundSms("help")
    expect(help.action).toBe("help")
    expect(help.reply).toContain("STOP")
    expect(help.reply).toContain("(770) 454-8108")
    expect(help.reply).toContain("marketing")
    expect(help.reply).toContain("seasonal specials")
    expect(help.reply).toContain("product announcements")
    expect(help.reply).toContain("promotional offers")
    expect(help.reply).toContain("holiday sales deadlines")
    expect(help.reply).toContain("up to 6 messages/month")
    expect(help.reply).not.toMatch(/order|delivery|shipping/i)
  })

  it("ignores ordinary replies", () => {
    expect(classifyInboundSms("Thanks! See you Friday").action).toBe("none")
    expect(classifyInboundSms("").action).toBe("none")
  })
})

describe("marketing-only SMS policy", () => {
  it("uses the newest exact-phone STOP across map and legacy metadata", () => {
    const profile = qualifyingMarketingProfile()
    profile.metadata = v3ConsentMetadata({
      sms_carrier_opt_outs: {
        "+14045550100": {
          opted_out_at: "2026-07-14T19:00:00.000Z",
          restarted_at: "2026-07-14T19:10:00.000Z",
        },
      },
      sms_opt_out_at: "2026-07-14T19:20:00.000Z",
      sms_opt_out_phone: "+14045550100",
    })

    expect(smsMarketingCarrierState(profile)).toMatchObject({
      optedOutAt: "2026-07-14T19:20:00.000Z",
      carrierRestarted: false,
      allowed: false,
    })
  })

  it("keeps carrier restart state independent per phone", () => {
    const profile = qualifyingMarketingProfile()
    profile.metadata = v3ConsentMetadata({
      sms_carrier_opt_outs: {
        "+14045550100": {
          opted_out_at: "2026-07-14T19:00:00.000Z",
          restarted_at: "2026-07-14T19:10:00.000Z",
        },
        "+17705550100": {
          opted_out_at: "2026-07-14T19:05:00.000Z",
        },
      },
    })

    expect(hasSmsMarketingCarrierPermission(profile, "+14045550100")).toBe(
      true
    )
    const otherPhoneProfile = { ...profile, phone: "7705550100" }
    expect(
      hasSmsMarketingCarrierPermission(otherPhoneProfile, "+17705550100")
    ).toBe(false)
  })

  it("uses semantic purpose rather than physical stream", () => {
    expect(resolveSmsPurpose("transactional", "marketing_1to1")).toBe(
      "marketing_1to1"
    )
    expect(resolveSmsPurpose("broadcast")).toBe("broadcast")
    expect(resolveSmsPurpose("transactional")).toBe("transactional")
  })

  it("rejects use-case drift and incomplete marketing copy", () => {
    expect(
      validateSmsMarketingContent(
        "Griller's Pride holiday specials. Reply STOP to unsubscribe."
      )
    ).toBeNull()
    expect(
      validateSmsMarketingContent(
        "Griller's Pride: your order is ready. Reply STOP to unsubscribe."
      )
    ).toBe("sms_use_case_mismatch")
    expect(validateSmsMarketingContent("Holiday specials. Reply STOP.")).toBe(
      "sms_brand_missing"
    )
    expect(validateSmsMarketingContent("Griller's Pride holiday specials.")).toBe(
      "sms_opt_out_instruction_missing"
    )
  })

  it.each([
    "Your refund was issued.",
    "Your order was refunded.",
    "Your purchase was canceled.",
    "Your purchase was cancelled.",
    "Your cancellation is complete.",
    "Your payment was received.",
    "Your invoice is ready.",
    "Reset your password.",
    "Complete account verification.",
    "Your OTP is 123456.",
    "Your verification code is 123456.",
    "Code: 123456",
    "Your return was approved.",
  ])("rejects transactional SMS mislabeled as marketing: %s", (copy) => {
    expect(
      validateSmsMarketingContent(
        `Griller's Pride: ${copy} Reply STOP to unsubscribe.`
      )
    ).toBe("sms_use_case_mismatch")
  })

  it("keeps coupon-code marketing copy eligible", () => {
    expect(
      validateSmsMarketingContent(
        "Griller's Pride seasonal special: use promo code SUMMER10. Reply STOP to unsubscribe."
      )
    ).toBeNull()
  })

  it("rejects public URL shorteners", () => {
    expect(
      validateSmsMarketingContent(
        "Griller's Pride seasonal special: https://bit.ly/gp-deal Reply STOP to unsubscribe."
      )
    ).toBe("sms_public_shortener_not_allowed")
  })

  it("requires affirmative marketing language", () => {
    expect(
      validateSmsMarketingContent(
        "Griller's Pride has an important update. Reply STOP to unsubscribe."
      )
    ).toBe("sms_marketing_intent_missing")
  })

  it("requires an actual STOP instruction", () => {
    expect(
      validateSmsMarketingContent(
        "STOP by our store for a Griller's Pride holiday special."
      )
    ).toBe("sms_opt_out_instruction_missing")
  })

  it("lets START restore only a prior qualifying v3 customer opt-in", () => {
    const profile = {
      phone: "4045550100",
      sms_consent: false,
      sms_consent_at: null,
      metadata: v3ConsentMetadata(),
    }
    expect(
      canRestoreSmsMarketingConsentByKeyword(profile, "+14045550100")
    ).toBe(true)
    expect(
      canRestoreSmsMarketingConsentByKeyword(
        {
          ...profile,
          metadata: v3ConsentMetadata({
            sms_consent_version: "sms-v2-2026-07-09",
          }),
        },
        "+14045550100"
      )
    ).toBe(false)
    expect(
      canRestoreSmsMarketingConsentByKeyword(
        {
          ...profile,
          metadata: v3ConsentMetadata({
            sms_consent_source: "staff_phone_order",
          }),
        },
        "+14045550100"
      )
    ).toBe(false)
  })

  it("records carrier START without restoring absent written consent", async () => {
    const profile = {
      id: "gpcprof_legacy",
      email: "legacy@example.com",
      phone: "4045550100",
      sms_consent: false,
      sms_consent_at: null,
      metadata: v3ConsentMetadata({
        sms_consent_version: "sms-v2-2026-07-09",
      }),
    }
    const { db, writes, rawCalls, rawBindingCalls } = fakeSmsDb(profile)
    const messageSid = `SM${"r".repeat(32)}`

    await expect(
      applyInboundSmsConsentChange(db, "+14045550100", "start", {
        messageSid,
      })
    ).resolves.toEqual({
      updated: 0,
      nonRestorationReason: "no_qualifying_prior_opt_in",
    })

    const event = writes.find(
      (write) =>
        write.table === "gp_communication_event" &&
        write.data.event_name === "sms_opt_in_restore_not_applied"
    )?.data
    expect(event?.event_id).toBe(
      `marketing-sms-start-not-restored:${messageSid}`
    )
    expect(event?.properties).toEqual(
      expect.objectContaining({
        reason: "no_qualifying_prior_opt_in",
        source: "twilio_inbound_start",
      })
    )
    expect(
      writes.find(
        (write) =>
          write.table === "gp_customer_profile" &&
          write.data.sms_consent === true
      )
    ).toBeUndefined()
    const profileWrite = writes.find(
      (write) => write.table === "gp_customer_profile"
    )?.data
    expect(profileWrite).toEqual(
      expect.objectContaining({
        sms_consent: false,
        sms_consent_at: null,
      })
    )
    const restartMetadata = rawBindingCalls
      .filter((call) => call.sql.includes("coalesce(metadata, '{}'::jsonb)"))
      .map((call) => JSON.parse(String(call.bindings?.[0]?.[0])))
      .find((metadata) => metadata.sms_consent_restart_at)
    expect(restartMetadata).toEqual(
      expect.objectContaining({
        sms_consent_status: "not_subscribed",
        sms_consent_restart_source: "twilio_inbound_start",
        sms_consent_restart_phone: "+14045550100",
      })
    )
    expect(restartMetadata.sms_consent_restart_at).toEqual(
      expect.any(String)
    )
    expect(
      rawCalls.some(
        (sql) =>
          sql.includes(
            "regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?)"
          ) && sql.includes("metadata->>'sms_opt_out_phone'")
      )
    ).toBe(true)
    expect(rawCalls.some((sql) => sql.includes(" like ?"))).toBe(false)
  })

  it("records START against the exact opted-out phone after profile phone changes", async () => {
    const profile = {
      id: "gpcprof_changed_phone",
      email: "changed@example.com",
      phone: "7705550100",
      sms_consent: false,
      sms_consent_at: null,
      metadata: v3ConsentMetadata({
        sms_consent_phone: "7705550100",
        sms_opt_out_at: "2026-07-14T13:00:00.000Z",
        sms_opt_out_phone: "+14045550100",
      }),
    }
    const { db, writes, rawCalls } = fakeSmsDb(profile)

    await expect(
      applyInboundSmsConsentChange(db, "+14045550100", "start")
    ).resolves.toEqual({
      updated: 0,
      nonRestorationReason: "no_qualifying_prior_opt_in",
    })

    expect(
      rawCalls.some(
        (sql) =>
          sql.includes("metadata->>'sms_opt_out_phone'") &&
          sql.includes("metadata->'sms_carrier_opt_outs'")
      )
    ).toBe(true)
    const profileWrite = writes.find(
      (write) => write.table === "gp_customer_profile"
    )?.data
    expect(profileWrite?.sms_consent).toBeUndefined()
    expect(profileWrite?.sms_consent_at).toBeUndefined()
    const restartMetadata = metadataObjectForTest(
      metadataObjectForTest(profile.metadata).sms_carrier_opt_outs
    )["+14045550100"]
    expect(restartMetadata).toEqual(
      expect.objectContaining({
        restart_source: "twilio_inbound_start",
        restarted_at: expect.any(String),
      })
    )
  })

  it("preserves active consent on the current phone when START clears an old phone", async () => {
    const profile = {
      ...qualifyingMarketingProfile(),
      phone: "7705550100",
      sms_consent_at: "2026-07-14T12:00:00.000Z",
      metadata: v3ConsentMetadata({
        sms_consent_at: "2026-07-14T12:00:00.000Z",
        sms_consent_phone: "7705550100",
        sms_opt_out_at: "2026-07-14T13:00:00.000Z",
        sms_opt_out_phone: "+14045550100",
      }),
    }
    const { db, writes } = fakeSmsDb(profile)

    await expect(
      applyInboundSmsConsentChange(db, "+14045550100", "start")
    ).resolves.toEqual({
      updated: 0,
      nonRestorationReason: "no_qualifying_prior_opt_in",
    })

    const profileWrite = writes.find(
      (write) => write.table === "gp_customer_profile"
    )?.data
    expect(profileWrite?.sms_consent).toBeUndefined()
    expect(profileWrite?.sms_consent_at).toBeUndefined()
    expect(profile.sms_consent).toBe(true)
    expect(profile.sms_consent_at).toBe("2026-07-14T12:00:00.000Z")
    const restartMetadata = metadataObjectForTest(
      metadataObjectForTest(profile.metadata).sms_carrier_opt_outs
    )["+14045550100"]
    expect(restartMetadata).toEqual(
      expect.objectContaining({
        restart_source: "twilio_inbound_start",
        restarted_at: expect.any(String),
      })
    )
    expect(
      metadataObjectForTest(profile.metadata).sms_consent_restart_phone
    ).toBeUndefined()
  })

  it("persists the exact opted-out phone on inbound STOP", async () => {
    const profile = qualifyingMarketingProfile()
    const { db, rawBindingCalls } = fakeSmsDb(profile)

    await expect(
      applyInboundSmsConsentChange(db, "+1 (404) 555-0100", "stop", {
        messageSid: `SM${"s".repeat(32)}`,
      })
    ).resolves.toEqual({ updated: 1 })

    const metadataWrite = rawBindingCalls.find((call) =>
      call.sql.includes("coalesce(metadata, '{}'::jsonb)")
    )
    expect(metadataWrite?.sql.match(/cast\(\? as text\)/g)).toHaveLength(2)
    expect(JSON.parse(String(metadataWrite?.bindings?.[0]?.[0]))).toEqual(
      expect.objectContaining({
        sms_opt_out_source: "twilio_inbound_stop",
        sms_opt_out_phone: "+14045550100",
      })
    )
  })

  it("does not let a staff test bypass qualified v3 consent", async () => {
    const legacyProfile = {
      id: "gpcprof_legacy",
      email: "staff@example.com",
      email_lower: "staff@example.com",
      phone: "4045550100",
      sms_consent: true,
      sms_consent_at: "2026-07-09T12:00:00.000Z",
      metadata: v3ConsentMetadata({
        sms_consent_version: "sms-v2-2026-07-09",
      }),
    }
    const { db, writes } = fakeSmsDb(legacyProfile)
    const container = { resolve: () => db } as any

    const result = await sendTrackedSms(container, {
      to: "+14045550100",
      body: "Griller's Pride holiday specials. Reply STOP to unsubscribe.",
      stream: "broadcast",
      purpose: "broadcast",
      template_key: "campaign-sms-test",
      profile_id: legacyProfile.id,
      staff_test: true,
    })

    expect(result).toEqual({ ok: true, skipped: true })
    expect(
      writes.find((write) => write.table === "gp_communication_event")?.data
        ?.properties?.reason
    ).toBe("missing_qualified_sms_marketing_consent")
    expect(
      writes.find((write) => write.table === "gp_message_log")
    ).toBeUndefined()
  })

  it("blocks a qualifying profile while its current phone has an active carrier STOP", async () => {
    const profile = qualifyingMarketingProfile()
    profile.metadata = v3ConsentMetadata({
      sms_opt_out_at: "2026-07-14T19:00:00.000Z",
      sms_opt_out_phone: "+14045550100",
    })
    const { db, writes } = fakeSmsDb(profile)
    const container = { resolve: () => db } as any

    await expect(
      sendTrackedSms(container, {
        to: "+14045550100",
        body: "Griller's Pride holiday specials. Reply STOP to unsubscribe.",
        stream: "broadcast",
        purpose: "broadcast",
        template_key: "campaign-sms-carrier-stop",
        profile_id: profile.id,
        staff_test: true,
      })
    ).resolves.toEqual({ ok: true, skipped: true })

    expect(
      writes.find(
        (write) =>
          write.table === "gp_communication_event" &&
          write.data.properties?.reason === "carrier_sms_opt_out_active"
      )
    ).toBeDefined()
    expect(
      writes.find((write) => write.table === "gp_message_log")
    ).toBeUndefined()
  })

  it("does not let a consented staff test bypass SMS quiet hours", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T11:00:00.000Z"))
    try {
      const profile = {
        id: "gpcprof_v3",
        email: "staff@example.com",
        email_lower: "staff@example.com",
        phone: "4045550100",
        sms_consent: true,
        sms_consent_at: "2026-07-10T12:00:00.000Z",
        metadata: v3ConsentMetadata(),
      }
      const { db, writes } = fakeSmsDb(profile)
      const container = { resolve: () => db } as any

      const result = await sendTrackedSms(container, {
        to: "+14045550100",
        body: "Griller's Pride holiday specials. Reply STOP to unsubscribe.",
        stream: "broadcast",
        purpose: "broadcast",
        template_key: "campaign-sms-test",
        staff_test: true,
      })

      expect(result).toEqual({
        ok: false,
        deferred: true,
        error: "sms_quiet_hours",
      })
      expect(
        writes.find((write) => write.table === "gp_message_log")
      ).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it("counts consented staff tests against the rolling 30-day cap", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      const profile = {
        id: "gpcprof_v3",
        email: "staff@example.com",
        email_lower: "staff@example.com",
        phone: "4045550100",
        sms_consent: true,
        sms_consent_at: "2026-07-10T12:00:00.000Z",
        metadata: v3ConsentMetadata(),
      }
      const { db, writes } = fakeSmsDb(profile, 6)
      const container = { resolve: () => db } as any

      const result = await sendTrackedSms(container, {
        to: "+14045550100",
        body: "Griller's Pride seasonal special. Reply STOP to unsubscribe.",
        stream: "broadcast",
        purpose: "broadcast",
        template_key: "campaign-sms-test",
        staff_test: true,
      })

      expect(result).toEqual({ ok: true, skipped: true })
      expect(
        writes.find((write) => write.table === "gp_communication_event")?.data
          ?.properties?.reason
      ).toBe("monthly_frequency_cap")
      expect(
        writes.find((write) => write.table === "gp_message_log")
      ).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it("claims under advisory locks and commits before calling Twilio", async () => {
    const priorEnv = {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      apiKeySid: process.env.TWILIO_API_KEY_SID,
      apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
      from: process.env.TWILIO_MESSAGING_FROM,
      service: process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID,
      statusUrl: process.env.TWILIO_MARKETING_STATUS_WEBHOOK_URL,
      transactionalFrom: process.env.TWILIO_TRANSACTIONAL_FROM,
      transactionalService:
        process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID,
    }
    const priorFetch = global.fetch
    let providerRequestBody = ""
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`
      process.env.TWILIO_AUTH_TOKEN = "auth_test"
      delete process.env.TWILIO_API_KEY_SID
      delete process.env.TWILIO_API_KEY_SECRET
      process.env.TWILIO_MESSAGING_FROM = "+18447485332"
      process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`
      process.env.TWILIO_MARKETING_STATUS_WEBHOOK_URL =
        "https://backend.example.com/webhooks/twilio/sms/status"
      process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
      process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"c".repeat(
        32
      )}`
      const profile = {
        id: "gpcprof_v3",
        email: "staff@example.com",
        email_lower: "staff@example.com",
        phone: "4045550100",
        sms_consent: true,
        sms_consent_at: "2026-07-10T12:00:00.000Z",
        metadata: v3ConsentMetadata(),
      }
      const { db, writes, rawCalls, executionOrder } = fakeSmsDb(profile, 5)
      const container = { resolve: () => db } as any
      const messageSid = `SM${"d".repeat(32)}`
      global.fetch = jest.fn(async (_url, init) => {
        executionOrder.push("twilio_fetch")
        providerRequestBody = String(init?.body || "")
        return {
          ok: true,
          json: async () => ({ sid: messageSid, status: "queued" }),
        } as any
      }) as any

      const result = await sendTrackedSms(container, {
        to: "+14045550100",
        body: "Griller's Pride seasonal special. Reply STOP to unsubscribe.",
        stream: "broadcast",
        purpose: "broadcast",
        template_key: "campaign-sms-test",
        staff_test: true,
      })

      expect(result).toEqual({ ok: true, messageSid })
      const providerParams = new URLSearchParams(providerRequestBody)
      expect(providerParams.get("MessagingServiceSid")).toBe(
        process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID
      )
      expect(providerParams.get("From")).toBe("+18447485332")
      expect(providerParams.get("StatusCallback")).toContain(
        "/webhooks/twilio/sms/status?gp_message_id=gpmsg_"
      )
      expect(
        rawCalls.filter((sql) => sql.includes("pg_advisory_xact_lock"))
      ).toHaveLength(3)
      expect(rawCalls).toContain(
        "select pg_advisory_xact_lock(hashtextextended(?, 0))"
      )
      expect(rawCalls).toContain("coalesce(sent_at, queued_at) >= ?")
      expect(rawCalls).toContain(
        "regexp_replace(coalesce(phone, ''), '\\D', '', 'g') in (?, ?)"
      )
      expect(rawCalls.some((sql) => sql.includes(" like ?"))).toBe(false)
      expect(executionOrder.indexOf("queued_claim")).toBeGreaterThan(
        executionOrder.indexOf("lock")
      )
      expect(executionOrder.indexOf("transaction_commit")).toBeLessThan(
        executionOrder.indexOf("twilio_fetch")
      )
      expect(
        writes.find(
          (write) =>
            write.table === "gp_communication_event" &&
            write.data.event_name === "sms_accepted"
        )
      ).toBeDefined()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_communication_event" &&
            write.data.event_name === "sms_sent"
        )
      ).toBeUndefined()
    } finally {
      jest.useRealTimers()
      global.fetch = priorFetch
      process.env.TWILIO_ACCOUNT_SID = priorEnv.accountSid
      process.env.TWILIO_AUTH_TOKEN = priorEnv.authToken
      process.env.TWILIO_API_KEY_SID = priorEnv.apiKeySid
      process.env.TWILIO_API_KEY_SECRET = priorEnv.apiKeySecret
      process.env.TWILIO_MESSAGING_FROM = priorEnv.from
      process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID = priorEnv.service
      process.env.TWILIO_MARKETING_STATUS_WEBHOOK_URL = priorEnv.statusUrl
      process.env.TWILIO_TRANSACTIONAL_FROM = priorEnv.transactionalFrom
      process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID =
        priorEnv.transactionalService
    }
  })

  it("keeps an ambiguous provider outcome queued so the same claim cannot send twice", async () => {
    const savedEnv = { ...process.env }
    const priorFetch = global.fetch
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      configureMarketingSmsTestEnv()
      const profile = qualifyingMarketingProfile()
      const { db, writes } = fakeSmsDb(profile)
      const container = { resolve: () => db } as any
      global.fetch = jest.fn(async () => {
        throw new Error("socket closed after upload")
      }) as any
      const input = {
        to: "+14045550100",
        body: "Griller's Pride seasonal special. Reply STOP to unsubscribe.",
        stream: "broadcast" as const,
        purpose: "broadcast" as const,
        template_key: "campaign-sms-ambiguous",
        profile_id: profile.id,
        idempotency_key: "campaign-sms-ambiguous:gpcprof_v3",
        staff_test: true,
      }

      await expect(sendTrackedSms(container, input)).resolves.toEqual({
        ok: false,
        error: "socket closed after upload",
      })
      expect(
        writes.find(
          (write) =>
            write.table === "gp_message_log" &&
            write.data.metadata?.provider_outcome === "unknown"
        )
      ).toBeDefined()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_message_log" && write.data.status === "failed"
        )
      ).toBeUndefined()

      await expect(sendTrackedSms(container, input)).resolves.toEqual({
        ok: true,
        skipped: true,
        messageSid: undefined,
      })
      expect(global.fetch).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
      global.fetch = priorFetch
      process.env = { ...savedEnv }
    }
  })

  it("cancels a queued marketing send when the account retires its destination after claim", async () => {
    const savedEnv = { ...process.env }; const priorFetch=global.fetch
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      configureMarketingSmsTestEnv()
      const profile={ ...qualifyingMarketingProfile(), medusa_customer_id: "cus_controlled" }
      const { db, writes }=fakeSmsDb(profile,0,{ customerAfterClaim: { metadata: {
        primary_contact_v1: { version: 1, phone: "4045550101" }
      } } })
      global.fetch=jest.fn() as any
      const result=await sendTrackedSms({resolve:()=>db} as any,{
        to:"+14045550100",body:"Griller's Pride seasonal special. Reply STOP to unsubscribe.",
        stream:"broadcast",purpose:"broadcast",template_key:"contact-race",profile_id:profile.id,
        idempotency_key:"contact-race",staff_test:true })
      expect(result).toEqual({ok:true,skipped:true});expect(global.fetch).not.toHaveBeenCalled()
      expect(writes.some(w=>w.data.error_message==="retired_customer_sms_destination_after_claim")).toBe(true)
    } finally { jest.useRealTimers();global.fetch=priorFetch;process.env={...savedEnv} }
  })

  it("rechecks consent after the claim and lets a concurrent STOP cancel provider I/O", async () => {
    const savedEnv = { ...process.env }
    const priorFetch = global.fetch
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      configureMarketingSmsTestEnv()
      const profile = qualifyingMarketingProfile()
      const { db, writes } = fakeSmsDb(profile, 0, {
        profileAfterClaim: {
          sms_consent: false,
          sms_consent_at: null,
          metadata: {
            ...profile.metadata,
            sms_consent_status: "unsubscribed",
            sms_opt_out_at: "2026-07-14T20:00:00.000Z",
          },
        },
      })
      const container = { resolve: () => db } as any
      global.fetch = jest.fn() as any

      await expect(
        sendTrackedSms(container, {
          to: "+14045550100",
          body:
            "Griller's Pride seasonal special. Reply STOP to unsubscribe.",
          stream: "broadcast",
          purpose: "broadcast",
          template_key: "campaign-sms-stop-race",
          profile_id: profile.id,
          idempotency_key: "campaign-sms-stop-race:gpcprof_v3",
          staff_test: true,
        })
      ).resolves.toEqual({ ok: true, skipped: true })

      expect(global.fetch).not.toHaveBeenCalled()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_message_log" &&
            write.data.status === "suppressed" &&
            write.data.error_message ===
              "missing_qualified_sms_marketing_consent_after_claim"
        )
      ).toBeDefined()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_communication_event" &&
            write.data.properties?.after_claim === true
        )
      ).toBeDefined()
    } finally {
      jest.useRealTimers()
      global.fetch = priorFetch
      process.env = { ...savedEnv }
    }
  })

  it("rechecks carrier STOP metadata after the claim before provider I/O", async () => {
    const savedEnv = { ...process.env }
    const priorFetch = global.fetch
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      configureMarketingSmsTestEnv()
      const profile = qualifyingMarketingProfile()
      const { db, writes } = fakeSmsDb(profile, 0, {
        profileAfterClaim: {
          sms_consent: true,
          sms_consent_at: "2026-07-14T19:30:00.000Z",
          metadata: v3ConsentMetadata({
            sms_consent_at: "2026-07-14T19:30:00.000Z",
            sms_opt_out_at: "2026-07-14T19:45:00.000Z",
            sms_opt_out_phone: "+14045550100",
          }),
        },
      })
      const container = { resolve: () => db } as any
      global.fetch = jest.fn() as any

      await expect(
        sendTrackedSms(container, {
          to: "+14045550100",
          body:
            "Griller's Pride seasonal special. Reply STOP to unsubscribe.",
          stream: "broadcast",
          purpose: "broadcast",
          template_key: "campaign-sms-carrier-stop-race",
          profile_id: profile.id,
          idempotency_key: "campaign-sms-carrier-stop-race:gpcprof_v3",
          staff_test: true,
        })
      ).resolves.toEqual({ ok: true, skipped: true })

      expect(global.fetch).not.toHaveBeenCalled()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_message_log" &&
            write.data.status === "suppressed" &&
            write.data.error_message ===
              "carrier_sms_opt_out_active_after_claim"
        )
      ).toBeDefined()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_communication_event" &&
            write.data.properties?.reason === "carrier_sms_opt_out_active" &&
            write.data.properties?.after_claim === true
        )
      ).toBeDefined()
    } finally {
      jest.useRealTimers()
      global.fetch = priorFetch
      process.env = { ...savedEnv }
    }
  })

  it("turns Twilio 21610 into a durable local marketing opt-out", async () => {
    const savedEnv = { ...process.env }
    const priorFetch = global.fetch
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:00:00.000Z"))
    try {
      configureMarketingSmsTestEnv()
      const profile = qualifyingMarketingProfile()
      const { db, writes, rawCalls, rawBindingCalls } = fakeSmsDb(profile)
      const container = { resolve: () => db } as any
      global.fetch = jest.fn(async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({
            code: 21610,
            message: "Attempt to send to unsubscribed recipient",
          }),
        }) as any
      ) as any
      const input = {
        to: "+14045550100",
        body: "Griller's Pride seasonal special. Reply STOP to unsubscribe.",
        stream: "broadcast" as const,
        purpose: "broadcast" as const,
        template_key: "campaign-sms-opted-out",
        profile_id: profile.id,
        idempotency_key: "campaign-sms-opted-out:gpcprof_v3",
        staff_test: true,
      }

      await expect(sendTrackedSms(container, input)).resolves.toEqual({
        ok: false,
        error: "Attempt to send to unsubscribed recipient",
      })
      expect(
        writes.find(
          (write) =>
            write.table === "gp_customer_profile" &&
            write.data.sms_consent === false &&
            write.data.sms_consent_at === null
        )
      ).toBeDefined()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_communication_event" &&
            write.data.event_name === "sms_opt_out" &&
            write.data.properties?.reason === "twilio_21610"
        )
      ).toBeDefined()
      expect(
        writes.find(
          (write) =>
            write.table === "gp_message_log" &&
            write.data.status === "failed" &&
            String(write.data.error_message).startsWith("21610:")
        )
      ).toBeDefined()

      await expect(sendTrackedSms(container, input)).resolves.toEqual({
        ok: true,
        skipped: true,
      })
      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(rawCalls.some((sql) => sql.includes(" like ?"))).toBe(false)
      const metadataWrite = rawBindingCalls.find((call) =>
        call.sql.includes("coalesce(metadata, '{}'::jsonb)")
      )
      expect(JSON.parse(String(metadataWrite?.bindings?.[0]?.[0]))).toEqual(
        expect.objectContaining({
          sms_opt_out_reason: "twilio_21610",
          sms_opt_out_phone: "+14045550100",
        })
      )
    } finally {
      jest.useRealTimers()
      global.fetch = priorFetch
      process.env = { ...savedEnv }
    }
  })

  it("rejects malformed inbound From values before building a SQL match", async () => {
    const db = jest.fn(() => {
      throw new Error("SQL must not be reached")
    })

    await expect(applyInboundSmsConsentChange(db, "", "stop")).resolves.toEqual({
      updated: 0,
    })
    await expect(
      applyInboundSmsConsentChange(db, "+1 (000) 000-0000", "start")
    ).resolves.toEqual({ updated: 0 })
    expect(db).not.toHaveBeenCalled()
  })
})

describe("toE164", () => {
  it("normalizes 10-digit and 1-prefixed forms", () => {
    expect(toE164("(404) 643-1567")).toBe("+14046431567")
    expect(toE164("1 404 643 1567")).toBe("+14046431567")
    expect(toE164("+14046431567")).toBe("+14046431567")
  })

  it("rejects short/invalid numbers", () => {
    expect(toE164("40464315")).toBeNull()
    expect(toE164("")).toBeNull()
    expect(toE164(null)).toBeNull()
  })
})

describe("sms quiet hours", () => {
  const prevStart = process.env.COMMS_SMS_QUIET_START
  const prevEnd = process.env.COMMS_SMS_QUIET_END
  afterEach(() => {
    process.env.COMMS_SMS_QUIET_START = prevStart
    process.env.COMMS_SMS_QUIET_END = prevEnd
  })

  it("uses the conservative all-US 3pm-9pm ET window by default", () => {
    delete process.env.COMMS_SMS_QUIET_START
    delete process.env.COMMS_SMS_QUIET_END
    // 2026-07-14: EDT (UTC-4). 14:00 ET = 18:00Z; 16:00 ET = 20:00Z.
    expect(isInSmsQuietHours(new Date("2026-07-14T18:00:00Z"))).toBe(true)
    expect(isInSmsQuietHours(new Date("2026-07-14T20:00:00Z"))).toBe(false)
  })

  it("blocks 9pm ET at the national-window cutoff", () => {
    // 2026-12-15: EST (UTC-5). 21:00 ET = 02:00Z next day.
    expect(isInSmsQuietHours(new Date("2026-12-16T02:00:00Z"))).toBe(true)
    // 16:00 ET = 21:00Z — allowed.
    expect(isInSmsQuietHours(new Date("2026-12-15T21:00:00Z"))).toBe(false)
  })

  it("falls back to the national window for an invalid recipient timezone", () => {
    const noonEt = new Date("2026-07-14T16:00:00Z")
    expect(isInSmsQuietHours(noonEt, "Mars/Olympus")).toBe(true)
    expect(isInSmsQuietHours(noonEt, "America/Los_Angeles")).toBe(false)
  })
})

describe("marketing SMS delivery callbacks", () => {
  const savedEnv = { ...process.env }
  const accountSid = `AC${"a".repeat(32)}`
  const serviceSid = `MG${"b".repeat(32)}`
  const messageSid = `SM${"c".repeat(32)}`

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = accountSid
    process.env.TWILIO_AUTH_TOKEN = "test_auth_token"
    process.env.TWILIO_MESSAGING_FROM = "+18447485332"
    process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID = serviceSid
    process.env.TWILIO_MARKETING_STATUS_WEBHOOK_URL =
      "https://example.com/webhooks/twilio/sms/status"
    process.env.TWILIO_SMS_WEBHOOK_URL =
      "https://example.com/webhooks/twilio/sms"
    process.env.TWILIO_TRANSACTIONAL_FROM = "+18335747455"
    process.env.TWILIO_TRANSACTIONAL_MESSAGING_SERVICE_SID = `MG${"d".repeat(
      32
    )}`
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  function marketingRow(overrides: Record<string, any> = {}) {
    return {
      id: "gpmsg_marketing0001",
      channel: "sms",
      message_purpose: "broadcast",
      status: "queued",
      postmark_message_id: messageSid,
      provider_response: { sid: messageSid, status: "queued" },
      profile_id: "gpcprof_1",
      email: "customer@example.com",
      campaign_id: "gpcamp_1",
      template_key: "campaign-sms",
      queued_at: new Date("2026-07-14T19:59:00.000Z"),
      metadata: {
        phone: "+14045550100",
        program: SMS_MARKETING_PROGRAM,
        purpose: "broadcast",
        messaging_service_sid: serviceSid,
        provider_attempted_at: "2026-07-14T19:59:30.000Z",
      },
      ...overrides,
    }
  }

  it("advances delivery state monotonically and records the callback", async () => {
    const state = fakeMarketingStatusDb(marketingRow())
    const deliveredAt = new Date("2026-07-14T20:00:00.000Z")
    await expect(
      applyMarketingSmsStatus(state.db, {
        messageLogId: "gpmsg_marketing0001",
        messageSid,
        messagingServiceSid: serviceSid,
        messageStatus: "delivered",
        now: deliveredAt,
      })
    ).resolves.toEqual({ found: true, updated: true, status: "delivered" })
    expect(state.getMessageRow().status).toBe("delivered")
    expect(state.getMessageRow().delivered_at).toEqual(deliveredAt)

    await expect(
      applyMarketingSmsStatus(state.db, {
        messageLogId: "gpmsg_marketing0001",
        messageSid,
        messagingServiceSid: serviceSid,
        messageStatus: "sent",
      })
    ).resolves.toEqual({ found: true, updated: false, status: "delivered" })
    expect(state.getMessageRow().status).toBe("delivered")
    expect(
      state.writes.find(
        (write) =>
          write.table === "gp_communication_event" &&
          write.data.event_name === "sms_delivered"
      )
    ).toBeDefined()
  })

  it("fails closed for the wrong service or a non-marketing message row", async () => {
    const wrongService = fakeMarketingStatusDb(marketingRow())
    await expect(
      applyMarketingSmsStatus(wrongService.db, {
        messageLogId: "gpmsg_marketing0001",
        messageSid,
        messagingServiceSid: `MG${"z".repeat(32)}`,
        messageStatus: "delivered",
      })
    ).resolves.toEqual({ found: false, updated: false })

    const wrongPurpose = fakeMarketingStatusDb(
      marketingRow({ message_purpose: "transactional" })
    )
    await expect(
      applyMarketingSmsStatus(wrongPurpose.db, {
        messageLogId: "gpmsg_marketing0001",
        messageSid,
        messagingServiceSid: serviceSid,
        messageStatus: "delivered",
      })
    ).resolves.toEqual({ found: false, updated: false })
  })

  it("accepts a signed callback with no service parameter using the stored service", async () => {
    const state = fakeMarketingStatusDb(marketingRow())

    await expect(
      applyMarketingSmsStatus(state.db, {
        messageLogId: "gpmsg_marketing0001",
        messageSid,
        messagingServiceSid: "",
        messageStatus: "delivered",
      })
    ).resolves.toEqual({ found: true, updated: true, status: "delivered" })

    expect(state.getMessageRow().provider_response).toEqual(
      expect.objectContaining({ messaging_service_sid: serviceSid })
    )
  })

  it("persists a 21610 callback as a local marketing opt-out", async () => {
    const profile = {
      id: "gpcprof_1",
      email: "customer@example.com",
      phone: "+14045550100",
      // Written consent happened after the provider attempt. It still cannot
      // lift Twilio's carrier STOP.
      sms_consent: true,
      sms_consent_at: "2026-07-14T19:59:45.000Z",
      metadata: v3ConsentMetadata({
        sms_consent_at: "2026-07-14T19:59:45.000Z",
      }),
    }
    const state = fakeMarketingStatusDb(marketingRow(), profile)
    const processedAt = new Date("2026-07-14T20:00:00.000Z")
    await expect(
      applyMarketingSmsStatus(state.db, {
        messageLogId: "gpmsg_marketing0001",
        messageSid,
        messagingServiceSid: serviceSid,
        messageStatus: "failed",
        errorCode: "21610",
        errorMessage: "Attempt to send to unsubscribed recipient",
        now: processedAt,
      })
    ).resolves.toEqual({ found: true, updated: true, status: "failed" })

    expect(state.getProfile().sms_consent).toBe(false)
    expect(state.getProfile().sms_consent_at).toBeNull()
    expect(state.getProfile().updated_at).toEqual(processedAt)
    expect(
      state.whereRawCalls.find((call) =>
        call.sql.includes("sms_consent_restart_at")
      )?.sql
    ).not.toContain("sms_consent_at")
    expect(
      state.writes.find(
        (write) =>
          write.table === "gp_communication_event" &&
          write.data.event_name === "sms_opt_out" &&
          write.data.properties?.source === "twilio_status_callback"
      )
    ).toBeDefined()
  })

  it("lets a strictly later same-phone START beat a delayed 21610 callback", async () => {
    const profile = {
      id: "gpcprof_1",
      email: "customer@example.com",
      phone: "+14045550100",
      sms_consent: true,
      sms_consent_at: "2026-07-14T19:59:40.000Z",
      metadata: v3ConsentMetadata({
        sms_consent_at: "2026-07-14T19:59:40.000Z",
        sms_consent_restart_at: "2026-07-14T19:59:31.000Z",
        sms_consent_restart_phone: "+14045550100",
      }),
    }
    const state = fakeMarketingStatusDb(marketingRow(), profile)

    await applyMarketingSmsStatus(state.db, {
      messageLogId: "gpmsg_marketing0001",
      messageSid,
      messagingServiceSid: serviceSid,
      messageStatus: "failed",
      errorCode: "21610",
      now: new Date("2026-07-14T20:00:00.000Z"),
    })

    expect(state.getProfile().sms_consent).toBe(true)
    expect(
      state.writes.find(
        (write) =>
          write.table === "gp_communication_event" &&
          write.data.event_name === "sms_opt_out"
      )
    ).toBeUndefined()
  })

  it.each([
    ["a later START on another phone", "2026-07-14T19:59:31.000Z", "+17705550100"],
    ["an earlier same-phone START", "2026-07-14T19:59:29.000Z", "+14045550100"],
    ["an equal-time same-phone START", "2026-07-14T19:59:30.000Z", "+14045550100"],
  ])("does not let %s beat provider 21610", async (_label, restartAt, restartPhone) => {
    const profile = {
      id: "gpcprof_1",
      email: "customer@example.com",
      phone: "+14045550100",
      sms_consent: true,
      sms_consent_at: "2026-07-14T19:59:45.000Z",
      metadata: v3ConsentMetadata({
        sms_consent_at: "2026-07-14T19:59:45.000Z",
        sms_consent_restart_at: restartAt,
        sms_consent_restart_phone: restartPhone,
      }),
    }
    const state = fakeMarketingStatusDb(marketingRow(), profile)

    await applyMarketingSmsStatus(state.db, {
      messageLogId: "gpmsg_marketing0001",
      messageSid,
      messagingServiceSid: serviceSid,
      messageStatus: "failed",
      errorCode: "21610",
      now: new Date("2026-07-14T20:00:00.000Z"),
    })

    expect(state.getProfile().sms_consent).toBe(false)
  })

  it("preserves a correlated old-phone 21610 and lets START clear only that phone", async () => {
    const profile = {
      id: "gpcprof_1",
      email: "customer@example.com",
      phone: "+17705550100",
      sms_consent: true,
      sms_consent_at: "2026-07-14T19:00:00.000Z",
      metadata: v3ConsentMetadata({
        sms_consent_at: "2026-07-14T19:00:00.000Z",
        sms_consent_phone: "7705550100",
      }),
    }
    const state = fakeMarketingStatusDb(marketingRow(), profile)

    await applyMarketingSmsStatus(state.db, {
      messageLogId: "gpmsg_marketing0001",
      messageSid,
      messagingServiceSid: serviceSid,
      messageStatus: "failed",
      errorCode: "21610",
      now: new Date("2026-07-14T20:00:00.000Z"),
    })

    expect(profile.sms_consent).toBe(true)
    expect(
      metadataObjectForTest(
        metadataObjectForTest(profile.metadata).sms_carrier_opt_outs
      )["+14045550100"]
    ).toMatchObject({
      opted_out_at: "2026-07-14T19:59:30.000Z",
      reason: "twilio_21610",
    })
    expect(
      hasSmsMarketingCarrierPermission(
        { ...profile, phone: "+14045550100" },
        "+14045550100"
      )
    ).toBe(false)

    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T20:01:00.000Z"))
    try {
      const inbound = fakeSmsDb(profile)
      await applyInboundSmsConsentChange(
        inbound.db,
        "+14045550100",
        "start"
      )
    } finally {
      jest.useRealTimers()
    }

    expect(profile.sms_consent).toBe(true)
    expect(
      hasSmsMarketingCarrierPermission(
        { ...profile, phone: "+14045550100" },
        "+14045550100"
      )
    ).toBe(true)
  })

  it("does not let a delayed older 21610 regress a newer same-phone STOP", async () => {
    const profile = {
      id: "gpcprof_1",
      email: "customer@example.com",
      phone: "+14045550100",
      sms_consent: false,
      sms_consent_at: null,
      metadata: v3ConsentMetadata({
        sms_opt_out_at: "2026-07-14T19:59:40.000Z",
        sms_opt_out_phone: "+14045550100",
        sms_carrier_opt_outs: {
          "+14045550100": {
            opted_out_at: "2026-07-14T19:59:40.000Z",
            source: "twilio_inbound_stop",
          },
        },
      }),
    }
    const state = fakeMarketingStatusDb(marketingRow(), profile)

    await applyMarketingSmsStatus(state.db, {
      messageLogId: "gpmsg_marketing0001",
      messageSid,
      messagingServiceSid: serviceSid,
      messageStatus: "failed",
      errorCode: "21610",
      now: new Date("2026-07-14T20:00:00.000Z"),
    })

    expect(metadataObjectForTest(profile.metadata).sms_opt_out_at).toBe(
      "2026-07-14T19:59:40.000Z"
    )
  })

  it("builds the exact signed URL and validates account, service, and sender", () => {
    expect(
      marketingSmsStatusWebhookUrlForMessage("gpmsg_marketing0001")
    ).toBe(
      "https://example.com/webhooks/twilio/sms/status?gp_message_id=gpmsg_marketing0001"
    )
    expect(
      validateMarketingTwilioWebhookTarget(
        {
          AccountSid: accountSid,
          MessagingServiceSid: serviceSid,
          From: "+18447485332",
        },
        "status"
      )
    ).toBe(true)
    expect(
      validateMarketingTwilioWebhookTarget(
        {
          AccountSid: accountSid,
          From: "+18447485332",
        },
        "status"
      )
    ).toBe(true)
    expect(
      validateMarketingTwilioWebhookTarget(
        {
          AccountSid: accountSid,
          MessagingServiceSid: serviceSid,
          From: "+18335747455",
        },
        "status"
      )
    ).toBe(false)
  })
})

describe("twilio signature verification", () => {
  const prevToken = process.env.TWILIO_AUTH_TOKEN
  afterEach(() => {
    process.env.TWILIO_AUTH_TOKEN = prevToken
  })

  it("accepts a correctly signed request and rejects a tampered one", () => {
    process.env.TWILIO_AUTH_TOKEN = "test_token_123"
    const url = "https://example.com/webhooks/twilio/sms"
    const params = { Body: "STOP", From: "+14046431567" }
    const data =
      url +
      Object.keys(params)
        .sort()
        .map((k) => `${k}${(params as any)[k]}`)
        .join("")
    const signature = crypto
      .createHmac("sha1", "test_token_123")
      .update(Buffer.from(data, "utf-8"))
      .digest("base64")

    expect(verifyTwilioSignature({ signature, url, params })).toBe(true)
    expect(
      verifyTwilioSignature({
        signature,
        url,
        params: { ...params, Body: "START" },
      })
    ).toBe(false)
    expect(verifyTwilioSignature({ signature: "", url, params })).toBe(false)
  })

  it("fails closed when no auth token is configured", () => {
    delete process.env.TWILIO_AUTH_TOKEN
    expect(
      verifyTwilioSignature({ signature: "", url: "http://x", params: {} })
    ).toBe(false)
  })
})
