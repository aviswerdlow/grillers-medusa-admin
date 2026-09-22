import crypto from "crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { buildSimpleMessageEmail } from "../emails/templates/simple-message"
import {
  applySmsMarketingConsentWhere,
  hasQualifyingSmsMarketingConsent,
  normalizeEmail,
  recordCommunicationEvent,
  recordSuppression,
  sendTrackedEmail,
  type CommunicationStream,
} from "./core"
import { isInSendBlackout, nextAllowedSendTime } from "./hebrew-calendar"
import { campaignNeedsApproval, requestCampaignApproval } from "./approvals"
import {
  clickHouseSegmentProfileIds,
  isClickHouseSegmentDefinition,
  seedGpSegmentLibrary,
} from "./segments"
import {
  enrollCalendarAnchoredFlows,
  runDueFlowEnrollments,
  seedCommunicationDefaults,
} from "./flows"
import { expireInactiveCarts } from "./cart-lifecycle"
import { communicationQueueHealth, enqueueCampaignSend } from "./queue"
import { communicationReporting } from "./reporting"
import { listEmailTemplates, seedEmailTemplates } from "./templates"
import { resolvePostmarkMonthlyLimit } from "./postmark-usage"
import { readMaterializedSegmentMembers, refreshMaterializedSegment, segmentMembershipState, SegmentAudienceUnavailable } from "./segment-membership"
import { emitCommunicationsAudienceHoldAlert } from "../communications-job-alerts"

type KnexLike = any

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const now = () => new Date()

function dbFrom(container: MedusaContainer): KnexLike {
  return container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
}

