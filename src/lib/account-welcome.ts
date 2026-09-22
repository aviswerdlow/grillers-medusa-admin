import { randomUUID } from "node:crypto"
import {
  nativeSnapshotHash,
  type RequestMeasurementContext,
} from "./analytics/customer-measurement-context"
import { deliverNativeMeasurements } from "./native-measurement-delivery"
import type { DeliveryResult } from "./order-publication"

export const ACCOUNT_WELCOME_CONTEXT = "gp_account_welcome_context"
export const ACCOUNT_WELCOME_EVENT = "gp.account_welcome_captured"
export const ACCOUNT_WELCOME_SOURCE = "medusa-account-welcome-v1"
export type WelcomeLane = "production" | "rehearsal" | "unavailable"
export type WelcomeSource = {
  version: 1
  event_id: string
  event_name: "account_welcome_requested"
  request_id: string
  transaction_id: string
  occurred_at: string
  native_created_at: string
  lane: WelcomeLane
  context: RequestMeasurementContext | null
  customer: { id: string; email: string; first_name: string | null }
}
export type WelcomeHolder = {
  request_id: string
  lane: WelcomeLane
  context: RequestMeasurementContext | null
  customers: Array<{ customer: any; transaction_id: string }>
}
const email = (v: unknown) =>
  typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
    ? v.trim().toLowerCase()
    : null
const date = (v: any) =>
  v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null
export const welcomeKey = (id: string) => `customer-welcome:${id}`
/** Explicit handover: the legacy customer.created subscriber owns the default lane. */
export function accountWelcomeEnabled() {
  const value = process.env.GP_ACCOUNT_WELCOME_ENABLED?.trim()
  return value === "true"
}
export function welcomeServerLane(): WelcomeLane {
  const key = process.env.STRIPE_API_KEY || ""
  return key.startsWith("sk_live_")
    ? "production"
    : key.startsWith("sk_test_")
    ? "rehearsal"
    : "unavailable"
}

/** Capture native return data before refetch/response fields can change it. */
export function captureWelcomeCustomers(customers: any, execution: any) {
  // Retain the original even while sending is paused. Resume must not refetch it.
  if (!execution.transactionId) return
  let holder: WelcomeHolder
  try {
    holder = execution.container.resolve(ACCOUNT_WELCOME_CONTEXT)
  } catch {
    return
  }
  if (!holder?.request_id || !Array.isArray(holder.customers)) return
  for (const customer of Array.isArray(customers) ? customers : [customers]) {
    if (customer?.has_account !== true) continue
    const captured = {
      customer: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name ?? null,
        has_account: true,
        created_at: date(customer.created_at),
      },
      transaction_id: String(execution.transactionId),
    }
    if (
      !holder.customers.some(
        (existing) =>
          nativeSnapshotHash(existing) === nativeSnapshotHash(captured)
      )
    )
      holder.customers.push(captured)
  }
}

/** Release only after the outer registration/auth-link workflow succeeded. */
export function welcomeFromResponse(
  holder: WelcomeHolder,
  response: any,
  observedAt = new Date()
): WelcomeSource | null {
  if (!response?.customer || holder.customers.length !== 1) return null
  const { customer, transaction_id } = holder.customers[0]
  const recipient = email(customer?.email),
    created = date(customer?.created_at)
  if (
    !customer?.id ||
    !recipient ||
    !created ||
    !transaction_id ||
    !Number.isFinite(observedAt.getTime()) ||
    Date.parse(created) > observedAt.getTime()
  )
    return null
  if (
    response.customer.id !== undefined &&
    response.customer.id !== customer.id
  )
    return null
  return {
    version: 1,
    event_id: `native-account-welcome:${customer.id}`,
    event_name: "account_welcome_requested",
    request_id: holder.request_id,
    transaction_id,
    occurred_at: observedAt.toISOString(),
    native_created_at: created,
    lane: holder.lane,
    context: holder.context ? JSON.parse(JSON.stringify(holder.context)) : null,
    customer: {
      id: customer.id,
      email: recipient,
      first_name:
        typeof customer.first_name === "string" ? customer.first_name : null,
    },
  }
}

