import { configuredIds, STAFF_ROLES, staffAccessStatus, staffCapabilities, staffRole, staffSessionIsCurrent, type StaffRole } from "./staff-access-policy"
import { StaffAccessDenied, type StaffPrincipal } from "./staff-principal"

const confirmations: Record<StaffRole, string> = { customer: "REMOVE STAFF", staff: "STAFF", office: "OFFICE", picker: "PICKER", packer: "PACKER", manager: "MANAGER", merchandising_reviewer: "MERCHANDISING", super_admin: "SUPER ADMIN" }
export class StaffRoleChangeConflict extends Error {}
export class InvalidStaffRoleChange extends Error {}

function rows(value: unknown): any[] {
  const result = typeof value === "string" ? JSON.parse(value) : value ?? []
  if (!Array.isArray(result)) throw new Error("Stored audit history is invalid")
  return result
}

/** Grant, revocation cutoff and audit append commit under the same customer lock. */
export async function changeStaffRole(db: any, principal: StaffPrincipal, targetId: string, input: Record<string, any>) {
  const role = input.role as StaffRole
  if (!STAFF_ROLES.includes(role) || typeof input.reason !== "string" || input.reason.trim().length < 8
    || typeof input.confirmation !== "string" || input.confirmation.trim().toUpperCase() !== confirmations[role]
    || !Number.isSafeInteger(input.expected_version) || input.expected_version < 0
    || (input.final_charge_enabled !== undefined && typeof input.final_charge_enabled !== "boolean")) {
    throw new InvalidStaffRoleChange("Choose a role, provide the current version, an audit reason and the required confirmation.")
  }
  if (principal.kind !== "operator" && !principal.capabilities.has("team.manage")) throw new StaffAccessDenied("Team administrator access is required.")
  if (!configuredIds("GP_PRIVILEGED_ADMIN_USER_IDS").size) throw new StaffAccessDenied("Configure and rehearse the separate recovery operator before changing staff access.")
  if (principal.kind === "customer" && principal.id === targetId && role !== "super_admin") throw new StaffAccessDenied("You cannot remove your own super admin access.")
  return db.transaction(async (trx: any) => {
    // Lock actor and target in stable order. A concurrent revocation of the
    // acting owner must commit either before this check or after this change.
    const ids = [...new Set(principal.kind === "customer" ? [principal.id, targetId] : [targetId])].sort()
    const customers = await trx("customer").whereIn("id", ids).whereNull("deleted_at").orderBy("id").forUpdate().select("*")
    const target = customers.find((row: any) => row.id === targetId)
    if (!target) throw new InvalidStaffRoleChange("Customer not found.")
    if (principal.kind === "customer") {
      const actor = customers.find((row: any) => row.id === principal.id)
      if (!actor || !staffCapabilities(actor).has("team.manage") || !staffSessionIsCurrent(actor, principal.auth)) throw new StaffAccessDenied("Your staff access changed. Sign in again.")
    } else if (!configuredIds("GP_PRIVILEGED_ADMIN_USER_IDS").has(principal.id)) throw new StaffAccessDenied("Recovery operator access is no longer configured.")
    const previous = target.metadata || {}
    if (Number(previous.staff_access_version || 0) !== input.expected_version) throw new StaffRoleChangeConflict("Staff access changed since it was loaded. Refresh before trying again.")
    const now = new Date()
    const cutoff = Math.max(Math.floor(now.getTime() / 1000), Number(previous.staff_access_valid_after || 0))
    if (!Number.isSafeInteger(cutoff)) throw new Error("Stored session cutoff is invalid")
    const charge = role === "super_admin" || (["staff", "picker", "packer", "manager"].includes(role) && input.final_charge_enabled === true)
    const event = { action: "staff_role_change", at: now.toISOString(), reason: input.reason.trim(),
      staff_actor_id: principal.id, staff_actor_customer_id: principal.kind === "customer" ? principal.id : null,
      staff_actor_email: principal.email, staff_actor_name: principal.name, actor_kind: principal.kind,
      target_customer_id: targetId, previous_role: staffRole(target), previous_final_charge_enabled: staffCapabilities(target).has("charge"),
      role, final_charge_enabled: charge, previous_version: input.expected_version, version: input.expected_version + 1,
      staff_access_valid_after: cutoff, recovery: principal.kind === "operator" }
    const metadata = { ...previous, gp_staff_role: role, staff_role: role, role, account_role: role,
      is_staff: role !== "customer", staff: role !== "customer", gp_staff: role !== "customer", staff_access: role !== "customer", phone_order_staff: role !== "customer",
      staff_super_admin: role === "super_admin", staff_access_revoked: role === "customer", staff_bootstrap_override: true,
      staff_access_updated_at: now.toISOString(), staff_access_version: input.expected_version + 1, staff_access_valid_after: cutoff,
      final_charge_enabled: charge, can_charge_final_orders: charge, staff_final_charge_enabled: charge, catch_weight_charge_enabled: charge,
      // The dedicated grant audit is never trimmed by ordinary profile notes.
      staff_access_audit_log: JSON.stringify([...rows(previous.staff_access_audit_log), event]),
      staff_audit_log: JSON.stringify([...rows(previous.staff_audit_log), event].slice(-50)) }
    await trx("customer").where({ id: targetId }).update({ metadata: JSON.stringify(metadata), updated_at: now })
    const customer = { ...target, metadata }
    return { customer: { ...customer, staff_access: staffAccessStatus(customer) }, reauthentication_required: true }
  })
}