function money(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateIso(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

async function postmarkUsageSummary(db: KnexLike) {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const monthlyLimit = resolvePostmarkMonthlyLimit()
  const [monthlyMessages, byPurpose] = await Promise.all([
    db("gp_message_log")
      .whereNull("deleted_at")
      .where("created_at", ">=", monthStart)
      .count({ count: "*" })
      .first(),
    db("gp_message_log")
      .whereNull("deleted_at")
      .where("created_at", ">=", monthStart)
      .select("message_purpose")
      .count({ count: "*" })
      .groupBy("message_purpose"),
  ])
  const sentThisMonth = Number(monthlyMessages?.count || 0)
  const usageRatio =
    monthlyLimit.configured && monthlyLimit.limit ? sentThisMonth / monthlyLimit.limit : null
  return {
    month_start: monthStart.toISOString(),
    sent_or_queued_this_month: sentThisMonth,
    configured_monthly_limit: monthlyLimit.limit,
    monthly_limit_configured: monthlyLimit.configured,
    configuration_warning: monthlyLimit.configuration_warning,
    configuration_error: monthlyLimit.configuration_error,
    usage_ratio: usageRatio,
    warning: monthlyLimit.configured && usageRatio !== null && usageRatio >= 0.8,
    by_purpose: byPurpose,
  }
}

export async function communicationOverview(container: MedusaContainer) {
  const db = dbFrom(container)
  await seedCommunicationDefaults(db)
  await seedEmailTemplates(db)

  const [
    profileCount,
    consentCount,
    smsConsentCount,
    messageCounts,
    recentMessages,
    flows,
    segments,
    campaigns,
    templates,
    queueHealth,
    reports,
    postmarkUsage,
  ] = await Promise.all([
    db("gp_customer_profile").whereNull("deleted_at").count({ count: "*" }).first(),
    db("gp_customer_profile")
      .whereNull("deleted_at")
      .where("email_consent", true)
      .count({ count: "*" })
      .first(),
    applySmsMarketingConsentWhere(
      db("gp_customer_profile").whereNull("deleted_at")
    )
      .count({ count: "*" })
      .first(),
    db("gp_message_log")
      .whereNull("deleted_at")
      .select("status")
      .count({ count: "*" })
      .groupBy("status"),
    db("gp_message_log")
      .whereNull("deleted_at")
      .select(
        "id",
        "email",
        "subject",
        "template_key",
        "message_stream",
        "message_purpose",
        "status",
        "sent_at",
        "created_at",
        "order_id",
        "campaign_id",
        "flow_key"
      )
      .orderBy("created_at", "desc")
      .limit(15),
    db("gp_communication_flow")
      .whereNull("deleted_at")
      .select(
        "id",
        "key",
        "name",
        "description",
        "status",
        "message_stream",
        "message_purpose",
        "trigger_event",
        "steps"
      )
      .orderBy("name", "asc"),
    db("gp_segment")
      .whereNull("deleted_at")
      .select("id", "key", "name", "description", "cached_count", "status")
      .orderBy("name", "asc"),
    db("gp_campaign")
      .whereNull("deleted_at")
      .select(
        "id",
        "name",
        "status",
        "subject",
        "segment_key",
        "sent_at",
        "scheduled_at",
        "metrics",
        "metadata"
      )
      .orderBy("created_at", "desc")
      .limit(10),
    listEmailTemplates(db),
    communicationQueueHealth(),
    communicationReporting(db, 30),
    postmarkUsageSummary(db),
  ])

  const statusCounts = Object.fromEntries(
    messageCounts.map((row: Record<string, any>) => [row.status, Number(row.count || 0)])
  )

  return {
    metrics: {
      profiles: Number(profileCount?.count || 0),
      consented: Number(consentCount?.count || 0),
      sms_consented: Number(smsConsentCount?.count || 0),
      messages_sent: statusCounts.sent || 0,
      messages_delivered: statusCounts.delivered || 0,
      messages_failed: statusCounts.failed || 0,
      messages_bounced: statusCounts.bounced || 0,
      active_flows: flows.filter((flow: any) => flow.status === "active").length,
      segments: segments.length,
      attributed_orders: reports.metrics.attributed_orders,
      attributed_revenue: reports.metrics.attributed_revenue,
      abandoned_carts: reports.metrics.abandoned_carts,
      recovered_carts: reports.metrics.recovered_carts,
    },
    recent_messages: recentMessages,
    flows,
    segments,
    campaigns,
    templates,
    queue: queueHealth,
    reports,
    postmark_usage: postmarkUsage,
  }
}

export async function searchCommunicationProfiles(
  container: MedusaContainer,
  input: { q?: string; limit?: number; offset?: number }
) {
  const db = dbFrom(container)
  const limit = Math.min(100, Math.max(1, Number(input.limit || 25)))
  const offset = Math.max(0, Number(input.offset || 0))
  const q = String(input.q || "").trim()
  let query = db("gp_customer_profile")
    .whereNull("deleted_at")
    .select(
      "id",
      "medusa_customer_id",
      "email",
      "first_name",
      "last_name",
      "customer_type",
      "route_market",
      "lifecycle_stage",
      "total_orders",
      "total_revenue",
      "last_order_at",
      "last_active_at",
      "email_consent",
      "preferences"
    )
    .orderBy("last_active_at", "desc")
    .limit(limit)
    .offset(offset)

  if (q) {
    query = query.andWhere((builder: any) => {
      builder
        .whereILike("email", `%${q}%`)
        .orWhereILike("first_name", `%${q}%`)
        .orWhereILike("last_name", `%${q}%`)
        .orWhereILike("medusa_customer_id", `%${q}%`)
    })
  }

  const profiles = await query
  return { profiles, limit, offset }
}

export async function communicationProfileTimeline(
  container: MedusaContainer,
  profileId: string
) {
  const db = dbFrom(container)
  const profile = await db("gp_customer_profile")
    .whereNull("deleted_at")
    .where("id", profileId)
    .first()
  if (!profile) return null

  const [events, messages, segments] = await Promise.all([
    db("gp_communication_event")
      .whereNull("deleted_at")
      .where("profile_id", profileId)
      .select("*")
      .orderBy("occurred_at", "desc")
      .limit(100),
    db("gp_message_log")
      .whereNull("deleted_at")
      .where("profile_id", profileId)
      .select("*")
      .orderBy("created_at", "desc")
      .limit(50),
    db("gp_segment_member")
      .leftJoin("gp_segment", "gp_segment_member.segment_id", "gp_segment.id")
      .whereNull("gp_segment_member.deleted_at")
      .whereNull("gp_segment_member.exited_at")
      .where("gp_segment_member.profile_id", profileId)
      .select(
        "gp_segment.key",
        "gp_segment.name",
        "gp_segment_member.entered_at"
      ),
  ])

  return { profile, events, messages, segments }
}

async function eventProfileIds(
  db: KnexLike,
  definition: Record<string, any>
): Promise<string[]> {
  const days = Number(definition.days || 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  if (definition.viewed_holiday) {
    const viewed = await db("gp_communication_event")
      .whereNull("deleted_at")
      .whereNotNull("profile_id")
      .where("event_name", "product_viewed")
      .where("occurred_at", ">=", since)
      .whereRaw("properties ->> 'holiday' = ?", [definition.viewed_holiday])
      .distinct("profile_id")

    const purchased = definition.not_purchased_holiday
      ? await db("gp_communication_event")
          .whereNull("deleted_at")
          .whereNotNull("profile_id")
          .where("event_name", "order_completed")
          .whereRaw("properties ->> 'holiday' = ?", [
            definition.not_purchased_holiday,
          ])
          .distinct("profile_id")
      : []

    const purchasedIds = new Set(
      purchased.map((row: Record<string, any>) => row.profile_id)
    )
    return viewed
      .map((row: Record<string, any>) => row.profile_id)
      .filter((profileId: string) => !purchasedIds.has(profileId))
  }

  if (definition.holiday) {
    const rows = await db("gp_communication_event")
      .whereNull("deleted_at")
      .whereNotNull("profile_id")
      .where("event_name", "order_completed")
      .where("occurred_at", ">=", since)
      .whereRaw("properties ->> 'holiday' = ?", [definition.holiday])
      .select("profile_id")
      .count({ count: "*" })
      .groupBy("profile_id")
      .havingRaw("count(*) >= ?", [Number(definition.min_orders || 1)])

    return rows.map((row: Record<string, any>) => row.profile_id)
  }

  if (!definition.event) return []

  const eventRows = await db("gp_communication_event")
    .whereNull("deleted_at")
    .whereNotNull("profile_id")
    .where("event_name", definition.event)
    .where("occurred_at", ">=", since)
    .distinct("profile_id")

  let profileIds = eventRows.map((row: Record<string, any>) => row.profile_id)

  if (definition.missing_event && profileIds.length) {
    const completionRows = await db("gp_communication_event")
      .whereNull("deleted_at")
      .whereNotNull("profile_id")
      .where("event_name", definition.missing_event)
      .where("occurred_at", ">=", since)
      .whereIn("profile_id", profileIds)
      .distinct("profile_id")

    const completed = new Set(
      completionRows.map((row: Record<string, any>) => row.profile_id)
    )
    profileIds = profileIds.filter((profileId: string) => !completed.has(profileId))
  }

  return profileIds
}

async function profilesForDefinition(
  db: KnexLike,
  definition: Record<string, any>,
  opts: { requireConsent?: boolean; limit?: number } = {}
) {
  let query = db("gp_customer_profile")
    .whereNull("deleted_at")
    .whereNotNull("email")

  if (opts.requireConsent !== false) {
    query = query.where("email_consent", true)
  }

  if (definition.customer_type) query = query.where("customer_type", definition.customer_type)
  if (definition.route_market) query = query.where("route_market", definition.route_market)
  if (Array.isArray(definition.route_market_in)) {
    query = query.whereIn("route_market", definition.route_market_in)
  }
  if (definition.lifecycle_stage) query = query.where("lifecycle_stage", definition.lifecycle_stage)
  if (definition.total_orders_gte) query = query.where("total_orders", ">=", definition.total_orders_gte)
  if (definition.total_orders) query = query.where("total_orders", definition.total_orders)
  if (definition.total_revenue_gte) query = query.where("total_revenue", ">=", definition.total_revenue_gte)
  if (definition.first_basket_size_lt) query = query.where("first_basket_size", "<", definition.first_basket_size_lt)
  if (definition.last_order_before_days) {
    query = query.where(
      "last_order_at",
      "<",
      new Date(Date.now() - Number(definition.last_order_before_days) * 24 * 60 * 60 * 1000)
    )
  }
  if (definition.last_order_within_days) {
    query = query.where(
      "last_order_at",
      ">=",
      new Date(Date.now() - Number(definition.last_order_within_days) * 24 * 60 * 60 * 1000)
    )
  }
  if (definition.holiday_buyer === true) query = query.where("holiday_buyer", true)
  if (definition.sms_consent === true) {
    query = applySmsMarketingConsentWhere(query)
  }
  if (definition.engagement_score_gte) {
    query = query.where("engagement_score", ">=", Number(definition.engagement_score_gte))
  }
  if (definition.min_total_orders) {
    query = query.where("total_orders", ">=", Number(definition.min_total_orders))
  }
  if (definition.min_total_revenue) {
    query = query.where("total_revenue", ">=", Number(definition.min_total_revenue))
  }
  if (definition.preferred_delivery_zone) {
    query = query.where("preferred_delivery_zone", definition.preferred_delivery_zone)
  }
  // JSON-array membership predicates: preferred_cuts / preferred_kosher_types
  // hold arrays like ["brisket","chicken"] populated by the import
  // enrichment. Postgres jsonb `?|` = "contains any of these strings".
  if (Array.isArray(definition.preferred_cuts_any) && definition.preferred_cuts_any.length) {
    query = query.whereRaw("preferred_cuts::jsonb \\?| ?::text[]", [
      definition.preferred_cuts_any.map(String),
    ])
  }
  if (
    Array.isArray(definition.preferred_kosher_types_any) &&
    definition.preferred_kosher_types_any.length
  ) {
    query = query.whereRaw("preferred_kosher_types::jsonb \\?| ?::text[]", [
      definition.preferred_kosher_types_any.map(String),
    ])
  }
  if (
    definition.event ||
    definition.holiday ||
    definition.viewed_holiday ||
    definition.not_purchased_holiday
  ) {
    const profileIds = await eventProfileIds(db, definition)
    query = query.whereIn("id", profileIds.length ? profileIds : ["__none__"])
  }

  return query.limit(opts.limit || audienceLimit() + 1)
}

/**
 * Hard ceiling on a single campaign audience. Audience queries fetch
 * limit+1 rows so sendCampaign can DETECT overflow and fail closed —
 * silently sending to a truncated list would mean the Slack approver
 * approves a number smaller than the real segment and the tail of the
 * audience never hears from us, with no error anywhere.
 */
export function audienceLimit() {
  const limit = Number(process.env.COMMS_MAX_AUDIENCE || 50000)
  return Number.isFinite(limit) && limit > 0 ? limit : 50000
}

async function audienceForSegment(db: KnexLike, segmentKey?: string | null) {
  const overfetch = audienceLimit() + 1
  if (!segmentKey) {
    return profilesForDefinition(db, {}, { requireConsent: true, limit: overfetch })
  }

  const segment = await db("gp_segment")
    .whereNull("deleted_at")
    .where("key", segmentKey)
    .first()

  if (!segment || segment.status !== "active") throw new SegmentAudienceUnavailable("inactive")

  // ClickHouse-sourced segments send to their MATERIALIZED membership
  // (refreshed by the runner) joined against consent — never a live
  // warehouse query at send time.
  if (isClickHouseSegmentDefinition(segment.query_definition)) {
    const { profileIds } = await readMaterializedSegmentMembers(db, segment.id)
    return db("gp_customer_profile")
      .whereNull("gp_customer_profile.deleted_at")
      .whereIn("gp_customer_profile.id", profileIds)
      .where("gp_customer_profile.email_consent", true)
      .whereNotNull("gp_customer_profile.email")
      .select("gp_customer_profile.*")
      .limit(overfetch)
  }

  return profilesForDefinition(db, segment.query_definition || {}, {
    requireConsent: true,
    limit: overfetch,
  })
}

/**
 * SMS-reachable audience for a segment: same membership as email, but
 * gated on qualifying customer-originated v3 marketing consent. The number
 * captured at opt-in wins and must still match the active sending number.
 */
function preferencesObject(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

async function smsAudienceForSegment(db: KnexLike, segmentKey?: string | null) {
  const base = await audienceForSegment(db, segmentKey)
  // If the BASE fetch hit its overfetch ceiling, the SMS subset is an
  // arbitrary truncation of the real audience — the caller must fail
  // closed rather than silently text a partial list.
  const baseOverflow = base.length > audienceLimit()
  const audience = base
    .map((p: Record<string, any>) => ({
      ...p,
      sms_phone: p.phone || null,
    }))
    .filter(
      (p: Record<string, any>) =>
        Boolean(p.sms_phone) &&
        hasQualifyingSmsMarketingConsent(p, p.sms_phone)
    )
  return { audience, baseOverflow }
}

function interpolateSmsBody(
  body: string,
  profile: Record<string, any>,
  coupon?: string | null
) {
  // Function replacers: a first_name containing "$&" or "$1" must be
  // inserted literally, not treated as a replacement pattern.
  return body
    .replace(/\{\{\s*first_name\s*\}\}/g, () => profile.first_name || "there")
    .replace(/\{\{\s*email\s*\}\}/g, () => profile.email || "")
    .replace(/\{\{\s*coupon_code\s*\}\}/g, () => coupon || "")
}

function abVariantFor(recipientKey: string, campaignId: string): "a" | "b" {
  const hash = crypto.createHash("sha1").update(`${campaignId}:${recipientKey}`).digest()
  return hash[0] % 2 === 0 ? "a" : "b"
}

function couponCode(prefix: string): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  let suffix = ""
  const bytes = crypto.randomBytes(5)
  for (let i = 0; i < 5; i += 1) suffix += alphabet[bytes[i] % alphabet.length]
  return `${prefix}-${suffix}`
}

type CouponConfig = {
  kind: "percent" | "fixed"
  value: number
  expires_days?: number
  prefix?: string
}

function couponConfigOf(metadata: Record<string, any>): CouponConfig | null {
  const raw = metadata?.coupon
  if (!raw || typeof raw !== "object") return null
  const value = Number(raw.value)
  const kind = raw.kind === "fixed" ? "fixed" : "percent"
  if (!Number.isFinite(value) || value <= 0) return null
  if (kind === "percent" && value > 100) return null
  return {
    kind,
    value,
    expires_days: Number(raw.expires_days) > 0 ? Number(raw.expires_days) : 14,
    prefix:
      String(raw.prefix || "GP")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 10) || "GP",
  }
}

/**
 * Per-recipient unique coupon codes, bulk-created through Medusa's
 * promotion module (usage_limit 1 each) under one promotion campaign
 * that carries the expiry. Returns codes aligned to the audience array.
 */
async function generateCampaignCoupons(
  container: MedusaContainer,
  campaign: Record<string, any>,
  config: CouponConfig,
  count: number
): Promise<string[]> {
  const promotionModule = container.resolve(Modules.PROMOTION) as any
  const endsAt = new Date(
    Date.now() + (config.expires_days || 14) * 24 * 60 * 60 * 1000
  )
  const identifier = `gp-comms:${campaign.key || campaign.id}`
  let promoCampaignId: string | null = null
  try {
    const existing = await promotionModule.listCampaigns({
      campaign_identifier: identifier,
    })
    if (existing?.length) {
      promoCampaignId = existing[0].id
    } else {
      const created = await promotionModule.createCampaigns([
        {
          name: `GP Comms — ${campaign.name}`.slice(0, 120),
          campaign_identifier: identifier,
          ends_at: endsAt,
        },
      ])
      promoCampaignId = created?.[0]?.id || null
    }
  } catch {
    promoCampaignId = null
  }

  const codes: string[] = []
  const CHUNK = 200
  for (let offset = 0; offset < count; offset += CHUNK) {
    const size = Math.min(CHUNK, count - offset)
    const chunkCodes = Array.from({ length: size }, () =>
      couponCode(config.prefix || "GP")
    )
    await promotionModule.createPromotions(
      chunkCodes.map((code) => ({
        code,
        type: "standard",
        status: "active",
        ...(promoCampaignId ? { campaign_id: promoCampaignId } : {}),
        application_method: {
          type: config.kind === "fixed" ? "fixed" : "percentage",
          target_type: "order",
          value: config.value,
          currency_code: "usd",
          allocation: "across",
        },
      }))
    )
    codes.push(...chunkCodes)
  }
  return codes
}

async function sendSmsCampaign(
  container: MedusaContainer,
  db: KnexLike,
  campaign: Record<string, any>,
  opts: {
    test_email?: string | null
    test_phone?: string | null
    approved_by?: string | null
  }
) {
  const { sendTrackedSms } = await import("./sms.js")
  const metadata = campaign.metadata || {}
  const body = String(metadata.sms_body || "").trim()
  if (!body) {
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: 0,
      error: "sms_body_missing",
    }
  }
  if (!opts.test_phone && campaign.status === "sent") {
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: 0,
      already_sent: true,
    }
  }

  const resolved = opts.test_phone
    ? {
        audience: [
          { id: null, sms_phone: opts.test_phone, first_name: "", email: null },
        ],
        baseOverflow: false,
      }
    : await smsAudienceForSegment(db, campaign.segment_key)
  const audience = resolved.audience

  if (resolved.baseOverflow || audience.length > audienceLimit()) {
    await recordCommunicationEvent(db, {
      event_name: "campaign_audience_over_limit",
      campaign_id: campaign.id,
      source: "admin",
      properties: { segment_key: campaign.segment_key, limit: audienceLimit() },
    })
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: audience.length,
      error: "audience_exceeds_max",
    }
  }

  // Same two-person rule as email campaigns.
  if (
    campaignNeedsApproval({
      audienceCount: audience.length,
      approvedBy: opts.approved_by || campaign.approved_by,
      testEmail: opts.test_phone || null,
    })
  ) {
    await requestCampaignApproval(db, campaign, audience.length)
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: audience.length,
      pending_approval: true,
    }
  }

  // Same per-recipient coupon behavior as email campaigns.
  const couponConfig = couponConfigOf(metadata)
  let couponByRecipient: Record<string, string> = {}
  if (couponConfig && audience.length && !opts.test_phone) {
    const priorCodes = (metadata.coupon_codes || {}) as Record<string, string>
    const keyOf = (p: Record<string, any>) =>
      normalizeEmail(p.email) || String(p.sms_phone)
    const missing = audience.filter((p: Record<string, any>) => !priorCodes[keyOf(p)])
    let fresh: string[] = []
    if (missing.length) {
      fresh = await generateCampaignCoupons(container, campaign, couponConfig, missing.length)
    }
    couponByRecipient = { ...priorCodes }
    missing.forEach((p: Record<string, any>, i: number) => {
      couponByRecipient[keyOf(p)] = fresh[i]
    })
    if (missing.length) {
      await db("gp_campaign").where("id", campaign.id).update({
        metadata: { ...metadata, coupon_codes: couponByRecipient },
        updated_at: now(),
      })
    }
  }

  let sent = 0
  let skipped = 0
  let failed = 0
  for (const profile of audience) {
    const recipientCoupon =
      couponByRecipient[normalizeEmail(profile.email) || String(profile.sms_phone)] ||
      (opts.test_phone && couponConfig ? `${couponConfig.prefix || "GP"}-TEST1` : null)
    const result = await sendTrackedSms(container, {
      to: profile.sms_phone,
      body: interpolateSmsBody(body, profile, recipientCoupon),
      stream: "broadcast",
      purpose: "broadcast",
      template_key: campaign.template_key || "campaign-sms",
      topic: "promotions",
      campaign_id: campaign.id,
      profile_id: profile.id || null,
      idempotency_key: opts.test_phone
        ? `campaign-sms-test:${campaign.id}:${Date.now()}`
        : `campaign-sms:${campaign.id}:${profile.id || profile.sms_phone}`,
      staff_test: Boolean(opts.test_phone),
    })
    if (result.deferred) {
      const resumeAt = result.deferUntil || nextAllowedSendTime(new Date())
      await recordCommunicationEvent(db, {
        event_name: "campaign_deferred_blackout",
        campaign_id: campaign.id,
        source: "admin",
        properties: {
          channel: "sms",
          reason: result.error || "deferred",
          resume_at: resumeAt.toISOString(),
          sent_before_defer: sent,
        },
      })
      return {
        sent,
        skipped,
        failed,
        audience_count: audience.length,
        deferred: true,
        resume_at: resumeAt.toISOString(),
      }
    }
    if (result.ok && result.skipped) skipped += 1
    else if (result.ok) sent += 1
    else failed += 1
  }

  if (!opts.test_phone) {
    await db("gp_campaign").where("id", campaign.id).update({
      status: "sent",
      sent_at: now(),
      approved_by: opts.approved_by || campaign.approved_by,
      approved_at: campaign.approved_at || now(),
      metrics: { sent, skipped, failed },
      updated_at: now(),
    })
  }

  await recordCommunicationEvent(db, {
    event_name: opts.test_phone ? "campaign_test_sent" : "campaign_sent",
    campaign_id: campaign.id,
    source: "admin",
    properties: {
      channel: "sms",
      sent,
      skipped,
      failed,
      test_phone: opts.test_phone ? String(opts.test_phone).slice(-4) : null,
    },
  })

  return { sent, skipped, failed, audience_count: audience.length }
}

