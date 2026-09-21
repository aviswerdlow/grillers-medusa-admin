import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { clickHouseClient } from "./destinations"
import { getUpcomingHoliday } from "./hebrew-calendar"
import { SegmentAudienceUnavailable, segmentMembershipState } from "./segment-membership"

type KnexLike = any

/**
 * GP segment engine — the "butcher-grade segments" layer.
 *
 * Two evaluation sources coexist on gp_segment.query_definition:
 *
 *  1. PROFILE definitions (default): predicates over gp_customer_profile's
 *     first-class columns (RFM, cuts, kosher types, delivery zone,
 *     holiday_buyer…). These work from day one because the import pipeline
 *     (QuickBooks history + Constant Contact engagement) enriches profiles
 *     directly. Evaluated in admin.ts profilesForDefinition.
 *
 *  2. CLICKHOUSE definitions ({ source: "clickhouse", query_key, params }):
 *     NAMED queries from the registry below, run against the warehouse for
 *     post-launch behavioral segments (real-time engagement, on-site
 *     behavior). Only registry keys are executable — segment rows never
 *     carry raw SQL, so a compromised admin row can't inject into the
 *     warehouse.
 *
 * Membership for both sources materializes into gp_segment_member with
 * enter/exit semantics (same shape the campaign audience picker and the
 * flow triggers already read).
 */

export type ClickHouseSegmentQuery = {
  description: string
  /**
   * Must select `email_lower` (string). Optional `medusa_customer_id`.
   * Use {param} placeholders bound via query_params — never interpolate.
   */
  sql: (params: Record<string, unknown>) => {
    query: string
    query_params: Record<string, unknown>
  }
}

/** Pesach buying windows (seder-45d → seder+7d) for the last N years. */
function pesachWindows(years: number): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = []
  // Walk back from next Pesach: resolve each year's seder by asking for the
  // holiday from a date safely inside the prior year.
  let cursor = new Date()
  for (let i = 0; i < years; i++) {
    const pesach = getUpcomingHoliday("pesach", cursor)
    const seder = pesach.erev
    windows.push({
      from: iso(addDays(seder, -45)),
      to: iso(addDays(seder, 7)),
    })
    cursor = addDays(seder, -380)
  }
  return windows
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** DST-safe civil-day arithmetic. */
function addDays(d: Date, days: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + days)
  return c
}

export const CLICKHOUSE_SEGMENT_QUERIES: Record<string, ClickHouseSegmentQuery> = {
  engaged_recent: {
    description:
      "Opened or clicked any GP email in the trailing window (default 90d).",
    sql: (params) => ({
      query: `
        select distinct lower(JSONExtractString(properties, 'email')) as email_lower
        from gp_events
        where event_name in ('email_opened', 'email_clicked')
          and occurred_at >= now() - interval {days:UInt32} day
          and email_lower != ''
      `,
      query_params: { days: Number(params.days || 90) },
    }),
  },
  cart_active_no_order: {
    description:
      "Created or updated a cart in the window but placed no order since.",
    sql: (params) => ({
      query: `
        select email_lower from (
          select
            lower(JSONExtractString(properties, 'email')) as email_lower,
            maxIf(occurred_at, event_name like 'gp_cart%') as last_cart_at,
            maxIf(occurred_at, event_name = 'order_completed') as last_order_at
          from gp_events
          where occurred_at >= now() - interval {days:UInt32} day
          group by email_lower
        )
        where email_lower != ''
          and last_cart_at > last_order_at
      `,
      query_params: { days: Number(params.days || 14) },
    }),
  },
  pesach_window_orderers: {
    description:
      "Placed an order inside a Pesach buying window (warehouse era only — pre-launch history comes from the QBD profile enrichment instead).",
    sql: (params) => {
      const windows = pesachWindows(Number(params.years || 3))
      const clauses = windows
        .map(
          (_, i) =>
            `(toDate(occurred_at) between {from_${i}:Date} and {to_${i}:Date})`
        )
        .join(" or ")
      const query_params: Record<string, unknown> = {}
      windows.forEach((w, i) => {
        query_params[`from_${i}`] = w.from
        query_params[`to_${i}`] = w.to
      })
      return {
        query: `
          select distinct lower(JSONExtractString(properties, 'email')) as email_lower
          from gp_events
          where event_name = 'order_completed'
            and (${clauses})
            and lower(JSONExtractString(properties, 'email')) != ''
        `,
        query_params,
      }
    },
  },
}

export function isClickHouseSegmentDefinition(
  definition: Record<string, any> | null | undefined
): boolean {
  return Boolean(definition && definition.source === "clickhouse")
}

/**
 * Resolve a ClickHouse-sourced segment to profile ids. Identifiers come
 * back as email_lower and map onto existing profiles — the warehouse never
 * creates profiles (imports own that).
 */
