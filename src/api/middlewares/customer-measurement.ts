import { asValue } from "awilix"
import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http"
import {
  CUSTOMER_MEASUREMENT_CONTEXT,
  MEASUREMENT_HEADER,
  customerMeasurementContext,
} from "../../lib/analytics/customer-measurement-context"

export function captureCustomerMeasurementRequest(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) {
  // Register on this request scope only. Do not put consent on the customer row
  // or a process-global variable where another request could inherit it.
  const headers = req.headers as any
  const context = customerMeasurementContext(
    headers[MEASUREMENT_HEADER] || headers.get?.(MEASUREMENT_HEADER)
  )
  req.scope.register({ [CUSTOMER_MEASUREMENT_CONTEXT]: asValue(context) })
  return next()
}