/** Predicate keys the console segment builder may use. */
export const SEGMENT_DEFINITION_KEYS = [
  "customer_type",
  "route_market",
  "lifecycle_stage",
  "email_consent",
  "sms_consent",
  "holiday_buyer",
  "last_order_within_days",
  "engagement_score_gte",
  "preferred_delivery_zone",
  "preferred_cuts_any",
  "preferred_kosher_types_any",
  "min_total_orders",
  "min_total_revenue",
] as const

export async function createOrUpdateSegment(
  container: MedusaContainer,
  input: {
    key?: string | null
    name: string
    description?: string | null
    definition: Record<string, any>
    created_by?: string | null
  }
) {
  const db = dbFrom(container)
  const key =
    (input.key || input.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || `segment_${Date.now()}`

  const definition: Record<string, any> = {}
  for (const allowed of SEGMENT_DEFINITION_KEYS) {
    if (input.definition?.[allowed] !== undefined && input.definition[allowed] !== null && input.definition[allowed] !== "") {
      definition[allowed] = input.definition[allowed]
    }
  }

  const existing = await db("gp_segment")
    .whereNull("deleted_at")
    .where("key", key)
    .first()

  if (existing && !(existing.metadata || {}).custom) {
    // Seeded GP-library segments are code-managed; a console segment whose
    // name slugifies to the same key must not silently overwrite one.
    throw new Error(
      `"${input.name}" collides with the built-in segment "${existing.name}" — pick a different name.`
    )
  }
  if (existing) {
    await db("gp_segment").where("id", existing.id).update({
      name: input.name,
      description: input.description || existing.description,
      query_definition: definition,
      metadata: {
        ...(existing.metadata || {}),
        custom: true,
        updated_by: input.created_by || null,
      },
      updated_at: now(),
    })
  } else {
    await db("gp_segment").insert({
      id: id("gpseg"),
      key,
      name: input.name,
      description: input.description || null,
      status: "active",
      query_definition: definition,
      metadata: { custom: true, created_by: input.created_by || null },
      created_at: now(),
      updated_at: now(),
    })
  }

  const refreshed = await refreshSegmentMembership(container)
  const segment = await db("gp_segment")
    .whereNull("deleted_at")
    .where("key", key)
    .first()
  return { segment, refreshed }
}

/** Dry-run a definition: audience count + a small sample, nothing persisted. */
export async function previewSegmentDefinition(
  container: MedusaContainer,
  definition: Record<string, any>
) {
  const db = dbFrom(container)
  const clean: Record<string, any> = {}
  for (const allowed of SEGMENT_DEFINITION_KEYS) {
    if (definition?.[allowed] !== undefined && definition[allowed] !== null && definition[allowed] !== "") {
      clean[allowed] = definition[allowed]
    }
  }
  const profiles = await profilesForDefinition(db, clean, {
    requireConsent: true,
    limit: audienceLimit() + 1,
  })
  const smsReachable = profiles.filter(
    (p: Record<string, any>) => {
      const smsPhone = p.phone
      return Boolean(smsPhone) && hasQualifyingSmsMarketingConsent(p, smsPhone)
    }
  ).length
  return {
    count: profiles.length,
    sms_reachable: smsReachable,
    sample: profiles.slice(0, 5).map((p: Record<string, any>) => ({
      email: p.email,
      first_name: p.first_name,
      last_name: p.last_name,
    })),
  }
}

export async function createCampaign(
  container: MedusaContainer,
  input: {
    name: string
    subject: string
    segment_key?: string | null
    body?: string | null
    intro?: string | null
    cta_label?: string | null
    cta_url?: string | null
    scheduled_at?: string | null
    /** A gp_email_template key (canvas-designed) to send instead of the simple builder. */
    template_key?: string | null
    /** Audit: who created the campaign (NOT an approval). */
    created_by?: string | null
    /** "email" (default) or "sms". */
    channel?: string | null
    /** SMS campaigns: the message body ({{first_name}} supported). */
    sms_body?: string | null
    /** A/B test: variant-B subject line (deterministic 50/50 split). */
    subject_b?: string | null
    /** Unique per-recipient coupon: {kind, value, expires_days, prefix}. */
    coupon?: Record<string, any> | null
  }
) {
  const db = dbFrom(container)
  const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null
  const row = {
    id: id("gpcamp"),
    key: input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name: input.name,
    subject: input.subject,
    segment_key: input.segment_key || null,
    template_key: input.template_key || "campaign-simple",
    status:
      scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? "scheduled" : "draft",
    scheduled_at:
      scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
    // Approval is ONLY ever written by the Slack approve flow — a client-
    // supplied value here would pre-satisfy the >500 two-person gate.
    approved_by: null,
    metadata: {
      intro: input.intro || "",
      body: input.body || "",
      cta_label: input.cta_label || "Shop now",
      cta_url: input.cta_url || "/us/store",
      created_by: input.created_by || null,
      channel: input.channel === "sms" ? "sms" : "email",
      sms_body: input.sms_body || null,
      subject_b: input.subject_b || null,
      coupon: input.coupon || null,
    },
    created_at: now(),
    updated_at: now(),
  }
  await db("gp_campaign").insert(row)
  if (row.scheduled_at) {
    await enqueueCampaignSend(row.id, {
      delay_ms: Math.max(0, row.scheduled_at.getTime() - Date.now()),
    })
  }
  return row
}

export async function sendCampaign(
  container: MedusaContainer,
  campaignId: string,
  opts: {
    test_email?: string | null
    test_phone?: string | null
    approved_by?: string | null
  } = {}
) {
  const db = dbFrom(container)
  const campaign = await db("gp_campaign")
    .whereNull("deleted_at")
    .where("id", campaignId)
    .first()
  if (!campaign) throw new Error("Campaign not found.")
  const isTest = Boolean(opts.test_email || opts.test_phone)
  const channel = (campaign.metadata || {}).channel === "sms" ? "sms" : "email"
  if (channel === "sms") {
    return sendSmsCampaign(container, db, campaign, opts)
  }
  if (!isTest && campaign.status === "sent") {
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: 0,
      already_sent: true,
    }
  }

  // Shabbat/Yom Tov blackout (platform rule): the whole campaign defers.
  // Returning `deferred` lets the queue worker re-enqueue at resume_at;
  // per-recipient idempotency keys make the resumed run pick up exactly
  // where a partially-sent run stopped.
  {
    const blackout = isInSendBlackout(new Date())
    if (blackout.blocked) {
      const resumeAt = blackout.until || nextAllowedSendTime(new Date())
      await recordCommunicationEvent(db, {
        event_name: "campaign_deferred_blackout",
        campaign_id: campaign.id,
        source: "admin",
        properties: {
          reason: blackout.reason || "shabbat_blackout",
          resume_at: resumeAt.toISOString(),
          test_email: opts.test_email || null,
        },
      })
      return {
        sent: 0,
        skipped: 0,
        failed: 0,
        audience_count: 0,
        deferred: true,
        resume_at: resumeAt.toISOString(),
      }
    }
  }

  const metadata = campaign.metadata || {}
  const audience = opts.test_email
    ? [{ email: opts.test_email, id: null, first_name: "" }]
    : await audienceForSegment(db, campaign.segment_key)

  // Fail CLOSED on audience overflow (queries overfetch limit+1 so this
  // is detectable). Sending a silently truncated list would let the
  // approver approve a smaller number than the real segment while the
  // tail never receives the campaign.
  if (audience.length > audienceLimit()) {
    await recordCommunicationEvent(db, {
      event_name: "campaign_audience_over_limit",
      campaign_id: campaign.id,
      source: "admin",
      properties: {
        segment_key: campaign.segment_key,
        limit: audienceLimit(),
      },
    })
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: audience.length,
      error: "audience_exceeds_max",
    }
  }

  // Two-person rule: audiences over the threshold need a Slack approval
  // (#decisions) before anything sends. The approve button re-enters this
  // function with opts.approved_by set, which passes the gate.
  if (
    campaignNeedsApproval({
      audienceCount: audience.length,
      approvedBy: opts.approved_by || campaign.approved_by,
      testEmail: opts.test_email,
    })
  ) {
    await requestCampaignApproval(db, campaign, audience.length)
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      audience_count: audience.length,
      pending_approval: true,
    }
  }

  const snapshot = audience.map((profile: Record<string, any>) => ({
    profile_id: profile.id || null,
    email: profile.email,
  }))

  // Canvas-designed campaigns reference a gp_email_template whose
  // html_body is the full compiled MJML document. Loaded ONCE per run;
  // per-recipient merge fields are interpolated below. Falls back to the
  // simple builder when no canvas template applies.
  let canvasTemplate: Record<string, any> | null = null
  if (campaign.template_key && campaign.template_key !== "campaign-simple") {
    canvasTemplate = await db("gp_email_template")
      .whereNull("deleted_at")
      .where("key", campaign.template_key)
      .whereNotNull("html_body")
      .first()
  }

  const mergeFields = (
    value: string,
    profile: Record<string, any>,
    coupon?: string | null
  ) =>
    value
      .replace(/\{\{\s*first_name\s*\}\}/g, () => profile.first_name || "there")
      .replace(/\{\{\s*email\s*\}\}/g, () => profile.email || "")
      .replace(/\{\{\s*coupon_code\s*\}\}/g, () => coupon || "")

  // Unique per-recipient coupon codes (usage_limit 1, campaign-level
  // expiry) — generated up front so a mid-run defer/resume reuses the
  // same recipient→code mapping via the snapshot below.
  const couponConfig = couponConfigOf(metadata)
  let couponByRecipient: Record<string, string> = {}
  if (couponConfig && audience.length) {
    const priorCodes = (metadata.coupon_codes || {}) as Record<string, string>
    const missing = audience.filter(
      (p: Record<string, any>) => !priorCodes[normalizeEmail(p.email)]
    )
    let fresh: string[] = []
    if (missing.length) {
      fresh = await generateCampaignCoupons(
        container,
        campaign,
        couponConfig,
        missing.length
      )
    }
    couponByRecipient = { ...priorCodes }
    missing.forEach((p: Record<string, any>, i: number) => {
      couponByRecipient[normalizeEmail(p.email)] = fresh[i]
    })
    if (missing.length && !opts.test_email) {
      await db("gp_campaign").where("id", campaign.id).update({
        metadata: { ...metadata, coupon_codes: couponByRecipient },
        updated_at: now(),
      })
    }
  }

  // A/B subject split: deterministic per recipient, recorded on the
  // message (experiment_context) so opens/clicks report by variant.
  const subjectB = String(metadata.subject_b || "").trim()
  const abActive = Boolean(subjectB)

  let sent = 0
  let skipped = 0
  let failed = 0
  let sentA = 0
  let sentB = 0
  for (const profile of audience) {
    const recipientCoupon =
      couponByRecipient[normalizeEmail(profile.email)] || null
    const variant: "a" | "b" = abActive
      ? abVariantFor(profile.id || normalizeEmail(profile.email), campaign.id)
      : "a"
    const effectiveSubject =
      variant === "b" && subjectB ? subjectB : campaign.subject
    const email = canvasTemplate
      ? {
          subject: mergeFields(effectiveSubject, profile, recipientCoupon),
          html: mergeFields(
            String(canvasTemplate.html_body),
            profile,
            recipientCoupon
          ),
          text:
            mergeFields(
              String(canvasTemplate.text_body || ""),
              profile,
              recipientCoupon
            ) ||
            `${effectiveSubject}\n\nView this email in a browser that supports HTML.`,
        }
      : buildSimpleMessageEmail({
          subject: mergeFields(effectiveSubject, profile, recipientCoupon),
          eyebrow: "Griller's Pride",
          heading: mergeFields(effectiveSubject, profile, recipientCoupon),
          intro: metadata.intro
            ? mergeFields(String(metadata.intro), profile, recipientCoupon)
            : undefined,
          paragraphs: String(metadata.body || "")
            .split(/\n{2,}/)
            .map((part) => mergeFields(part.trim(), profile, recipientCoupon))
            .filter(Boolean),
          ctaLabel: metadata.cta_label || "Shop now",
          ctaUrl: metadata.cta_url || "/us/store",
        })
    const result = await sendTrackedEmail(container, {
      to: profile.email,
      stream: "broadcast",
      purpose: "broadcast",
      template_key: campaign.template_key || "campaign-simple",
      subject: email.subject,
      html: email.html,
      text: email.text,
      topic: "promotions",
      campaign_id: campaign.id,
      profile_id: profile.id || null,
      medusa_customer_id: profile.medusa_customer_id || null,
      idempotency_key: opts.test_email
        ? `campaign-test:${campaign.id}:${normalizeEmail(profile.email)}:${Date.now()}`
        : `campaign:${campaign.id}:${normalizeEmail(profile.email)}`,
      // Explicit staff test to a typed address: consent/cap exempt,
      // suppression list + blackout still apply.
      staff_test: Boolean(opts.test_email),
      template_model: {
        first_name: profile.first_name || "",
        email: profile.email,
        ...(recipientCoupon ? { coupon_code: recipientCoupon } : {}),
      },
      metadata: {
        ...(abActive
          ? {
              experiment_context: {
                experiment: `campaign:${campaign.key || campaign.id}`,
                variant,
              },
              ab_variant: variant,
            }
          : {}),
        ...(recipientCoupon ? { coupon_code: recipientCoupon } : {}),
      },
    })
    if (result.deferred) {
      // Blackout began mid-run: stop here. Already-sent recipients are
      // protected by idempotency; the resumed run completes the rest.
      const resumeAt = result.deferUntil || nextAllowedSendTime(new Date())
      await recordCommunicationEvent(db, {
        event_name: "campaign_deferred_blackout",
        campaign_id: campaign.id,
        source: "admin",
        properties: {
          reason: "shabbat_blackout_midrun",
          resume_at: resumeAt.toISOString(),
          sent_before_defer: sent,
        },
      })
      return {
        sent,
        skipped,
        failed,
        audience_count: audience.length,
        deferred: true,
        resume_at: resumeAt.toISOString(),
      }
    }
    if (result.ok && result.skipped) skipped += 1
    else if (result.ok) {
      sent += 1
      if (abActive) {
        if (variant === "a") sentA += 1
        else sentB += 1
      }
    } else failed += 1
  }

  if (!opts.test_email) {
    await db("gp_campaign").where("id", campaign.id).update({
      status: "sent",
      sent_at: now(),
      approved_by: opts.approved_by || campaign.approved_by,
      approved_at: campaign.approved_at || now(),
      audience_snapshot: snapshot,
      metrics: {
        sent,
        skipped,
        failed,
        ...(abActive ? { sent_a: sentA, sent_b: sentB } : {}),
      },
      updated_at: now(),
    })
  }

  await recordCommunicationEvent(db, {
    event_name: opts.test_email ? "campaign_test_sent" : "campaign_sent",
    campaign_id: campaign.id,
    source: "admin",
    properties: { sent, skipped, failed, test_email: opts.test_email || null },
  })

  return { sent, skipped, failed, audience_count: audience.length }
}

