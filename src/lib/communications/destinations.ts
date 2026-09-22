import crypto from "crypto"
import { createClient } from "@clickhouse/client"
import { emitOpsAlert } from "../ops-alert"

type KnexLike = any

function excludedCartMeasurement(event: Record<string, any>) {
  const p = event.properties || {}
  if (event.source === "medusa-account-welcome-v1") return true
  if (event.source === "communications-account") return p.original_account_source_valid !== true ||
    p.analytics_consent !== true || p.test_event !== false || p.analytics_environment !== "production"
  return event.source === "communications-cart" && (p.original_cart_source_valid !== true ||
    p.analytics_consent !== true || p.test_event !== false || p.analytics_environment !== "production")
}

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const ALERT_PATH = "src/lib/communications/destinations.ts"
const ALERTED_EVENT_NAMES = new Set([
  "checkout_started",
  "shipping_info_submitted",
  "payment_info_submitted",
  "product_added_to_cart",
  "order_received",
  "order_completed",
  "order_refunded",
  "email_signup",
  "email_sent",
  "email_failed",
  "email_clicked",
  "gp_abandon_email_sent",
  "flow_step_failed",
])

function hasClickHouseConfig() {
  return Boolean(process.env.CLICKHOUSE_URL)
}

export function clickHouseClient() {
  if (!hasClickHouseConfig()) return null
  return createClient({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USERNAME || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: process.env.CLICKHOUSE_DATABASE || "default",
  })
}

function json(value: unknown) {
  try {
    return JSON.stringify(value || {})
  } catch {
    return "{}"
  }
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "")
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 500)
}

function shouldAlertDestinationFailure(event: Record<string, any>): boolean {
  const eventName = String(event.event_name || "")
  return Boolean(
    ALERTED_EVENT_NAMES.has(eventName) ||
      event.order_id ||
      event.cart_id ||
      event.campaign_id ||
      event.flow_id ||
      event.template_key
  )
}

function emitDestinationDeliveryFailureAlert(
  target: string,
  event: Record<string, any>,
  error: unknown
) {
  if (!shouldAlertDestinationFailure(event)) return

  const eventName = String(event.event_name || "unknown")
  void emitOpsAlert({
    alertKind: "communications_destination_delivery_failed",
    severity: "warn",
    title: `Communications ${target} delivery failed for ${eventName}`,
    path: ALERT_PATH,
    source: "medusa-server",
    meta: {
      destination: target,
      event_id: event.event_id || null,
      event_name: eventName,
      event_source: event.source || null,
      order_id: event.order_id || null,
      cart_id: event.cart_id || null,
      campaign_id: event.campaign_id || null,
      flow_id: event.flow_id || null,
      template_key: event.template_key || null,
      message_id: event.message_id || null,
      has_profile_id: Boolean(event.profile_id),
      has_medusa_customer_id: Boolean(event.medusa_customer_id),
      error: redactedErrorMessage(error),
    },
  })
}

async function delivery(
  db: KnexLike,
  event: Record<string, any>,
  target: string,
  status: "delivered" | "failed" | "skipped",
  metadata: Record<string, any> = {},
  error?: string
) {
  const now = new Date()
  const row = {
    id: id("gpedlv"),
    event_id: event.event_id,
    event_name: event.event_name,
    target,
    status,
    attempts: 1,
    last_attempt_at: now,
    delivered_at: status === "delivered" ? now : null,
    error_message: error || null,
    metadata,
    created_at: now,
    updated_at: now,
  }
  try {
    await db("gp_event_delivery")
      .insert(row)
      .onConflict(db.raw('("event_id", "target") where "deleted_at" is null'))
      .merge({
        status,
        attempts: db.raw("gp_event_delivery.attempts + 1"),
        last_attempt_at: now,
        delivered_at: status === "delivered" ? now : null,
        error_message: error || null,
        metadata,
        updated_at: now,
      })
  } catch {
    // Delivery bookkeeping is secondary to event capture.
  }
}

export async function ensureClickHouseSchema() {
  const client = clickHouseClient()
  if (!client) return { configured: false }

  await client.command({
    query: `
      create table if not exists gp_events (
        event_id String,
        event_name LowCardinality(String),
        source LowCardinality(String),
        profile_id String,
        anonymous_id String,
        session_id String,
        cart_id String,
        order_id String,
        email_hash String,
        customer_type LowCardinality(String),
        route_market LowCardinality(String),
        campaign_id String,
        flow_id String,
        template_key String,
        occurred_at DateTime64(3),
        received_at DateTime64(3),
        properties String,
        context String
      )
      engine = MergeTree
      order by (event_name, occurred_at, event_id)
    `,
  })

  await client.command({
    query: `
      create materialized view if not exists gp_events_daily
      engine = SummingMergeTree
      order by (day, event_name, source)
      as select
        toDate(occurred_at) as day,
        event_name,
        source,
        count() as events
      from gp_events
      group by day, event_name, source
    `,
  })

  await client.command({
    query: `
      create materialized view if not exists gp_campaign_revenue_daily
      engine = SummingMergeTree
      order by (day, campaign_id, flow_id)
      as select
        toDate(occurred_at) as day,
        campaign_id,
        flow_id,
        countIf(event_name = 'email_clicked') as clicks,
        countIf(event_name = 'order_completed') as orders
      from gp_events
      where campaign_id != '' or flow_id != ''
      group by day, campaign_id, flow_id
    `,
  })

  return { configured: true }
}

