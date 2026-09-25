import { orderReviewEnforcementMode } from "../../lib/order-review-rollout"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { staffBoundaryMode, reportStaffBoundaryDenial } from "../../lib/staff-boundary-rollout"
import { isDeepStrictEqual } from "node:util"
import { Modules } from "@medusajs/framework/utils"
import { configuredIds, isBootstrapStaffIdentity, isStaffGrantMetadataKey, staffAccessStatus, staffRole, staffSessionIsCurrent } from "../../lib/staff-access-policy"
import { currentStaffCustomer, requestStaffPrincipal, resolveStaffPrincipal, StaffAccessDenied, verifiedStaffAuditFields } from "../../lib/staff-principal"
import { adminRouteCapability, isReadOnlyServiceRoute, isServiceRoute } from "../../lib/staff-route-capabilities"
import { ORDER_PROMISE_READ_PATH } from "../../lib/order-promise-reader"
import { isCanonicalStaffPath, staffRequestPath } from "../../lib/staff-request-path"

export async function enforceStaffCapabilities(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const path = staffRequestPath(req)
  if (!isCanonicalStaffPath(path)) return res.status(403).json({ message: "This admin route is unavailable." })
  // A designated native reader is read-only even while the wider staff boundary
  // observes other callers in log mode during rollout.
  const transport = (req as any).auth_context
  const transportId = String(transport?.actor_id || "")
  const parityReader = transport?.actor_type === "api-key" && configuredIds("GP_PARITY_READ_API_KEY_IDS").has(transportId)
  const readOnlyUser = transport?.actor_type === "user" && configuredIds("GP_ADMIN_READ_ONLY_USER_IDS").has(transportId)
  const readOnlyKey = transport?.actor_type === "api-key" && configuredIds("GP_ADMIN_READ_ONLY_API_KEY_IDS").has(transportId)
  // These dedicated credentials have no legacy traffic to preserve. Apply the
  // narrow GET list before log mode can turn a would-deny into an admission.
  if (parityReader ? req.method !== "GET" || path !== ORDER_PROMISE_READ_PATH
    : (readOnlyUser || readOnlyKey) && !isReadOnlyServiceRoute(path, req.method)) {
    return res.status(403).json({ message: "This read-only account cannot access this admin route." })
  }
  // Checkout enforcement is independent of the staff observation switch.
  if (orderReviewEnforcementMode() === "required" && req.method === "POST" && (/^\/admin\/draft-orders(?:\/[^/]+\/convert-to-order)?$/.test(path) || /^\/admin\/orders$/.test(path))) {
    return res.status(403).json({ message: "Create orders through the reviewed customer or staff checkout. Native draft conversion has no accepted-order review." })
  }
  try {
    const principal = await resolveStaffPrincipal(req)

    const capability = adminRouteCapability(path, req.method, req.body)
    const nativeReadOnlyUser = principal.kind === "service" && principal.auth.actor_type === "user" && principal.service_role === "read_only"
    const allowed = principal.kind === "operator"
      || (principal.kind === "service" ? principal.service_scope === "parity"
        ? req.method === "GET" && path === ORDER_PROMISE_READ_PATH
        : (!nativeReadOnlyUser || req.method === "GET") && isServiceRoute(principal.service_role, path, req.method, (req as any).validatedBody || req.body) : capability && principal.capabilities.has(capability))
    if (!allowed) throw new StaffAccessDenied("Your current staff permissions do not allow this action.")
    ;(req as any).gp_staff_principal = principal
    // Native order/payment workflows copy auth_context.actor_id into canceled_by,
    // captured_by and created_by. Supply the verified person only after Medusa
    // authenticated the transport and the capability check passed. Custom routes
    // retain transport context and use verifiedStaffAuditFields explicitly.
    if (principal.kind === "customer" && /^\/admin\/(orders|order-edits|payments|fulfillments)(\/|$)/.test(path)) {
      ;(req as any).auth_context = { ...(req as any).auth_context, actor_id: principal.id }
    }
    return next()
  } catch (error) {
    if (staffBoundaryMode() === "log") {
      reportStaffBoundaryDenial(req, "admin", error instanceof StaffAccessDenied ? "unapproved_capability" : "lookup_unavailable")
      return next()
    }
    return res.status(error instanceof StaffAccessDenied ? 403 : 503).json({
      message: error instanceof StaffAccessDenied ? error.message : "Staff access could not be verified. No action was started.",
    })
  }
}

