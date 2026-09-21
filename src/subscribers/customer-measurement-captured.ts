import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  CUSTOMER_MEASUREMENT_EVENT,
  type CustomerMeasurementSnapshot,
} from "../lib/analytics/customer-measurement-context"
import { saveCustomerMeasurement } from "../lib/customer-measurement"

export default async function customerMeasurementCaptured({
  event: { data },
  container,
}: SubscriberArgs<CustomerMeasurementSnapshot>) {
  // Persist even if delivery was disabled after native workflow completion.
  // Throw on persistence failure so the event bus retains its retry semantics.
  await saveCustomerMeasurement(
    container.resolve(ContainerRegistrationKeys.PG_CONNECTION),
    data
  )
}
export const config: SubscriberConfig = { event: CUSTOMER_MEASUREMENT_EVENT }