export function validWelcomeSource(s: any): s is WelcomeSource {
  return Boolean(
    s &&
      s.version === 1 &&
      s.event_name === "account_welcome_requested" &&
      typeof s.customer?.id === "string" &&
      s.customer.id &&
      s.event_id === `native-account-welcome:${s.customer.id}` &&
      email(s.customer.email) === s.customer.email &&
      s.customer.email &&
      (s.customer.first_name === null ||
        typeof s.customer.first_name === "string") &&
      typeof s.request_id === "string" &&
      s.request_id &&
      typeof s.transaction_id === "string" &&
      s.transaction_id &&
      date(s.occurred_at) === s.occurred_at &&
      date(s.native_created_at) === s.native_created_at &&
      Date.parse(s.native_created_at) <= Date.parse(s.occurred_at) &&
      ["production", "rehearsal", "unavailable"].includes(s.lane) &&
      (s.context === null ||
        (typeof s.context?.analytics_consent === "boolean" &&
          typeof s.context.test_order === "boolean" &&
          s.context.analytics_environment === s.lane &&
          s.context.test_order === (s.lane === "rehearsal") &&
          Number.isSafeInteger(s.context.analytics_consent_at) &&
          s.context.analytics_consent_at > 0 &&
          s.context.analytics_consent_at <= Date.parse(s.occurred_at) &&
          Array.isArray(s.context.experiment_assignments) &&
          ["complete", "unverified"].includes(
            s.context.experiment_context_status
          )))
  )
}
export function welcomeSourceFromRow(row: any): WelcomeSource | null {
  const snapshot = row?.context?.account_welcome_snapshot
  return row?.source === ACCOUNT_WELCOME_SOURCE &&
    validWelcomeSource(snapshot) &&
    row.event_id === snapshot.event_id &&
    row.event_name === snapshot.event_name &&
    row.context.account_welcome_hash === nativeSnapshotHash(snapshot)
    ? snapshot
    : null
}
export async function saveAccountWelcome(db: any, snapshot: WelcomeSource) {
  if (!validWelcomeSource(snapshot))
    throw new Error("account_welcome_source_invalid")
  const hash = nativeSnapshotHash(snapshot),
    now = new Date()
  await db("gp_communication_event")
    .insert({
      id: `gpcevt_${randomUUID()}`,
      event_id: snapshot.event_id,
      event_name: snapshot.event_name,
      source: ACCOUNT_WELCOME_SOURCE,
      occurred_at: snapshot.occurred_at,
      received_at: now,
      properties: {},
      context: {
        account_welcome_snapshot: snapshot,
        account_welcome_hash: hash,
      },
      created_at: now,
      updated_at: now,
    })
    .onConflict(db.raw('("event_id") where "deleted_at" is null'))
    .ignore()
  const saved = await db("gp_communication_event")
    .where({ event_id: snapshot.event_id })
    .whereNull("deleted_at")
    .first()
  if (
    !welcomeSourceFromRow(saved) ||
    saved.context.account_welcome_hash !== hash
  )
    throw new Error("account_welcome_source_conflict")
  return saved
}
export function welcomeMeasurementProperties(s: WelcomeSource | null) {
  return {
    ...(s?.context || {}),
    welcome_source_event_id: s?.event_id || null,
    original_account_source_valid: Boolean(s),
    analytics_consent: s?.context?.analytics_consent ?? null,
    test_event:
      s?.lane === "production" ? false : s?.lane === "rehearsal" ? true : null,
    analytics_environment: s?.lane || "unavailable",
    source_observed_at: s?.occurred_at || null,
    source_created_at: s?.native_created_at || null,
    experiment_context: s?.context?.experiment_assignments || [],
    experiment_context_status:
      s?.context?.experiment_context_status || "unverified",
  }
}
export function welcomeOutcomeTracking(metadata: any, templateKey?: string) {
  return metadata?.account_welcome_source_id ||
    templateKey === "customer-welcome"
    ? {
        source: "communications-account",
        context: {
          account_welcome_source_id:
            metadata?.account_welcome_source_id || null,
        },
      }
    : {}
}
export async function welcomeSendGuard(
  db: any,
  input: any,
  checkCurrentRecipient = true
): Promise<string | null> {
  if (!accountWelcomeEnabled())
    return "account_welcome_disabled"
  const row = await db("gp_communication_event")
    .where({ event_id: input.metadata?.account_welcome_source_id || "" })
    .whereNull("deleted_at")
    .first()
  const s = welcomeSourceFromRow(row)
  if (!s || s.lane !== "production" || welcomeServerLane() !== "production")
    return "original_account_source_not_production"
  if (
    input.template_key !== "customer-welcome" ||
    input.purpose !== "service" ||
    input.stream !== "transactional" ||
    input.staff_test ||
    input.medusa_customer_id !== s.customer.id ||
    email(input.to) !== s.customer.email ||
    input.idempotency_key !== welcomeKey(s.customer.id)
  )
    return "account_welcome_source_mismatch"
  if (!checkCurrentRecipient) return null
  const current = await db("customer")
    .where({ id: s.customer.id })
    .whereNull("deleted_at")
    .first()
  if (
    !current ||
    current.has_account !== true ||
    email(current.email) !== s.customer.email
  )
    return "account_welcome_recipient_changed"
  return null
}
export function deliverAccountWelcomes(
  db: any,
  deliver: (s: WelcomeSource, trx: any) => Promise<DeliveryResult>,
  now = new Date(),
  limit = 5
) {
  return deliverNativeMeasurements(
    db,
    {
      source: ACCOUNT_WELCOME_SOURCE,
      targets: ["account_welcome_email"],
      parse: welcomeSourceFromRow,
      hashKey: "account_welcome_hash",
      lockPrefix: "gp-account-welcome",
      errorPrefix: "account_welcome",
      productionPending: (s) => s.lane === "production",
    },
    (_target, s, _row, trx) => deliver(s, trx),
    now,
    limit
  )
}