export function auditRows(value: unknown): Record<string, any>[] {
  if (value === undefined || value === null) return []
  const rows = typeof value === "string" ? JSON.parse(value) : value
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new StaffAccessDenied("The existing audit history must be preserved.")
  return rows
}

/** Keep the stored prefix; only newly appended entries receive this actor. */
function verifiedAppend(req: MedusaRequest, current: unknown, proposed: unknown, key: string) {
  const previous = auditRows(current), incoming = auditRows(proposed)
  if (isDeepStrictEqual(previous, incoming)) return current
  let added: Record<string, any>[] | undefined
  for (let count = 1; count <= 2 && count <= incoming.length; count++) {
    const retained = incoming.slice(0, -count)
    if ((retained.length === previous.length || incoming.length === 50) && isDeepStrictEqual(retained, previous.slice(-retained.length || previous.length))) {
      added = incoming.slice(-count); break
    }
    if (!previous.length && !retained.length) { added = incoming.slice(-count); break }
  }
  if (!added || added.some(row => row.action === "staff_role_change" || row.type === "staff_role_change")) throw new StaffAccessDenied("Audit history can only be appended; role changes use Team access.")
  const actor = verifiedStaffAuditFields(req)
  const at = new Date().toISOString()
  const rows = added.map(row => ({ ...row, ...actor, at,
    staffCustomerId: actor.staff_actor_customer_id, staffEmail: actor.staff_actor_email, staffName: actor.staff_actor_name,
    createdByStaffCustomerId: actor.staff_actor_customer_id, createdByStaffEmail: actor.staff_actor_email, createdByStaffName: actor.staff_actor_name,
    ...(key === "staff_audit_log" ? {} : { createdAt: at }),
  }))
  return JSON.stringify([...previous, ...rows].slice(-50))
}

/** The generic customer endpoint cannot grant roles, undo revocation or edit audit history. */
export async function protectAdminCustomerAuthority(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  try {
    const principal = requestStaffPrincipal(req)
    if (staffBoundaryMode() === "log") {
      const metadata = ((req as any).validatedBody || req.body)?.metadata
      if (metadata === null || (metadata && typeof metadata === "object" && Object.keys(metadata).some(isStaffGrantMetadataKey))) {
        reportStaffBoundaryDenial(req, "customer_profile", "authority_write_requires_review")
      }
      return next()
    }
    if (!principal) throw new StaffAccessDenied("Verified staff access is required.")
    if (principal.kind === "service" && principal.service_role === "communications") return next()
    const current = req.params.id ? await currentStaffCustomer(req, req.params.id) : null
    if (current && (staffRole(current) !== "customer" || isBootstrapStaffIdentity(current)) && principal.kind !== "operator" && !principal.capabilities.has("team.manage")) {
      throw new StaffAccessDenied("Only a team administrator can edit a staff account.")
    }
    const seenMetadata = new Set<object>()
    for (const body of new Set([req.body, (req as any).validatedBody])) {
      if (!body || typeof body !== "object") continue
      if (!Object.prototype.hasOwnProperty.call(body, "metadata")) body.metadata = {}
      const metadata = body.metadata
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new StaffAccessDenied("Customer metadata cannot be cleared through this route.")
      if (seenMetadata.has(metadata)) continue
      seenMetadata.add(metadata)
      for (const key of Object.keys(metadata)) {
        if (!isStaffGrantMetadataKey(key)) continue
        if (!isDeepStrictEqual(metadata[key], current?.metadata?.[key])) throw new StaffAccessDenied("Change staff permissions through the audited Team access action.")
        // Do not replay an unchanged grant from an old full-profile snapshot.
        delete metadata[key]
      }
      for (const key of ["staff_audit_log", "customer_account_credits", "customer_account_notes"]) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)) metadata[key] = verifiedAppend(req, current?.metadata?.[key], metadata[key], key)
      }
      const actor = verifiedStaffAuditFields(req)
      for (const key of Object.keys(actor)) if (Object.prototype.hasOwnProperty.call(metadata, key)) metadata[key] = actor[key]
      for (const [key, value] of Object.entries({ created_by_staff_customer_id: actor.staff_actor_customer_id, created_by_staff_email: actor.staff_actor_email, created_by_staff_name: actor.staff_actor_name })) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)) metadata[key] = current?.metadata?.[key] ?? value
      }
      if (staffRequestPath(req).includes("/addresses")) {
        Object.assign(metadata, actor, { staff_action_at: new Date().toISOString() })
      } else {
        metadata.staff_audit_log = JSON.stringify([...auditRows(metadata.staff_audit_log ?? current?.metadata?.staff_audit_log), {
          action: current ? "staff_customer_profile_update" : "staff_customer_create", at: new Date().toISOString(), ...actor,
        }].slice(-50))
      }
    }
    return next()
  } catch (error) {
    return res.status(error instanceof StaffAccessDenied ? 403 : 503).json({ message: error instanceof StaffAccessDenied ? error.message : "Customer authority could not be verified." })
  }
}

