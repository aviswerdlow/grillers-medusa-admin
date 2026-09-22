import { deliverNativeMeasurements } from "./native-measurement-delivery"
import { recordCommunicationEvent } from "./communications/core"
import {
  CUSTOMER_MEASUREMENT_SOURCE,
  customerSnapshotHash,
  validCustomerSnapshot,
  type CustomerMeasurementSnapshot,
} from "./analytics/customer-measurement-context"
import type { DeliveryResult } from "./order-publication"

export const CUSTOMER_TARGETS = [
  "native_customer_jitsu",
  "native_customer_gp",
  "native_customer_automation",
] as const
export type CustomerTarget = (typeof CUSTOMER_TARGETS)[number]

export async function saveCustomerMeasurement(
  db: any,
  snapshot: CustomerMeasurementSnapshot
) {
  if (!validCustomerSnapshot(snapshot))
    throw new Error("customer_measurement_source_invalid")
  await recordCommunicationEvent(
    db,
    {
      event_name: snapshot.event_name,
      event_id: snapshot.event_id,
      source: CUSTOMER_MEASUREMENT_SOURCE,
      medusa_customer_id: snapshot.customer_id,
      anonymous_id: snapshot.context.anonymous_id,
      session_id: snapshot.context.session_id,
      occurred_at: snapshot.occurred_at,
      properties: {
        ...snapshot.context,
        customer_id: snapshot.customer_id,
        test_event: snapshot.context.test_order,
        idempotency_key: snapshot.event_id,
        event_timestamp_ms: Date.parse(snapshot.occurred_at),
      },
      context: {
        native_customer_snapshot: snapshot,
        native_customer_hash: customerSnapshotHash(snapshot),
      },
    },
    { deferSideEffects: true }
  )
  // recordCommunicationEvent may race an insert; always use the actual winner.
  const saved = await db("gp_communication_event")
    .where({ event_id: snapshot.event_id })
    .whereNull("deleted_at")
    .first()
  if (
    saved?.source !== CUSTOMER_MEASUREMENT_SOURCE ||
    saved?.context?.native_customer_hash !== customerSnapshotHash(snapshot)
  )
    throw new Error("customer_measurement_source_conflict")
  return saved
}

export function customerSourceFromRow(
  row: any
): CustomerMeasurementSnapshot | null {
  const snapshot = row?.context?.native_customer_snapshot
  if (
    row?.source !== CUSTOMER_MEASUREMENT_SOURCE ||
    !validCustomerSnapshot(snapshot) ||
    row.event_id !== snapshot.event_id ||
    row.event_name !== snapshot.event_name ||
    row.context.native_customer_hash !== customerSnapshotHash(snapshot)
  )
    return null
  return snapshot
}

export function deliverCustomerMeasurements(
  db: any,
  deliver: (
    target: CustomerTarget,
    snapshot: CustomerMeasurementSnapshot,
    row: any,
    trx: any
  ) => Promise<DeliveryResult>,
  now = new Date(),
  limit = 5
) {
  return deliverNativeMeasurements(
    db,
    {
      source: CUSTOMER_MEASUREMENT_SOURCE,
      targets: CUSTOMER_TARGETS,
      parse: customerSourceFromRow,
      hashKey: "native_customer_hash",
      lockPrefix: "gp-native-customer",
      errorPrefix: "customer_measurement",
      productionPending: (snapshot) => !snapshot.context.test_order,
    },
    deliver,
    now,
    limit
  )
}