export async function writeEventToClickHouse(
  db: KnexLike,
  event: Record<string, any>
) {
  if (excludedCartMeasurement(event)) {
    await delivery(db, event, "clickhouse", "skipped", { reason: "original_cart_measurement_not_permitted" })
    return false
  }
  const client = clickHouseClient()
  if (!client) {
    await delivery(db, event, "clickhouse", "skipped", { reason: "not_configured" })
    return false
  }

  try {
    await ensureClickHouseSchema()
    const email = String(event.email_lower || event.email || "")
    await client.insert({
      table: "gp_events",
      format: "JSONEachRow",
      values: [
        {
          event_id: event.event_id || "",
          event_name: event.event_name || "",
          source: event.source || "",
          profile_id: event.profile_id || "",
          anonymous_id: event.anonymous_id || "",
          session_id: event.session_id || "",
          cart_id: event.cart_id || "",
          order_id: event.order_id || "",
          email_hash: email
            ? crypto.createHash("sha256").update(email).digest("hex")
            : "",
          customer_type: event.customer_type || "unknown",
          route_market: event.route_market || "unknown",
          campaign_id: event.campaign_id || "",
          flow_id: event.flow_id || "",
          template_key: event.template_key || "",
          occurred_at: event.occurred_at || new Date(),
          received_at: event.received_at || new Date(),
          properties: json(event.properties),
          context: json(event.context),
        },
      ],
    })
    await delivery(db, event, "clickhouse", "delivered")
    return true
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await delivery(
      db,
      event,
      "clickhouse",
      "failed",
      {},
      error
    )
    emitDestinationDeliveryFailureAlert("clickhouse", event, error)
    return false
  }
}

function ga4Configured() {
  return Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET)
}

function ga4ClientId(event: Record<string, any>) {
  return (
    event.anonymous_id ||
    event.session_id ||
    event.profile_id ||
    crypto.createHash("sha256").update(event.email_lower || event.email || "gp").digest("hex")
  )
}

function ga4Name(eventName: string) {
  const mapping: Record<string, string> = {
    page_viewed: "page_view",
    product_viewed: "view_item",
    product_added_to_cart: "add_to_cart",
    cart_viewed: "view_cart",
    checkout_started: "begin_checkout",
    shipping_info_submitted: "add_shipping_info",
    payment_info_submitted: "add_payment_info",
    order_completed: "purchase",
    email_signup: "sign_up",
    email_clicked: "select_content",
  }
  return mapping[eventName] || eventName
}

export async function writeEventToGa4(
  db: KnexLike,
  event: Record<string, any>
) {
  if (excludedCartMeasurement(event)) {
    await delivery(db, event, "ga4", "skipped", { reason: "original_cart_measurement_not_permitted" })
    return false
  }
  if (!ga4Configured()) {
    await delivery(db, event, "ga4", "skipped", { reason: "not_configured" })
    return false
  }

  const url = new URL("https://www.google-analytics.com/mp/collect")
  url.searchParams.set("measurement_id", process.env.GA4_MEASUREMENT_ID || "")
  url.searchParams.set("api_secret", process.env.GA4_API_SECRET || "")

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: ga4ClientId(event),
        user_id: event.medusa_customer_id || event.profile_id || undefined,
        events: [
          {
            name: ga4Name(event.event_name),
            params: {
              event_id: event.event_id,
              source: event.source,
              cart_id: event.cart_id,
              transaction_id: event.order_id,
              campaign_id: event.campaign_id,
              flow_id: event.flow_id,
              template_key: event.template_key,
              customer_type: event.customer_type,
              route_market: event.route_market,
              ...(event.properties || {}),
            },
          },
        ],
      }),
    })
    if (!response.ok) {
      throw new Error(`GA4 ${response.status}: ${await response.text()}`)
    }
    await delivery(db, event, "ga4", "delivered")
    return true
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await delivery(
      db,
      event,
      "ga4",
      "failed",
      {},
      error
    )
    emitDestinationDeliveryFailureAlert("ga4", event, error)
    return false
  }
}

export async function writeEventDestinations(
  db: KnexLike,
  event: Record<string, any>
) {
  await Promise.all([
    writeEventToClickHouse(db, event),
    writeEventToGa4(db, event),
  ])
}