export async function sendStaffMessage(
  container: MedusaContainer,
  input: {
    to: string
    subject: string
    heading?: string
    body: string
    stream?: CommunicationStream
    topic?: string
    order_id?: string | null
    profile_id?: string | null
    staff_actor_email?: string | null
  }
) {
  const email = buildSimpleMessageEmail({
    subject: input.subject,
    eyebrow: "Griller's Pride",
    heading: input.heading || input.subject,
    paragraphs: input.body
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean),
    ctaLabel: input.order_id ? "View order" : "Shop Griller's Pride",
    ctaUrl: input.order_id ? `/us/account/orders/details/${input.order_id}` : "/us/store",
  })

  return sendTrackedEmail(container, {
    to: input.to,
    stream: input.stream || "transactional",
    purpose:
      input.stream === "broadcast"
        ? "broadcast"
        : input.stream === "lifecycle"
        ? "marketing_1to1"
        : "service",
    template_key: "staff-message",
    subject: email.subject,
    html: email.html,
    text: email.text,
    topic: input.topic || "order_updates",
    order_id: input.order_id || null,
    profile_id: input.profile_id || null,
    idempotency_key: `staff-message:${normalizeEmail(input.to)}:${Date.now()}`,
    metadata: { staff_actor_email: input.staff_actor_email || null },
  })
}

