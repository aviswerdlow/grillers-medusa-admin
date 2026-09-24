import { staffBoundaryMode } from "./staff-boundary-rollout"
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
const billingAuthorityKeys = new Set(["gp_offline_payment_approved", "gp_offline_methods", "gp_credit_limit", "gp_payment_terms", "gp_invoice_application_status", "gp_invoice_application_decided_by", "gp_invoice_application_decided_at"])

export function isStaffAuthorityMetadataKey(key: string): boolean {
  // Prefixes also reserve audit attribution, revocation generations and future
  // staff policy fields. A new staff field must not silently become self-editable.
  return protectedKeys.has(key) || billingAuthorityKeys.has(key) || key.startsWith("staff_") || key.startsWith("gp_staff_")
    || key.startsWith("created_by_staff_") || key.startsWith("customer_account_credit") || key.startsWith("customer_account_note")
}

/** Admin profile edits may contain ordinary staff notes, but never grants. */
export function isStaffGrantMetadataKey(key: string): boolean {
  return protectedKeys.has(key) || billingAuthorityKeys.has(key) || key.startsWith("staff_access_") || key.startsWith("gp_staff_") || key.startsWith("staff_bootstrap_")
}

const trueValues = new Set(["1", "true", "yes", "y", "staff", "admin", "ops", "operator", "customer_service"])
export function staffFlagEnabled(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && trueValues.has(value.trim().toLowerCase()))
}

const legacyOfficeRoles = new Set([
  "staff", "office", "manager", "admin", "ops", "operator", "customer_service",
  "customer-service", "phone_orders", "phone-orders", "super_admin", "super-admin", "owner",
])

export const STAFF_ROLES = ["customer", "staff", "office", "picker", "packer", "manager", "merchandising_reviewer", "super_admin"] as const
export type StaffRole = typeof STAFF_ROLES[number]
export type StaffCustomer = { id?: string; email?: string | null; first_name?: string | null; last_name?: string | null; metadata?: Record<string, unknown> | null }
export type StaffCapability = "catalog.read" | "inventory.read" | "inventory.manage" | "orders.read" | "orders.support" | "customers.read" | "customers.write" | "communications" | "accounting" | "pick" | "pack" | "finalize" | "charge" | "fulfill" | "team.manage"

export function configuredIds(name: string): Set<string> {
  return new Set(String(process.env[name] || "").split(",").map(id => id.trim()).filter(Boolean))
}

export function isBootstrapStaffIdentity(customer: StaffCustomer | null): boolean {
  return !!customer?.id && configuredIds("GP_STAFF_BOOTSTRAP_CUSTOMER_IDS").has(customer.id)
}

export function staffRole(customer: StaffCustomer | null): StaffRole {
  if (!customer) return "customer"
  const metadata = customer.metadata || {}
  if (staffFlagEnabled(metadata.staff_access_revoked)) return "customer"
  const legacyBootstrap = staffBoundaryMode() === "log" && ["aviswerdlow@gmail.com", "peterswerdlow@gmail.com", "peter@grillerspride.com"].includes(String(customer.email || "").trim().toLowerCase())
  if ((isBootstrapStaffIdentity(customer) || legacyBootstrap) && metadata.staff_bootstrap_override !== true) return "super_admin"
  const role = String(metadata.gp_staff_role || metadata.staff_role || metadata.role || metadata.account_role || "").trim().toLowerCase()
  if (STAFF_ROLES.includes(role as StaffRole)) return role as StaffRole
  if (["super-admin", "owner"].includes(role)) return "super_admin"
  if (["merchandising-reviewer", "merchandising"].includes(role)) return "merchandising_reviewer"
  if (legacyOfficeRoles.has(role)) return "staff"
  if (role) return "customer"
  return [metadata.is_staff, metadata.staff, metadata.gp_staff, metadata.staff_access, metadata.phone_order_staff].some(staffFlagEnabled) ? "staff" : "customer"
}

export function staffCapabilities(customer: StaffCustomer | null): Set<StaffCapability> {
  const role = staffRole(customer)
  const caps = new Set<StaffCapability>()
  if (role === "customer") return caps
  caps.add("catalog.read")
  if (["staff", "office", "picker", "packer", "manager", "super_admin"].includes(role)) {
    caps.add("inventory.read"); caps.add("orders.read")
  }
  if (["staff", "office", "manager", "super_admin"].includes(role)) {
    for (const cap of ["orders.support", "customers.read", "customers.write", "communications", "accounting"] as const) caps.add(cap)
  }
  if (["staff", "picker", "packer", "manager", "super_admin"].includes(role)) caps.add("pick")
  if (["staff", "packer", "manager", "super_admin"].includes(role)) caps.add("pack")
  // These mirror the existing warehouse console, with final charge separately
  // granted. The launch role matrix still requires owner review before rollout.
  if (caps.has("pick")) { caps.add("finalize"); caps.add("fulfill") }
  const m = customer?.metadata || {}
  if (role === "super_admin" || (caps.has("pick") && [m.final_charge_enabled, m.can_charge_final_orders, m.staff_final_charge_enabled, m.catch_weight_charge_enabled].some(staffFlagEnabled))) caps.add("charge")
  if (role === "super_admin") { caps.add("team.manage"); caps.add("inventory.manage") }
  return caps
}

export function staffSessionIsCurrent(customer: StaffCustomer, auth: { iat?: unknown } | null | undefined): boolean {
  const cutoff = customer.metadata?.staff_access_valid_after
  if (cutoff === undefined || cutoff === null) return true
  const timestamp = Number(cutoff)
  return Number.isSafeInteger(timestamp) && timestamp >= 0 && Number.isSafeInteger(auth?.iat) && Number(auth?.iat) > timestamp
}

/** Response-only status. Never persisted or accepted as input authority. */
export function staffAccessStatus(customer: StaffCustomer, auth?: { iat?: unknown }) {
  const current = auth === undefined || staffSessionIsCurrent(customer, auth)
  return { role: current ? staffRole(customer) : "customer", final_charge_enabled: current && staffCapabilities(customer).has("charge"),
    bootstrap: isBootstrapStaffIdentity(customer), session_current: current, version: Number(customer.metadata?.staff_access_version || 0) }
}

/** Mirrors the office/customer-context capability, not merely "any staff". */
export function canManageCustomerPaymentMethods(customer: StaffCustomer | null): boolean {
  return staffCapabilities(customer).has("customers.write")
}