export async function clickHouseSegmentProfileIds(
  db: KnexLike,
  definition: Record<string, any>
): Promise<string[]> {
  const key = String(definition.query_key || "")
  const registered = CLICKHOUSE_SEGMENT_QUERIES[key]
  if (!registered) {
    throw new Error(`Unknown clickhouse segment query_key: ${key}`)
  }
  const client = clickHouseClient()
  if (!client) throw new SegmentAudienceUnavailable("warehouse_not_configured")

  const { query, query_params } = registered.sql(definition.params || {})
  const result = await client.query({
    query,
    query_params,
    format: "JSONEachRow",
  })
  const rows = (await result.json()) as Array<{ email_lower?: string }>
  const emails = Array.from(
    new Set(
      rows
        .map((r) => String(r.email_lower || "").trim().toLowerCase())
        .filter(Boolean)
    )
  )
  if (!emails.length) return []

  const profiles: Array<{ id: string }> = await db("gp_customer_profile")
    .whereNull("deleted_at")
    .whereIn("email_lower", emails)
    .select("id")
  return profiles.map((p) => p.id)
}

/**
 * The GP segment library. Seeded idempotently (by key). Profile-sourced
 * definitions run on enriched columns from day one; ClickHouse-sourced
 * ones fill up as the warehouse accumulates real behavior.
 */
export const GP_SEGMENT_LIBRARY: Array<{
  key: string
  name: string
  description: string
  query_definition: Record<string, any>
}> = [
  {
    key: "pesach-buyers",
    name: "Pesach buyers",
    description:
      "Bought during a Passover season (QBD history via enrichment; holiday_buyer flag).",
    query_definition: { holiday_buyer: true },
  },
  {
    key: "kfp-kitchens",
    name: "KFP kitchens",
    description:
      "Customers whose purchase history shows Kosher-for-Passover preference.",
    query_definition: { preferred_kosher_types_any: ["kfp", "kosher_for_passover"] },
  },
  {
    key: "lapsed-whales",
    name: "Lapsed whales",
    description:
      "Lifetime revenue ≥ $750 with no order in 120+ days — the winback money list.",
    query_definition: { total_revenue_gte: 75000, last_order_before_days: 120 },
  },
  {
    key: "steakhouse-cuts",
    name: "Steakhouse cuts",
    description:
      "Buyers of premium cuts (ribeye, brisket, lamb) — specialty campaign audience.",
    query_definition: { preferred_cuts_any: ["ribeye", "brisket", "lamb", "steak"] },
  },
  {
    key: "poultry-staples",
    name: "Poultry staples",
    description: "Weeknight chicken buyers — volume + bundle audience.",
    query_definition: { preferred_cuts_any: ["chicken", "poultry"] },
  },
  {
    key: "atlanta-delivery",
    name: "Atlanta delivery zone",
    description: "Local metro customers (route market / delivery zone).",
    query_definition: { route_market_in: ["atlanta_metro"] },
  },
  {
    key: "corridor-southeast",
    name: "Southeast corridor",
    description: "Corridor states audience (NC push, SE delivery days).",
    query_definition: { route_market_in: ["southeast"] },
  },
  {
    key: "national-shippers",
    name: "National shippers",
    description: "UPS national customers — ship-cutoff + transit messaging.",
    query_definition: { route_market_in: ["national"] },
  },
  {
    key: "b2b-institutional",
    name: "B2B & institutional",
    description: "Shuls, schools, caterers — terms + pre-order lane.",
    query_definition: { customer_type: "institutional" },
  },
  {
    key: "first-order-only",
    name: "One order, never returned",
    description: "First-to-second-order conversion pool.",
    query_definition: { total_orders: 1, last_order_before_days: 21 },
  },
  {
    key: "engaged-90d",
    name: "Engaged last 90 days",
    description:
      "Opened/clicked recently (warehouse) — the warm list for domain warm-up.",
    query_definition: { source: "clickhouse", query_key: "engaged_recent", params: { days: 90 } },
  },
  {
    key: "cart-active-no-order",
    name: "Active cart, no order",
    description: "Recent carts without a completed order (warehouse).",
    query_definition: {
      source: "clickhouse",
      query_key: "cart_active_no_order",
      params: { days: 14 },
    },
  },
]

export async function seedGpSegmentLibrary(db: KnexLike) {
  for (const segment of GP_SEGMENT_LIBRARY) {
    const existing = await db("gp_segment")
      .whereNull("deleted_at")
      .where("key", segment.key)
      .first()
    if (existing) {
      // Keep operator edits to name/description; refresh the definition
      // only when it was never customized (metadata.custom flag).
      if (!existing.metadata?.custom) {
        await db("gp_segment").where("id", existing.id).update({
          query_definition: segment.query_definition,
          description: segment.description,
          updated_at: new Date(),
        })
      }
      continue
    }
    await db("gp_segment").insert({
      id: `gpseg_${Math.random().toString(36).slice(2, 12)}`,
      key: segment.key,
      name: segment.name,
      description: segment.description,
      query_definition: segment.query_definition,
      status: "active",
      cached_count: 0,
      metadata: { seeded: true, library_version: "gp-segments-v1" },
      created_at: new Date(),
      updated_at: new Date(),
    })
  }
}

export async function segmentEngineHealth(container: MedusaContainer) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as KnexLike
  const segments = await db("gp_segment")
    .whereNull("deleted_at")
    .select("key", "status", "cached_count", "last_computed_at", "metadata", "query_definition")
    .orderBy("key")
  return segments.map((segment: Record<string, any>) => {
    const { metadata, query_definition, ...summary } = segment
    const state = segmentMembershipState(segment)
    return { ...summary, membership_available: state.available, unavailable_reason: state.reason,
      last_refresh: state.receipt }
  })
}
