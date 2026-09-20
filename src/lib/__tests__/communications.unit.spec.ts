import { buildSimpleMessageEmail } from "../emails/templates/simple-message"
import {
  MARKETING_SUPPRESSION_SCOPES,
  SMS_MARKETING_CONSENT_METHOD,
  SMS_MARKETING_CONSENT_PURPOSE,
  SMS_MARKETING_CONSENT_VERSION,
  SMS_MARKETING_DISCLOSURE,
  SMS_MARKETING_PROGRAM,
  SMS_MARKETING_PROVIDER,
  hasQualifyingSmsMarketingConsent,
  isStaleSmsConsentReplay,
  normalizeEmail,
  postmarkMetadata,
  preferenceUrl,
  smsConsentFromCustomerMetadata,
  upsertCustomerProfile,
  verifyServiceApiKey,
  withoutSmsConsentEvidence,
} from "../communications/core"
import { queuesConfigured } from "../communications/queue"
import { resolveFlowMessagePurpose } from "../communications/flows"
import { COMMUNICATION_TEMPLATE_REGISTRY } from "../communications/templates"

function concurrentStopDb(existing: Record<string, any>) {
  const stopped = {
    ...existing,
    sms_consent: false,
    sms_consent_at: null,
    metadata: {
      ...existing.metadata,
      sms_opt_out_at: "2026-07-11T12:00:00.000Z",
    },
  }
  const updates: Record<string, any>[] = []
  let firstCount = 0
  const db: any = () => {
    const chain: any = {}
    for (const method of ["whereNull", "where", "whereRaw"]) {
      chain[method] = () => chain
    }
    chain.first = async () => (firstCount++ === 0 ? existing : stopped)
    chain.update = async (data: Record<string, any>) => {
      updates.push(data)
      return 1
    }
    return chain
  }
  db.raw = (sql: string, bindings: any[]) => ({ sql: sql + bindings.filter((b) => b?.sql).map((b) => b.sql).join(" "), bindings })
  return { db, updates }
}

function concurrentProfileInsertDb(
  winner: Record<string, any> | null
) {
  const inserts: Record<string, any>[] = []
  const updates: Record<string, any>[] = []
  const ignore = jest.fn(async () => undefined)
  const onConflict = jest.fn(() => ({ ignore }))
  let identityReads = 0

  const db: any = () => {
    const chain: any = {}
    chain.whereNull = () => chain
    chain.where = () => chain
    chain.whereRaw = () => chain
    chain.first = async () => {
      identityReads += 1
      // The first lookup checks both medusa_customer_id and email_lower before
      // the insert. The second lookup observes the concurrently inserted row.
      return identityReads > 2 ? winner : null
    }
    chain.insert = (row: Record<string, any>) => {
      inserts.push(row)
      return { onConflict }
    }
    chain.update = async (data: Record<string, any>) => {
      updates.push(data)
      return 1
    }
    return chain
  }
  db.raw = (sql: string, bindings: any[]) => ({ sql: sql + bindings.filter((b) => b?.sql).map((b) => b.sql).join(" "), bindings })

  return { db, ignore, inserts, onConflict, updates }
}

