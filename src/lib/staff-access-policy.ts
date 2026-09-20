/**
 * Staff authority is server-managed customer metadata. Store account routes
 * must reject writes to these fields before Medusa's customer workflows run.
 * Keep this inventory aligned with every role/capability consumer, including
 * legacy aliases still accepted by the storefront.
 */
export const STAFF_AUTHORITY_METADATA_KEYS = [
  "gp_staff_role", "staff_role", "role", "account_role", "is_staff", "staff",
  "gp_staff", "staff_access", "phone_order_staff", "staff_super_admin",
  "staff_access_revoked", "staff_access_updated_at", "final_charge_enabled",
  "can_charge_final_orders", "staff_final_charge_enabled", "catch_weight_charge_enabled",
] as const

const protectedKeys = new Set<string>(STAFF_AUTHORITY_METADATA_KEYS)

export function isStaffAuthorityMetadataKey(key: string): boolean {
  // Prefixes also reserve audit attribution, revocation generations and future
  // staff policy fields. A new staff field must not silently become self-editable.
  return protectedKeys.has(key) || key.startsWith("staff_") || key.startsWith("gp_staff_")
}

const trueValues = new Set(["1", "true", "yes", "y", "staff", "admin", "ops", "operator", "customer_service"])
export function staffFlagEnabled(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && trueValues.has(value.trim().toLowerCase()))
}

const officeRoles = new Set([
  "staff", "office", "manager", "admin", "ops", "operator", "customer_service",
  "customer-service", "phone_orders", "phone-orders", "super_admin", "super-admin", "owner",
])

// Compatibility only. #319 must replace email bootstrap with approved immutable
// identities and prove recovery/session invalidation before launch acceptance.
const bootstrapEmails = new Set([
  "aviswerdlow@gmail.com", "peterswerdlow@gmail.com", "peter@grillerspride.com",
])

/** Mirrors the office/customer-context capability, not merely "any staff". */
export function canManageCustomerPaymentMethods(customer: {
  email?: string | null
  metadata?: Record<string, unknown> | null
} | null): boolean {
  if (!customer) return false
  const metadata = customer.metadata || {}
  // Revocation always wins, including an otherwise bootstrapped owner.
  if (staffFlagEnabled(metadata.staff_access_revoked)) return false
  if (bootstrapEmails.has(String(customer.email || "").trim().toLowerCase())) return true
  const role = String(metadata.gp_staff_role || metadata.staff_role || metadata.role || metadata.account_role || "").trim().toLowerCase()
  // An explicit narrow/customer/unknown role cannot be upgraded by stale flags.
  if (role) return officeRoles.has(role)
  return [metadata.is_staff, metadata.staff, metadata.gp_staff, metadata.staff_access, metadata.phone_order_staff].some(staffFlagEnabled)
}
