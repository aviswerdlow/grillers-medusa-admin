import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

import {
  validateCreateCustomer,
  customerMetadataFromNormalized,
  type CreateCustomerInput,
} from "../../../../lib/gp-customer-create"
import { emitOpsAlert } from "../../../../lib/ops-alert"
import { verifiedStaffAuditFields } from "../../../../lib/staff-principal"

/**
 * #277 — staff "Create a customer account".
 *
 * The stock Medusa dashboard customer-create has no validation and surfaces failures (most
 * commonly a duplicate email) as a generic "An unexpected response was received from the
 * server." toast. This route enforces the rules Peter asked for and returns clean,
 * field-level errors so the form can show exactly what is wrong.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body || {}) as CreateCustomerInput
  const rawBody = body as CreateCustomerInput & Record<string, any>
  const requestedSmsConsent =
    rawBody.sms_marketing_opt_in === true ||
    rawBody.sms_marketing_opt_in === "true" ||
    rawBody.sms_marketing_opt_in === "on" ||
    rawBody.sms_consent === true ||
    rawBody.sms_consent === "true" ||
    rawBody.customer_agreed_to_sms === true
  if (requestedSmsConsent) {
    return res.status(400).json({
      type: "invalid_data",
      message:
        "Staff cannot create SMS marketing consent. The customer must use the unchecked customer opt-in form themselves.",
      errors: {
        sms_consent: "Only the customer can provide SMS marketing consent.",
      },
    })
  }
  const result = validateCreateCustomer(body)

  if (!result.valid) {
    return res.status(400).json({
      type: "invalid_data",
      message: "Please correct the highlighted fields.",
      errors: result.errors,
    })
  }

  const { normalized } = result
  const customerModule = req.scope.resolve(Modules.CUSTOMER) as any
  const logger = req.scope.resolve("logger") as
    | { error?: (msg: string) => void; info?: (msg: string) => void }
    | undefined

  try {
    // Duplicate-email guard. A second customer with an existing email is the most likely
    // cause of the generic server error today; return a clear 409 instead.
    const existing = await customerModule.listCustomers(
      { email: normalized.email },
      { take: 1, select: ["id", "email"] }
    )
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(409).json({
        type: "duplicate_error",
        message: `A customer with the email ${normalized.email} already exists.`,
        errors: { email: "A customer with this email already exists." },
        existing_customer_id: existing[0]?.id,
      })
    }

    const created = await customerModule.createCustomers({
      email: normalized.email,
      first_name: normalized.first_name,
      last_name: normalized.last_name,
      phone: normalized.phone,
      company_name: normalized.company_name,
      has_account: false,
      metadata: { ...customerMetadataFromNormalized(normalized),
        staff_audit_log: JSON.stringify([{ action: "staff_customer_create", at: new Date().toISOString(), ...verifiedStaffAuditFields(req) }]) },
    })

    const customer = Array.isArray(created) ? created[0] : created

    if (normalized.address && customer?.id) {
      await customerModule.createCustomerAddresses([
        {
          customer_id: customer.id,
          address_name: "Ship-to",
          ...normalized.address,
          is_default_shipping: true,
          is_default_billing: true,
          metadata: { gp_created_via: "staff_create_customer" },
        },
      ])
    }

    logger?.info?.(
      `[create-customer] created customer ${customer?.id} (${normalized.customer_code})`
    )

    return res.status(201).json({
      customer: {
        id: customer?.id,
        email: customer?.email,
        first_name: customer?.first_name,
        last_name: customer?.last_name,
        phone: customer?.phone,
        company_name: customer?.company_name,
      },
      customer_code: normalized.customer_code,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Keep the full detail server-side only; do not echo DB/ORM internals to the browser.
    logger?.error?.(`[create-customer] failed: ${message}`)
    await emitOpsAlert({
      alertKind: "staff_customer_create_error",
      severity: "page",
      path: "admin/grillers/customers",
      title: "Staff customer creation failed",
      fingerprint: "staff_customer_create:500",
      meta: {
        email_domain: normalized.email.split("@")[1] || "",
        has_company_name: Boolean(normalized.company_name),
        has_address: Boolean(normalized.address),
        error_name: err instanceof Error ? err.name : undefined,
        error_message: message.slice(0, 300),
      },
      logger: logger as any,
    })
    // Never let this fall through to the dashboard's generic error toast.
    return res.status(500).json({
      type: "server_error",
      message:
        "Could not create the customer due to an internal error. Please try again or contact support.",
    })
  }
}
