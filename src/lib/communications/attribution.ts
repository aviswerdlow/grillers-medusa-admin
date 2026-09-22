import crypto from "crypto"

type KnexLike = any

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const now = () => new Date()

function money(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeEmail(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
}

function occurredAt(event: Record<string, any>) {
  const value = event.occurred_at || event.received_at || new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function revenueFromEvent(event: Record<string, any>) {
  const props = event.properties || {}
  return money(
    props.total ??
      props.revenue ??
      props.value ??
      props.amount_total ??
      props.amount ??
      props.subtotal
  )
}

async function findLastClick(db: KnexLike, event: Record<string, any>) {
  const cutoff = new Date(occurredAt(event).getTime() - 14 * 24 * 60 * 60 * 1000)
  const query = db("gp_link_click")
    .whereNull("gp_link_click.deleted_at")
    .leftJoin("gp_message_log", "gp_link_click.message_log_id", "gp_message_log.id")
    .select(
      "gp_link_click.*",
      "gp_message_log.flow_key as message_flow_key",
      "gp_message_log.cart_id as message_cart_id"
    )
    .where("gp_link_click.clicked_at", ">=", cutoff)
    .where("gp_link_click.clicked_at", "<=", occurredAt(event))
    .orderBy("gp_link_click.clicked_at", "desc")
    .limit(1)

  query.andWhere((builder: any) => {
    if (event.profile_id) builder.orWhere("gp_link_click.profile_id", event.profile_id)
    const email = normalizeEmail(event.email_lower || event.email)
    if (email) builder.orWhere("gp_link_click.email_lower", email)
    if (event.cart_id) builder.orWhere("gp_message_log.cart_id", event.cart_id)
  })

  return query.first()
}

async function findLastMessage(db: KnexLike, event: Record<string, any>) {
  const cutoff = new Date(occurredAt(event).getTime() - 14 * 24 * 60 * 60 * 1000)
  const query = db("gp_message_log")
    .whereNull("deleted_at")
    .whereIn("message_purpose", ["broadcast", "marketing_1to1"])
    .whereIn("status", ["sent", "delivered"])
    .where("sent_at", ">=", cutoff)
    .where("sent_at", "<=", occurredAt(event))
    .orderBy("sent_at", "desc")
    .limit(1)

  query.andWhere((builder: any) => {
    if (event.profile_id) builder.orWhere("profile_id", event.profile_id)
    const email = normalizeEmail(event.email_lower || event.email)
    if (email) builder.orWhere("email_lower", email)
    if (event.cart_id) builder.orWhere("cart_id", event.cart_id)
  })

  return query.first()
}

export async function attributeOrderFromEvent(
  db: KnexLike,
  event: Record<string, any>
) {
  if (event.event_name !== "order_completed" || !event.order_id) return null

  const existing = await db("gp_attribution")
    .whereNull("deleted_at")
    .where("order_id", event.order_id)
    .whereIn("attribution_type", ["last_click", "last_touch"])
    .first()
  if (existing) return existing

  const lastClick = await findLastClick(db, event)
  const fallbackMessage = lastClick ? null : await findLastMessage(db, event)
  const source = lastClick || fallbackMessage
  if (!source) return null

  const row = {
    id: id("gpattr"),
    profile_id: event.profile_id || source.profile_id || null,
    email_lower: normalizeEmail(event.email_lower || event.email) || source.email_lower || null,
    order_id: event.order_id,
    cart_id: event.cart_id || source.message_cart_id || source.cart_id || null,
    message_id: source.message_log_id || source.id || null,
    campaign_id: source.campaign_id || null,
    flow_id: source.flow_id || null,
    flow_key: source.message_flow_key || source.flow_key || null,
    template_key: source.template_key || null,
    source_event_id: event.event_id || null,
    attribution_type: lastClick ? "last_click" : "last_touch",
    attributed_revenue: revenueFromEvent(event),
    currency_code: event.properties?.currency_code || "usd",
    occurred_at: occurredAt(event),
    metadata: {
      order_event_id: event.event_id,
      source_kind: lastClick ? "click" : "message",
      source_id: source.id,
    },
    created_at: now(),
    updated_at: now(),
  }

  const inserted = await db("gp_attribution")
    .insert(row)
    .onConflict(db.raw('("order_id", "attribution_type") where "deleted_at" is null'))
    .ignore().returning("id")
  if (!inserted.length) return null

  if (row.campaign_id) {
    const campaign = await db("gp_campaign")
      .whereNull("deleted_at")
      .where("id", row.campaign_id)
      .forUpdate()
      .first()
    const metrics = campaign?.metrics || {}
    await db("gp_campaign").where("id", row.campaign_id).update({
      metrics: {
        ...metrics,
        attributed_orders: Number(metrics.attributed_orders || 0) + 1,
        attributed_revenue:
          Number(metrics.attributed_revenue || 0) + row.attributed_revenue,
      },
      updated_at: now(),
    })
  }

  return row
}

export async function attributionSummary(db: KnexLike, days = 30) {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000)
  const rows = await db("gp_attribution")
    .whereNull("deleted_at")
    .where("occurred_at", ">=", since)
    .select("campaign_id", "flow_key", "template_key")
    .sum({ revenue: "attributed_revenue" })
    .count({ orders: "*" })
    .groupBy("campaign_id", "flow_key", "template_key")
    .orderBy("revenue", "desc")
    .limit(25)

  const total = rows.reduce(
    (acc: Record<string, number>, row: Record<string, any>) => {
      acc.orders += Number(row.orders || 0)
      acc.revenue += Number(row.revenue || 0)
      return acc
    },
    { orders: 0, revenue: 0 }
  )

  return { days, total, rows }
}
