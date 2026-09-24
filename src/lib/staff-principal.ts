import { getAuthContextFromJwtToken, type MedusaRequest } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { configuredIds, staffCapabilities, staffRole, staffSessionIsCurrent, type StaffCapability, type StaffCustomer, type StaffRole } from "./staff-access-policy"

export const STAFF_AUTHORIZATION_HEADER = "x-gp-staff-authorization"
export type StaffPrincipal = { id: string; kind: "customer" | "operator" | "service"; service_scope?: "parity"; email: string | null; name: string; role: StaffRole; capabilities: Set<StaffCapability>; transport_id: string; auth: Record<string, any>; service_role?: "read_only" | "qbd_catalog" | "communications" }
export class StaffAccessDenied extends Error {}

export function signedCustomerContext(req: MedusaRequest, header: unknown): Record<string, any> | null {
  if (typeof header !== "string" || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header)) return null
  const { projectConfig: { http } } = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
  const auth = getAuthContextFromJwtToken(header, http.jwtSecret, ["bearer"], ["customer"], http.jwtPublicKey, http.jwtVerifyOptions ?? http.jwtOptions) as Record<string, any> | null
  if (!auth?.auth_identity_id || !Number.isSafeInteger(auth.iat) || !Number.isSafeInteger(auth.exp) || auth.iat > Math.floor(Date.now() / 1000)) return null
  return auth
}

export async function currentStaffCustomer(req: MedusaRequest, id: string): Promise<StaffCustomer> {
  const customer = await req.scope.resolve(Modules.CUSTOMER).retrieveCustomer(id, { select: ["id", "email", "first_name", "last_name", "metadata"] })
  if (!customer || customer.id !== id) throw new StaffAccessDenied("The staff account is unavailable.")
  return customer
}

export async function resolveStaffPrincipal(req: MedusaRequest): Promise<StaffPrincipal> {
  const transport = (req as any).auth_context || {}
  const transportId = String(transport.actor_id || "")
  if (transport.actor_type === "user" && configuredIds("GP_PRIVILEGED_ADMIN_USER_IDS").has(transportId)) {
    const user = await req.scope.resolve(Modules.USER).retrieveUser(transportId)
    if (user?.id !== transportId) throw new StaffAccessDenied("The admin account is unavailable.")
    return { id: user.id, kind: "operator", email: user.email || null, name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email || user.id, role: "super_admin", capabilities: new Set(), transport_id: transportId, auth: transport }
  }
  if (transport.actor_type !== "api-key") throw new StaffAccessDenied("This admin identity has no approved staff access.")
  // A configured gateway key can never fall back to service/operator access,
  // even if it is accidentally also listed as a read-only key.
  if (transportId === process.env.GP_STAFF_GATEWAY_API_KEY_ID) {
    const auth = signedCustomerContext(req, req.headers[STAFF_AUTHORIZATION_HEADER])
    if (!auth?.actor_id) throw new StaffAccessDenied("A signed-in staff session is required.")
    const customer = await currentStaffCustomer(req, auth.actor_id)
    if (!staffSessionIsCurrent(customer, auth)) throw new StaffAccessDenied("Staff access changed. Sign in again.")
    return { id: auth.actor_id, kind: "customer", email: customer.email || null, name: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email || auth.actor_id, role: staffRole(customer), capabilities: staffCapabilities(customer), transport_id: transportId, auth }
  }
  if (req.headers[STAFF_AUTHORIZATION_HEADER]) throw new StaffAccessDenied("This credential is not the staff gateway.")
  // The narrower parity reader never inherits broader discovery/writer power.
  if (configuredIds("GP_PARITY_READ_API_KEY_IDS").has(transportId)) {
    return { id: transportId, kind: "service", service_scope: "parity", email: null, name: "Original-order parity reader", role: "customer", capabilities: new Set(), transport_id: transportId, auth: transport }
  }
  const matches = ([
    ["GP_ADMIN_READ_ONLY_API_KEY_IDS", "read_only"],
    ["GP_QBD_CATALOG_API_KEY_IDS", "qbd_catalog"],
    ["GP_COMMUNICATIONS_ADMIN_API_KEY_IDS", "communications"],
  ] as const).filter(([setting]) => configuredIds(setting).has(transportId))
  if (matches.length > 1) throw new StaffAccessDenied("This service credential has conflicting classifications.")
  if (matches.length === 1) {
    return { id: transportId, kind: "service", email: null, name: `Integration: ${matches[0][1]}`, role: "customer", capabilities: new Set(), transport_id: transportId, auth: transport, service_role: matches[0][1] }
  }
  throw new StaffAccessDenied("This service credential has no approved capability.")
}

export function requestStaffPrincipal(req: MedusaRequest): StaffPrincipal | undefined {
  return (req as any).gp_staff_principal
}

export function verifiedStaffAuditFields(req: MedusaRequest) {
  const actor = requestStaffPrincipal(req)
  // Native user context is authenticated by Medusa. This fallback also keeps
  // direct-handler tests meaningful; request-body identity is never accepted.
  const id = actor?.id || (req as any).auth_context?.actor_id || null
  return { staff_actor_id: id, staff_actor_customer_id: actor?.kind === "customer" ? id : null,
    staff_actor_email: actor?.email || null, staff_actor_name: actor?.name || null }
}

export function verifiedStaffActorId(req: MedusaRequest): string | null {
  return verifiedStaffAuditFields(req).staff_actor_id
}
