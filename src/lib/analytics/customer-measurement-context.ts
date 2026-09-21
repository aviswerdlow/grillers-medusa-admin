import { createHash } from "node:crypto"
import { acceptedExperimentContext } from "./accepted-experiment-context"

export const CUSTOMER_MEASUREMENT_CONTEXT = "gp_customer_measurement_context"
export const CUSTOMER_MEASUREMENT_EVENT = "gp.customer_measurement_captured"
export const CUSTOMER_MEASUREMENT_SOURCE = "medusa-native-customer-v1"
export const MEASUREMENT_HEADER = "x-gp-measurement-context"
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v)

export type CustomerMeasurementContext = {
  analytics_consent: true
  analytics_consent_at: number
  marketing_consent: boolean
  test_order: boolean
  analytics_environment: "production" | "rehearsal"
  rehearsal_id?: string
  anonymous_id?: string
  session_id?: string
  experiment_assignments: any[]
  experiment_context_status: "complete" | "unverified"
}
export type CustomerMeasurementSnapshot = {
  version: 1
  event_name: "customer_created" | "customer_updated"
  event_id: string
  customer_id: string
  transaction_id: string
  occurred_at: string
  context: CustomerMeasurementContext
}

/** The request supplies consent, never payment mode or native customer identity. */
export function customerMeasurementContext(
  header: unknown,
  now = Date.now()
): CustomerMeasurementContext | null {
  try {
    if (typeof header !== "string" || header.length > 12_000) return null
    const value = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
    if (
      !object(value) ||
      value.analytics_consent !== true ||
      typeof value.analytics_consent_at !== "number" ||
      !Number.isSafeInteger(value.analytics_consent_at) ||
      value.analytics_consent_at <= 0 ||
      value.analytics_consent_at > now ||
      typeof value.marketing_consent !== "boolean"
    )
      return null
    const key = process.env.STRIPE_API_KEY || ""
    const test = key.startsWith("sk_test_")
      ? true
      : key.startsWith("sk_live_")
      ? false
      : null
    if (
      test === null ||
      value.test_event !== test ||
      value.analytics_environment !== (test ? "rehearsal" : "production")
    )
      return null
    if (
      test &&
      (process.env.GP_ORDER_REHEARSAL_ENABLED !== "true" ||
        !/^[a-z][a-z0-9-]{2,47}$/.test(value.rehearsal_id || "") ||
        value.rehearsal_id !== process.env.GP_REHEARSAL_ID)
    )
      return null
    if (!test && value.rehearsal_id) return null
    const assignments = acceptedExperimentContext([
      {
        metadata: {
          experiment_context: value.experiment_context,
          experiment_context_status: value.experiment_context_status,
        },
      },
    ])
    return Object.freeze({
      analytics_consent: true,
      analytics_consent_at: value.analytics_consent_at,
      marketing_consent: value.marketing_consent,
      test_order: test,
      analytics_environment: test ? "rehearsal" : "production",
      ...(test ? { rehearsal_id: value.rehearsal_id } : {}),
      ...(uuid.test(value.anonymous_id || "")
        ? { anonymous_id: value.anonymous_id }
        : {}),
      ...(uuid.test(value.session_id || "")
        ? { session_id: value.session_id }
        : {}),
      ...assignments,
    })
  } catch {
    return null
  }
}

export function captureCustomerMeasurement(
  kind: "created" | "updated",
  customer: any,
  context: CustomerMeasurementContext | null,
  transactionId?: string
): CustomerMeasurementSnapshot | null {
  if (
    !context ||
    !transactionId ||
    !customer?.id ||
    typeof customer.id !== "string"
  )
    return null
  const occurred = new Date(
    kind === "created" ? customer.created_at : customer.updated_at
  )
  if (
    !Number.isFinite(occurred.getTime()) ||
    occurred.getTime() < context.analytics_consent_at
  )
    return null
  return {
    version: 1,
    event_name: `customer_${kind}`,
    event_id: `native-customer:${kind}:${customer.id}:${transactionId}`,
    customer_id: customer.id,
    transaction_id: transactionId,
    occurred_at: occurred.toISOString(),
    context: JSON.parse(JSON.stringify(context)),
  }
}

export function validCustomerSnapshot(
  value: any
): value is CustomerMeasurementSnapshot {
  const c = value?.context
  return (
    object(value) &&
    value.version === 1 &&
    ["customer_created", "customer_updated"].includes(value.event_name) &&
    typeof value.customer_id === "string" &&
    value.customer_id.length > 0 &&
    typeof value.transaction_id === "string" &&
    value.transaction_id.length > 0 &&
    value.event_id ===
      `native-customer:${value.event_name.slice(9)}:${value.customer_id}:${
        value.transaction_id
      }` &&
    Number.isFinite(Date.parse(value.occurred_at)) &&
    object(c) &&
    c.analytics_consent === true &&
    Number.isSafeInteger(c.analytics_consent_at) &&
    c.analytics_consent_at > 0 &&
    Date.parse(value.occurred_at) >= c.analytics_consent_at &&
    typeof c.marketing_consent === "boolean" &&
    typeof c.test_order === "boolean" &&
    c.analytics_environment === (c.test_order ? "rehearsal" : "production") &&
    (!c.test_order
      ? !c.rehearsal_id
      : /^[a-z][a-z0-9-]{2,47}$/.test(c.rehearsal_id || "")) &&
    ["complete", "unverified"].includes(c.experiment_context_status) &&
    Array.isArray(c.experiment_assignments)
  )
}

export function customerSnapshotHash(snapshot: CustomerMeasurementSnapshot) {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
  return createHash("sha256")
    .update(JSON.stringify(canonical(snapshot)))
    .digest("hex")
}