export async function runCommunicationMaintenance(container: MedusaContainer) {
  const db = dbFrom(container)
  await seedCommunicationDefaults(db)
  await seedEmailTemplates(db)
  const carts = await expireInactiveCarts(container)
  const segments = await refreshSegmentMembership(container)
  // Calendar-anchored flows enroll AFTER segments refresh so a same-tick
  // "6 weeks before seder" fire sees today's membership.
  const calendarEnrollment = await enrollCalendarAnchoredFlows(db, container.resolve("logger"))
  const campaigns = await sendDueScheduledCampaigns(container)
  const sunset = await sunsetInactiveProfiles(db)
  const result = await runDueFlowEnrollments(container, 100)
  return { ...result, segments, carts, campaigns, calendarEnrollment, sunset }
}

/**
 * Sunset policy: a consented profile that received >= COMMS_SUNSET_MIN_SENDS
 * marketing emails over COMMS_SUNSET_DAYS with zero opens, zero clicks,
 * and zero orders gets a marketing suppression (reason sunset_policy).
 * Chronic non-openers poison deliverability for everyone else; the
 * suppression is reversible (resubscribe clears it) and consent itself
 * is left untouched. Capped per run so one pass never mass-suppresses.
 */
export async function sunsetInactiveProfiles(db: KnexLike) {
  if (process.env.COMMS_SUNSET_ENABLED === "false") {
    return { suppressed: 0, enabled: false }
  }
  const days = Math.max(30, Number(process.env.COMMS_SUNSET_DAYS || 180))
  const minSends = Math.max(3, Number(process.env.COMMS_SUNSET_MIN_SENDS || 8))
  const cap = Math.max(1, Number(process.env.COMMS_SUNSET_CAP_PER_RUN || 200))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const result = await db.raw(
    `
    select p.id, p.email, p.email_lower
    from gp_customer_profile p
    where p.deleted_at is null
      and p.email_consent = true
      and (
        select count(*) from gp_message_log m
        where m.deleted_at is null
          and m.email_lower = p.email_lower
          and (m.message_stream in ('broadcast','lifecycle')
               or m.message_purpose in ('broadcast','marketing_1to1'))
          and m.status in ('sent','delivered')
          and m.created_at >= :since
      ) >= :minSends
      and not exists (
        select 1 from gp_message_log m2
        where m2.deleted_at is null
          and m2.email_lower = p.email_lower
          and (m2.opened_at >= :since or m2.clicked_at >= :since)
      )
      and not exists (
        select 1 from gp_communication_event ev
        where ev.deleted_at is null
          and ev.profile_id = p.id
          and ev.event_name = 'order_completed'
          and ev.occurred_at >= :since
      )
      and not exists (
        select 1 from gp_suppression_preference sp
        where sp.deleted_at is null
          and sp.email_lower = p.email_lower
          and sp.resubscribed_at is null
      )
    limit :cap
    `,
    { since, minSends, cap }
  )
  const candidates: Array<Record<string, any>> = result?.rows || []

  let suppressed = 0
  for (const candidate of candidates) {
    await recordSuppression(db, {
      email: candidate.email,
      scope: "marketing",
      reason: "sunset_policy",
      source: "sunset_policy",
      metadata: { days, min_sends: minSends },
    })
    await recordCommunicationEvent(db, {
      event_name: "profile_sunset",
      profile_id: candidate.id,
      email: candidate.email,
      source: "sunset_policy",
      properties: { days, min_sends: minSends },
    })
    suppressed += 1
  }
  return { suppressed, enabled: true, window_days: days, min_sends: minSends }
}