/** A revoked JWT must not acquire a newer iat through native refresh or session creation. */
export async function enforceStaffSessionEpoch(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const auth = (req as any).auth_context
  if (auth?.actor_type !== "customer") return next()
  try {
    let id = auth.actor_id
    // Registration tokens can predate a customer's first grant. Native refresh
    // hydrates their actor_id from the auth identity; apply the same lookup here.
    if (!id && auth.auth_identity_id) {
      const identity = await req.scope.resolve(Modules.AUTH).retrieveAuthIdentity(auth.auth_identity_id)
      id = identity.app_metadata?.customer_id
    }
    if (id && !staffSessionIsCurrent(await currentStaffCustomer(req, id), auth)) throw new StaffAccessDenied("Staff access changed. Sign in again.")
    return next()
  } catch (error) {
    return res.status(error instanceof StaffAccessDenied ? 403 : 503).json({ message: error instanceof StaffAccessDenied ? error.message : "The session could not be verified." })
  }
}

export async function publishCurrentStaffAccess(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (staffBoundaryMode() === "log") return next()
  try {
    const auth = (req as any).auth_context
    const customer = await currentStaffCustomer(req, auth.actor_id)
    const status = staffAccessStatus(customer, auth)
    const json = res.json.bind(res)
    res.json = ((body: any) => json(body?.customer ? { ...body, customer: { ...body.customer, staff_access: status } } : body)) as any
    return next()
  } catch {
    return res.status(503).json({ message: "Current account access is unavailable." })
  }
}

export function publishAdminStaffAccess(_req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (staffBoundaryMode() === "log") return next()
  const json = res.json.bind(res)
  const decorate = (customer: any) => ({ ...customer, staff_access: staffAccessStatus(customer) })
  res.json = ((body: any) => json(body?.customer ? { ...body, customer: decorate(body.customer) }
    : Array.isArray(body?.customers) ? { ...body, customers: body.customers.map(decorate) } : body)) as any
  return next()
}

/** Native fulfillment workflows retain only authenticated-person attribution. */
export function bindFulfillmentAudit(req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) {
  for (const body of new Set([req.body, (req as any).validatedBody])) {
    if (body && typeof body === "object") body.metadata = { ...(body.metadata || {}), ...verifiedStaffAuditFields(req), staff_action_at: new Date().toISOString() }
  }
  return next()
}
