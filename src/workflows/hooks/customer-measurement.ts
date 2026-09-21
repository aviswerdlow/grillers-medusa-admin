import {
  createCustomersWorkflow,
  updateCustomersWorkflow,
} from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import {
  captureCustomerMeasurement,
  CUSTOMER_MEASUREMENT_CONTEXT,
  CUSTOMER_MEASUREMENT_EVENT,
} from "../../lib/analytics/customer-measurement-context"

export async function captureCustomerHook(
  kind: "created" | "updated",
  customers: any,
  execution: any
) {
  if (
    process.env.GP_CUSTOMER_MEASUREMENT_ENABLED !== "true" ||
    !execution.eventGroupId ||
    !execution.transactionId
  )
    return
  let context: any
  try {
    context = execution.container.resolve(CUSTOMER_MEASUREMENT_CONTEXT)
  } catch {
    return
  }
  const events = (Array.isArray(customers) ? customers : [customers])
    .map((customer) =>
      captureCustomerMeasurement(
        kind,
        customer,
        context,
        execution.transactionId
      )
    )
    .filter(Boolean)
    .map((data) => ({
      name: CUSTOMER_MEASUREMENT_EVENT,
      data,
      metadata: { eventGroupId: execution.eventGroupId },
    }))
  if (!events.length) return
  // A grouped event is released only on native workflow success. No network or
  // measurement persistence may make the account operation fail.
  try {
    await execution.container.resolve(Modules.EVENT_BUS).emit(events)
    return { eventGroupId: execution.eventGroupId }
  } catch {
    execution.container
      .resolve("logger")
      .warn("[customer-measurement] source notification unavailable")
  }
}

export async function compensateCustomerHook(data: any, execution: any) {
  if (data?.eventGroupId)
    await execution.container
      .resolve(Modules.EVENT_BUS)
      .clearGroupedEvents(data.eventGroupId, {
        eventNames: [CUSTOMER_MEASUREMENT_EVENT],
      })
}

createCustomersWorkflow.hooks.customersCreated(
  async ({ customers }, execution) =>
    new StepResponse(
      undefined,
      await captureCustomerHook("created", customers, execution)
    ),
  compensateCustomerHook
)
updateCustomersWorkflow.hooks.customersUpdated(
  async ({ customers }, execution) =>
    new StepResponse(
      undefined,
      await captureCustomerHook("updated", customers, execution)
    ),
  compensateCustomerHook
)