export async function communicationReports(container: MedusaContainer, days = 30) {
  return communicationReporting(dbFrom(container), days)
}

export async function communicationTemplates(container: MedusaContainer) {
  return { templates: await listEmailTemplates(dbFrom(container)) }
}

/**
 * Upsert a canvas-designed template (GrapesJS/MJML from the staff
 * console). Keyed by `key`; the MJML source rides in metadata so the
 * editor can reopen and keep editing, while html_body is the compiled
 * document the send path uses. Versions bump on every save.
 */
export async function saveCanvasTemplate(
  container: MedusaContainer,
  input: {
    key: string
    name: string
    subject: string
    preheader?: string | null
    html_body: string
    text_body?: string | null
    mjml_source?: string | null
    canvas_project?: unknown
    message_stream?: string
    saved_by?: string | null
  }
) {
  const db = dbFrom(container)
  const key = String(input.key || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  if (!key) throw new Error("Template key is required.")
  if (!input.html_body || !input.html_body.trim()) {
    throw new Error("Template HTML is required.")
  }

  const existing = await db("gp_email_template")
    .whereNull("deleted_at")
    .where("key", key)
    .first()

  const metadata = {
    ...(existing?.metadata || {}),
    editor: "grapesjs-mjml",
    mjml_source: input.mjml_source || null,
    canvas_project: input.canvas_project ?? existing?.metadata?.canvas_project ?? null,
    saved_by: input.saved_by || null,
    saved_at: new Date().toISOString(),
  }

  if (existing) {
    await db("gp_email_template").where("id", existing.id).update({
      name: input.name,
      subject: input.subject,
      preheader: input.preheader || null,
      html_body: input.html_body,
      text_body: input.text_body || null,
      message_stream: input.message_stream || existing.message_stream || "broadcast",
      version: Number(existing.version || 1) + 1,
      metadata,
      updated_at: now(),
    })
    return { key, id: existing.id, version: Number(existing.version || 1) + 1 }
  }

  const idValue = id("gptmpl")
  await db("gp_email_template").insert({
    id: idValue,
    key,
    name: input.name,
    subject: input.subject,
    preheader: input.preheader || null,
    html_body: input.html_body,
    text_body: input.text_body || null,
    message_stream: input.message_stream || "broadcast",
    message_purpose: "broadcast",
    consent_required: true,
    status: "active",
    version: 1,
    metadata,
    created_at: now(),
    updated_at: now(),
  })
  return { key, id: idValue, version: 1 }
}

export async function sendDueScheduledCampaigns(container: MedusaContainer) {
  const db = dbFrom(container)
  const due = await db("gp_campaign")
    .whereNull("deleted_at")
    .where("status", "scheduled")
    .where("scheduled_at", "<=", now())
    .orderBy("scheduled_at", "asc")
    .limit(25)

  const results: Array<Record<string, any>> = []
  for (const campaign of due) {
    results.push({
      campaign_id: campaign.id,
      ...(await sendCampaign(container, campaign.id)),
    })
  }

  return { processed: due.length, results }
}

export async function refreshProfileLifecycle(container: MedusaContainer) {
  const db = dbFrom(container)
  const profiles = await db("gp_customer_profile")
    .whereNull("deleted_at")
    .select("*")
    .limit(5000)

  let updated = 0
  for (const profile of profiles) {
    const totalOrders = money(profile.total_orders)
    const totalRevenue = money(profile.total_revenue)
    const lastOrderAt = profile.last_order_at ? new Date(profile.last_order_at) : null
    const daysSinceOrder = lastOrderAt
      ? (Date.now() - lastOrderAt.getTime()) / (24 * 60 * 60 * 1000)
      : null
    const previous = profile.lifecycle_stage
    let lifecycle = "lead"
    if (totalOrders <= 0) lifecycle = "lead"
    else if (totalOrders === 1 && daysSinceOrder !== null && daysSinceOrder <= 30) lifecycle = "new"
    else if (totalOrders >= 5 || totalRevenue >= 500) lifecycle = "loyal"
    else if (daysSinceOrder !== null && daysSinceOrder > 120) lifecycle = "churned"
    else if (daysSinceOrder !== null && daysSinceOrder > 60) lifecycle = "at_risk"
    else lifecycle = "active"

    const recencyScore =
      daysSinceOrder === null ? 0 : Math.max(0, Math.min(100, 100 - daysSinceOrder * (100 / 180)))
    const frequencyScore = Math.min(100, totalOrders * 10)
    const monetaryScore = Math.min(100, totalRevenue / 10)
    const engagementScore = Math.round(recencyScore * 0.3 + frequencyScore * 0.3 + monetaryScore * 0.2)

    if (previous !== lifecycle || Number(profile.engagement_score || 0) !== engagementScore) {
      await db("gp_customer_profile").where("id", profile.id).update({
        lifecycle_stage: lifecycle,
        engagement_score: engagementScore,
        updated_at: now(),
      })
      updated += 1
      if (previous !== lifecycle) {
        await recordCommunicationEvent(db, {
          event_name: "lifecycle_stage_changed",
          profile_id: profile.id,
          email: profile.email,
          properties: {
            previous_lifecycle_stage: previous,
            lifecycle_stage: lifecycle,
            last_order_at: dateIso(profile.last_order_at),
          },
        })
      }
    }
  }

  return { updated }
}

export async function refreshSegmentMembership(
  container: MedusaContainer,
  options: { onlyDue?: boolean } = {}
) {
  const db = dbFrom(container)
  await seedCommunicationDefaults(db)
  await seedGpSegmentLibrary(db)
  const segments = await db("gp_segment")
    .whereNull("deleted_at")
    .where("status", "active")
    .select("*")

  let refreshed = 0
  let unavailable = 0
  let activeMembers = 0
  let skipped = 0

  for (const segment of segments) {
    const state = segmentMembershipState(segment)
    // Refresh well before the 24-hour reader limit. A failed/missing receipt is
    // always due; old member rows never make that failure look successful.
    if (options.onlyDue && state.available &&
      Date.now() - Date.parse(state.receipt.completed_at) < 6 * 60 * 60 * 1000) {
      skipped += 1
      activeMembers += state.receipt.member_count
      continue
    }
    const result = await refreshMaterializedSegment(db, segment.id, async (trx, definition) => {
      if (isClickHouseSegmentDefinition(definition)) {
        return clickHouseSegmentProfileIds(trx, definition)
      }
      // Overfetch detects truncation; an incomplete audience is unavailable.
      const profiles = await profilesForDefinition(trx, definition, {
        requireConsent: false, limit: 10001,
      })
      return profiles.map((profile: Record<string, any>) => profile.id)
    })
    if (result.status === "available") {
      refreshed += 1
      activeMembers += result.member_count
    } else if (result.status === "unavailable") {
      unavailable += 1
    }
  }

  await emitCommunicationsAudienceHoldAlert({
    stage: "refresh", unavailable, evaluated: segments.length - skipped,
    logger: container.resolve("logger"),
  })
  return { refreshed, unavailable, active_members: activeMembers, skipped }
}