describe("communications helpers", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.STOREFRONT_URL = "https://grillerspride.com"
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("normalizes profile email addresses consistently", () => {
    expect(normalizeEmail("  Avi@Example.COM ")).toBe("avi@example.com")
    expect(normalizeEmail(null)).toBe("")
  })

  it("maps only exact customer-originated v3 marketing evidence onto profiles", () => {
    expect(SMS_MARKETING_DISCLOSURE).toBe(
      "By checking this box, I agree to receive recurring automated marketing and promotional text messages from Griller's Pride, including seasonal specials, product announcements, promotional offers, and holiday sales deadlines, at the mobile number provided. Consent is not a condition of purchase. Message frequency varies, up to 6 messages per month. Msg & data rates may apply. Reply STOP to opt out or HELP for help."
    )
    const metadata = {
      sms_marketing_opt_in: true,
      sms_consent_at: "2026-07-10T12:00:00.000Z",
      sms_consent_source: "account_profile",
      sms_consent_version: SMS_MARKETING_CONSENT_VERSION,
      sms_consent_text: SMS_MARKETING_DISCLOSURE,
      sms_consent_phone: "4045550100",
      sms_consent_provider: SMS_MARKETING_PROVIDER,
      sms_program: SMS_MARKETING_PROGRAM,
      sms_consent_purpose: SMS_MARKETING_CONSENT_PURPOSE,
      sms_consent_method: SMS_MARKETING_CONSENT_METHOD,
    }
    const mapped = smsConsentFromCustomerMetadata(metadata)
    expect(mapped).toEqual({
      sms_consent: true,
      sms_consent_at: "2026-07-10T12:00:00.000Z",
      metadata: {
        sms_consent_at: "2026-07-10T12:00:00.000Z",
        sms_consent_source: "account_profile",
        sms_consent_version: SMS_MARKETING_CONSENT_VERSION,
        sms_consent_text: SMS_MARKETING_DISCLOSURE,
        sms_consent_phone: "4045550100",
        sms_consent_provider: SMS_MARKETING_PROVIDER,
        sms_program: SMS_MARKETING_PROGRAM,
        sms_consent_purpose: SMS_MARKETING_CONSENT_PURPOSE,
        sms_consent_method: SMS_MARKETING_CONSENT_METHOD,
      },
    })
    expect(
      hasQualifyingSmsMarketingConsent(
        { phone: "(404) 555-0100", ...mapped },
        "+14045550100"
      )
    ).toBe(true)

    expect(smsConsentFromCustomerMetadata({})).toEqual({})
  })

  it("quarantines legacy, mixed, staff-attested, and wrong-number SMS evidence", () => {
    const valid = {
      sms_marketing_opt_in: true,
      sms_consent_at: "2026-07-10T12:00:00.000Z",
      sms_consent_source: "account_signup",
      sms_consent_version: SMS_MARKETING_CONSENT_VERSION,
      sms_consent_text: SMS_MARKETING_DISCLOSURE,
      sms_consent_phone: "4045550100",
      sms_consent_provider: SMS_MARKETING_PROVIDER,
      sms_program: SMS_MARKETING_PROGRAM,
      sms_consent_purpose: SMS_MARKETING_CONSENT_PURPOSE,
      sms_consent_method: SMS_MARKETING_CONSENT_METHOD,
    }

    expect(
      smsConsentFromCustomerMetadata({
        ...valid,
        sms_consent_version: "sms-v2-2026-07-09",
      })
    ).toEqual({})
    expect(
      smsConsentFromCustomerMetadata({
        ...valid,
        sms_consent_source: "staff_phone_order",
      })
    ).toEqual({})
    for (const staffSource of [
      "staff",
      "staff_impersonation",
      "staff_phone_order",
      "admin_staff_reorder",
    ]) {
      expect(
        smsConsentFromCustomerMetadata({
          ...valid,
          sms_consent_source: staffSource,
        })
      ).toEqual({})
    }
    expect(
      smsConsentFromCustomerMetadata({
        ...valid,
        sms_consent_text: `${SMS_MARKETING_DISCLOSURE} Order updates too.`,
      })
    ).toEqual({})

    const mapped = smsConsentFromCustomerMetadata(valid)
    expect(
      hasQualifyingSmsMarketingConsent(
        { phone: "4045559999", ...mapped },
        "+14045550100"
      )
    ).toBe(false)
  })

  it("keeps STOP durable against stale customer metadata replays", () => {
    expect(
      isStaleSmsConsentReplay(
        "2026-07-10T12:00:00.000Z",
        "2026-07-11T12:00:00.000Z",
        false
      )
    ).toBe(true)
    expect(
      isStaleSmsConsentReplay(
        "2026-07-12T12:00:00.000Z",
        "2026-07-11T12:00:00.000Z",
        false
      )
    ).toBe(false)
    // A profile legitimately restored by START remains active when the old
    // Medusa metadata is observed again.
    expect(
      isStaleSmsConsentReplay(
        "2026-07-10T12:00:00.000Z",
        "2026-07-11T12:00:00.000Z",
        true
      )
    ).toBe(false)
  })

  it("uses an atomic STOP-wins update for concurrent consent replay", async () => {
    const existing = {
      id: "gpcprof_1",
      medusa_customer_id: "cus_1",
      email: "shopper@example.com",
      email_lower: "shopper@example.com",
      phone: "4045550100",
      sms_consent: true,
      sms_consent_at: new Date("2026-07-10T12:00:00.000Z"),
      email_consent: false,
      metadata: {},
      preferences: {},
      preference_token: "pref_1",
    }
    const { db, updates } = concurrentStopDb(existing)
    const result = await upsertCustomerProfile(db, {
      medusa_customer_id: "cus_1",
      phone: "4045550100",
      sms_consent: true,
      sms_consent_at: "2026-07-10T12:00:00.000Z",
      metadata: {
        sms_consent_at: "2026-07-10T12:00:00.000Z",
      },
    })

    expect(result?.sms_consent).toBe(false)
    expect(updates[0].sms_consent.sql).toContain("sms_opt_out_at")
    expect(updates[0].metadata.sql).toContain("coalesce(metadata")
    expect(updates[0].sms_consent).not.toBe(true)
  })

  it("reconciles a concurrent first profile insert and merges this caller's fields", async () => {
    const winner = {
      id: "gpcprof_winner",
      medusa_customer_id: "cus_1",
      email: "shopper@example.com",
      email_lower: "shopper@example.com",
      phone: null,
      first_name: null,
      last_name: null,
      customer_type: "dtc",
      route_market: "unknown",
      email_consent: false,
      email_consent_at: null,
      preferences: {},
      preference_token: "pref_winner",
      metadata: {},
    }
    const { db, ignore, inserts, onConflict, updates } =
      concurrentProfileInsertDb(winner)

    const result = await upsertCustomerProfile(db, {
      medusa_customer_id: "cus_1",
      email: "shopper@example.com",
      first_name: "Shopper",
      phone: "4045550100",
    })

    expect(onConflict).toHaveBeenCalledWith()
    expect(ignore).toHaveBeenCalledTimes(1)
    expect(inserts).toHaveLength(1)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      medusa_customer_id: "cus_1",
      email_lower: "shopper@example.com",
      first_name: "Shopper",
      phone: "4045550100",
      preference_token: "pref_winner",
    })
    expect(result).toMatchObject({
      id: "gpcprof_winner",
      first_name: "Shopper",
      phone: "4045550100",
    })
  })

  it("fails closed when an ignored insert has no matching customer identity", async () => {
    const { db, ignore, updates } = concurrentProfileInsertDb(null)

    await expect(
      upsertCustomerProfile(db, {
        medusa_customer_id: "cus_1",
        email: "shopper@example.com",
      })
    ).rejects.toThrow(
      "Customer profile insert conflicted but no active identity match was found"
    )

    expect(ignore).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(0)
  })

  it("does not trust public identify traits as SMS consent evidence", () => {
    expect(
      withoutSmsConsentEvidence({
        email: "customer@example.com",
        favorite_cut: "brisket",
        sms_marketing_opt_in: true,
        sms_consent: true,
        sms_consent_at: "2026-07-10T12:00:00.000Z",
        sms_consent_version: SMS_MARKETING_CONSENT_VERSION,
        sms_program: SMS_MARKETING_PROGRAM,
        sms_opt_out_at: "2026-07-11T12:00:00.000Z",
        sms_capability_basis: "public-payload-must-not-overwrite",
        SMS_CONSENT_PROVIDER: "case-insensitive-bypass",
      })
    ).toEqual({
      email: "customer@example.com",
      favorite_cut: "brisket",
    })
  })

  it("caps Postmark metadata at the provider limit without empty fields", () => {
    const metadata = postmarkMetadata({
      message_log_id: "gpmsg_1",
      template_key: "order-placed",
      stream: "transactional",
      purpose: "transactional",
      order_id: "order_1",
      cart_id: "",
      campaign_id: null,
      flow_id: undefined,
      email: "avi@example.com",
      total: 42.45,
      display_id: 102,
      extra_1: "kept",
      preference_center_url: "https://grillerspride.com/prefs",
      extra_2: "dropped",
      nested: { too: "late" },
    })

    expect(Object.keys(metadata)).toHaveLength(10)
    expect(Object.keys(metadata).every((key) => key.length <= 20)).toBe(true)
    expect(metadata.cart_id).toBeUndefined()
    expect(metadata.campaign_id).toBeUndefined()
    expect(metadata.flow_id).toBeUndefined()
    expect(metadata.total).toBe("42.45")
    expect(metadata.extra_1).toBe("kept")
    expect(metadata.preference_center_ur).toBe("https://grillerspride.com/prefs")
    expect(metadata.extra_2).toBeUndefined()
    expect(metadata.nested).toBeUndefined()
  })

  it("renders lifecycle emails with absolute storefront links", () => {
    const email = buildSimpleMessageEmail({
      subject: "Your cart is still here",
      heading: "Your cart is still here",
      paragraphs: ["Inventory can change, so check out while items are available."],
      ctaLabel: "Return to cart",
      ctaUrl: "/us/cart",
    })

    expect(email.html).toMatch(/href="https?:\/\/[^"]+\/us\/cart"/)
    expect(email.text).toMatch(/Return to cart: https?:\/\/.+\/us\/cart/)
    expect(email.html).toContain("/images/logos/logo-horizontal.png")
  })

  it("builds preference-center links from the configured storefront origin", () => {
    expect(preferenceUrl("pref-token")).toBe(
      "https://grillerspride.com/us/email-preferences?t=pref-token"
    )
  })

  it("accepts a separate public communications ingestion key", () => {
    process.env.NEWSLETTER_API_KEY = "private-newsletter-key"
    process.env.COMMUNICATIONS_PUBLIC_API_KEY = "public-ingestion-key"

    expect(
      verifyServiceApiKey({ "x-api-key": "public-ingestion-key" })
    ).toBe(true)
    expect(
      verifyServiceApiKey({ authorization: "Bearer private-newsletter-key" })
    ).toBe(true)
    expect(verifyServiceApiKey({ "x-api-key": "wrong-key" })).toBe(false)
  })

  it("keeps separate template coverage for transactional lifecycle and broadcast streams", () => {
    const streams = new Set(
      COMMUNICATION_TEMPLATE_REGISTRY.map((template) => template.stream)
    )
    expect(streams.has("transactional")).toBe(true)
    expect(streams.has("lifecycle")).toBe(true)
    expect(streams.has("broadcast")).toBe(true)
    expect(
      COMMUNICATION_TEMPLATE_REGISTRY.some(
        (template) => template.key === "refund-issued"
      )
    ).toBe(true)
    expect(
      COMMUNICATION_TEMPLATE_REGISTRY.some(
        (template) => template.key === "back-in-stock"
      )
    ).toBe(true)
  })

  it("routes one-to-one cart recovery through transactional Postmark with marketing consent semantics", () => {
    const cartTemplates = COMMUNICATION_TEMPLATE_REGISTRY.filter((template) =>
      template.key.startsWith("cart-abandoned")
    )

    expect(cartTemplates.length).toBeGreaterThan(0)
    expect(cartTemplates.every((template) => template.stream === "transactional")).toBe(
      true
    )
    expect(
      cartTemplates.every((template) => template.purpose === "marketing_1to1")
    ).toBe(true)
  })

  it("passes the flow-level marketing purpose to SMS/email steps", () => {
    expect(
      resolveFlowMessagePurpose(
        undefined,
        "marketing_1to1",
        "transactional"
      )
    ).toBe("marketing_1to1")
    expect(
      resolveFlowMessagePurpose("broadcast", "marketing_1to1", "lifecycle")
    ).toBe("broadcast")
  })

  it("resubscribe paths clear every marketing suppression scope", () => {
    expect(MARKETING_SUPPRESSION_SCOPES).toEqual([
      "marketing",
      "lifecycle",
      "broadcast",
      "marketing_1to1",
    ])
  })

  it("treats communications queues as optional infrastructure", () => {
    delete process.env.REDIS_URL
    delete process.env.COMMUNICATIONS_REDIS_URL
    expect(queuesConfigured()).toBe(false)

    process.env.COMMUNICATIONS_REDIS_URL = "redis://localhost:6379"
    expect(queuesConfigured()).toBe(true)
  })
})
