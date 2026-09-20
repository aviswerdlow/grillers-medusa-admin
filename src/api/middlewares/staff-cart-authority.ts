import { staffBoundaryMode, reportStaffBoundaryDenial } from "../../lib/staff-boundary-rollout"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { isDeepStrictEqual } from "node:util"
import { currentStaffCustomer, signedCustomerContext, StaffAccessDenied, STAFF_AUTHORIZATION_HEADER } from "../../lib/staff-principal"
import { staffCapabilities, staffSessionIsCurrent } from "../../lib/staff-access-policy"
import { checkInventoryAvailability } from "../../lib/inventory-allocation"
import { cartHasStaffMarkers, normalizedCartEmail, serverOwnedCartKey, signStaffLineOverride, staffCartActorFields,
  STAFF_CART_AUTHORITY, staffCartMetadataKey, staffCartRequestedDate, staffCartSigningSecret, STAFF_LINE_OVERRIDE,
  verifiedStaffCartAuthority, verifiedStaffLineOverride, type StaffCartAuthority } from "../../lib/staff-cart-authority"

const record = (value: any): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {}
const cartFields = ["id", "email", "customer_id", "metadata", "completed_at", "items.id", "items.variant_id", "items.quantity", "items.metadata"]

async function requestCart(req: MedusaRequest): Promise<any | null> {
  const path = req.path.replace(/\/+$/, "")
  const cartMatch = path.match(/^\/store\/carts\/([^/]+)/)
  let id = cartMatch?.[1] || (req.body as any)?.cart_id
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  if (path.startsWith("/store/payment-collections/")) {
    const paymentId = path.split("/")[3]
    const { data } = await query.graph({ entity: "cart_payment_collection", fields: ["cart.id"], filters: { payment_collection_id: paymentId } })
    id = data?.[0]?.cart?.id
    if (!id) throw new StaffAccessDenied("This payment collection has no verified cart.")
  }
  if (!id) return null
  const { data } = await query.graph({ entity: "cart", fields: cartFields, filters: { id } })
  if (!data?.[0]) throw new StaffAccessDenied("The cart is unavailable.")
  return data[0]
}

function guardedMetadata(incoming: unknown, current: unknown, staff: boolean): Record<string, any> | undefined {
  if (incoming === undefined) return undefined
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new StaffAccessDenied("Cart metadata cannot erase staff or payment authority.")
  const previous = record(current), patch = { ...record(incoming) }
  for (const [key, value] of Object.entries(patch)) {
    if (!staffCartMetadataKey(key, value) && !staffCartMetadataKey(key, previous[key])) continue
    // The storefront sometimes submits a complete metadata snapshot. Retain
    // server fields in storage, but never replay that snapshot over newer state.
    if (Object.prototype.hasOwnProperty.call(previous, key) && isDeepStrictEqual(value, previous[key])) { delete patch[key]; continue }
    if (!staff || serverOwnedCartKey(key)) throw new StaffAccessDenied("Staff, override and payment authority cannot be supplied through public cart metadata.")
    if (key.startsWith("staff_actor_") || key.startsWith("staff_target_") || key.startsWith("staff_selected_customer_") || key.startsWith("created_by_staff_") || key === "staff_audit_log" || key === "source") delete patch[key]
  }
  return patch
}

function writeMetadata(req: MedusaRequest, value: Record<string, any>) {
  for (const body of new Set([(req as any).body, (req as any).validatedBody])) if (body && typeof body === "object") body.metadata = value
}

async function assertCurrentCartAuthority(req: MedusaRequest, cart: any, proof: StaffCartAuthority) {
  const staff = await currentStaffCustomer(req, proof.actor_id)
  if (!staffCapabilities(staff).has("customers.write") || !staffSessionIsCurrent(staff, { iat: proof.session_iat })
    || Number(staff.metadata?.staff_access_version || 0) !== proof.access_version) {
    throw new StaffAccessDenied("Staff access changed. Ask the office to prepare a new checkout link or cart.")
  }
  const header = req.headers[STAFF_AUTHORIZATION_HEADER]
  let isStaff = false
  if (header) {
    const auth = signedCustomerContext(req, header)
    if (!auth || auth.actor_id !== proof.actor_id || !staffSessionIsCurrent(staff, auth)) throw new StaffAccessDenied("The current staff session does not match this cart.")
    isStaff = true
  }
  if (!isStaff && proof.payment_mode !== "send_checkout_link") throw new StaffAccessDenied("A current staff session is required for this cart.")
  const buyer = (req as any).auth_context?.actor_id
  if (!isStaff && buyer && buyer !== proof.customer_id) throw new StaffAccessDenied("Sign in with the customer account for this checkout link.")
  const target = req.headers["x-gp-staff-target-customer-id"]
  if (target && target !== proof.customer_id) throw new StaffAccessDenied("The selected customer does not match this cart.")
  const body = record(req.body)
  if (Object.prototype.hasOwnProperty.call(body, "email") && normalizedCartEmail(body.email) !== proof.email) throw new StaffAccessDenied("Prepare a new staff cart to change its customer.")
  // Native cart transfer assigns auth_context.actor_id. Never assign the staff
  // account to the customer's cart or switch to a different customer.
  if (req.path.endsWith("/customer")) {
    const customerAuth = signedCustomerContext(req, req.headers.authorization)
    if (!proof.customer_id || customerAuth?.actor_id !== proof.customer_id) throw new StaffAccessDenied("This cart is already bound to its customer.")
  }
  return isStaff
}

async function checkStaffCartBeforePayment(req: MedusaRequest, cart: any, proof: StaffCartAuthority, secret: string) {
  const items = cart.items || []
  if (!items.length) throw new StaffAccessDenied("Add items before preparing payment.")
  for (const line of items) {
    const m = record(line.metadata)
    if ((m.inventory_override_reason || m.inventory_override_note || m[STAFF_LINE_OVERRIDE]) && !verifiedStaffLineOverride(cart, line, proof, secret)) {
      throw new StaffAccessDenied("The inventory override no longer matches this cart. Ask the office to review the items, quantities and date.")
    }
  }
  const lines = await checkInventoryAvailability({ db: req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
    query: req.scope.resolve(ContainerRegistrationKeys.QUERY), cart_id: cart.id, customer_id: cart.customer_id,
    lines: items.map((line: any) => ({ variant_id: line.variant_id, quantity: Number(line.quantity) })),
    requested_fulfillment_date: staffCartRequestedDate(cart.metadata), fulfillment_type: cart.metadata?.fulfillmentType,
    source: proof.source === "staff_phone_order" ? "staff_phone_order" : "customer_web", include_internal: false, record_snapshots: false })
  if (lines.length !== items.length || lines.some((line, index) => line.decision === "inactive"
    || (!["available", "future_allowed"].includes(line.decision) && !verifiedStaffLineOverride(cart, items[index], proof, secret)))) {
    throw new StaffAccessDenied("Some items need an Office inventory review before payment can proceed.")
  }
}

/** Protect every public cart entry, including native payment and completion. */
export async function enforceStaffCartAuthority(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  try {
    const body = record(req.body)
    const cart = await requestCart(req)
    const marked = cart && cartHasStaffMarkers(cart)
    // Signed carts never downgrade, even during rollback. Log mode leaves the
    // existing unsigned staff workflow available until both deployments agree.
    if (staffBoundaryMode() === "log" && record(cart?.metadata)[STAFF_CART_AUTHORITY] == null) {
      const incoming = [body.metadata, ...(Array.isArray(body.items) ? body.items.map((line: any) => line?.metadata) : [])]
      if (incoming.some(m => Object.keys(record(m)).some(key => key.startsWith("gp_staff_")))) throw new StaffAccessDenied("New staff authority is server-managed.")
      if (marked || req.headers[STAFF_AUTHORIZATION_HEADER]) reportStaffBoundaryDenial(req, "cart", "unsigned_legacy_cart")
      return next()
    }
    let proof: StaffCartAuthority | null = null, secret: string | undefined, staff = false
    if (marked) {
      secret = staffCartSigningSecret(req.scope)
      proof = verifiedStaffCartAuthority(cart, secret)
      if (!proof) throw new StaffAccessDenied("This staff cart has no current verified handoff. Ask the office to prepare it again.")
      staff = await assertCurrentCartAuthority(req, cart, proof)
      ;(req as any).gp_staff_cart = proof
    } else if (req.headers[STAFF_AUTHORIZATION_HEADER] || req.headers["x-gp-staff-target-customer-id"]) {
      throw new StaffAccessDenied("Create customer-context carts through the staff order action.")
    }

    const lineId = req.path.match(/\/line-items\/([^/]+)$/)?.[1]
    const isLine = /\/line-items(?:\/[^/]+)?$/.test(req.path)
    const currentLine = isLine && cart ? (cart.items || []).find((line: any) => line.id === lineId) : null
    const currentMetadata = isLine ? currentLine?.metadata : cart?.metadata
    const metadata = guardedMetadata(body.metadata, currentMetadata, staff)
    if (metadata !== undefined) writeMetadata(req, metadata)
    for (const line of Array.isArray(body.items) ? body.items : []) guardedMetadata(line?.metadata, undefined, false)

    if (staff && proof && cart && req.method === "POST" && (metadata !== undefined || isLine || req.path === `/store/carts/${cart.id}`)) {
      const canonical = { ...(metadata || {}), ...staffCartActorFields(proof), staff_last_action_at: new Date().toISOString() }
      if (metadata?.staff_payment_completed_by_customer_id !== undefined) {
        ;(canonical as any).staff_payment_completed_by_customer_id = proof.actor_id
        ;(canonical as any).staff_payment_completed_at = new Date().toISOString()
      }
      if (isLine) {
        const effectiveLine = { ...currentLine, variant_id: body.variant_id || currentLine?.variant_id,
          quantity: body.quantity ?? currentLine?.quantity, metadata: { ...record(currentMetadata), ...canonical } }
        if (effectiveLine.metadata.inventory_override_reason || effectiveLine.metadata.inventory_override_note) {
          if (!String(effectiveLine.metadata.inventory_override_reason || "").trim() || !String(effectiveLine.metadata.inventory_override_note || "").trim()) throw new StaffAccessDenied("An inventory override requires both a reason and a note.")
          ;(canonical as any)[STAFF_LINE_OVERRIDE] = signStaffLineOverride(cart, effectiveLine, proof, secret!)
        }
      } else {
        const previous = record(cart.metadata).staff_audit_log
        let history: any[] = []
        try { const rows = typeof previous === "string" ? JSON.parse(previous) : previous; if (Array.isArray(rows)) history = rows } catch {}
        ;(canonical as any).staff_audit_log = JSON.stringify([...history, { action: "staff_cart_update", at: new Date().toISOString(), ...staffCartActorFields(proof) }].slice(-50))
      }
      writeMetadata(req, canonical)
    }

    // Calendar list/select/validate only return quotes. Staff identity still
    // applies above; date-bound ATP and override receipts apply at payment.
    const isCalendarQuote = req.path.replace(/\/+$/, "") === "/store/grillers/checkout/fulfillment-calendar"
    const isPayment = !isCalendarQuote && req.method === "POST" && (req.path.endsWith("/complete") || req.path.startsWith("/store/payment-collections")
      || req.path.endsWith("/payment-collection") || req.path.startsWith("/store/grillers/checkout/"))
    if (proof && isPayment) {
      if (cart.completed_at && !req.path.endsWith("/complete") && !req.path.endsWith("/place-order")) throw new StaffAccessDenied("This cart already has an order.")
      // Native completion is idempotent. A retry must retrieve the same order,
      // not reject it because that order now owns the stock reservation.
      if (!cart.completed_at) await checkStaffCartBeforePayment(req, cart, proof, secret!)
      if (req.path.endsWith("/payment-sessions")) {
        if (body.provider_id !== "pp_stripe_stripe") throw new StaffAccessDenied("Use the card checkout or the approved invoice action.")
        // Native payment creation consumes actor_id as its account holder.
        // The cart receipt authorizes this buyer, never the Office account.
        ;(req as any).auth_context = { actor_type: "customer", actor_id: proof.customer_id }
      }
    }
    return next()
  } catch (error) {
    return res.status(error instanceof StaffAccessDenied ? 403 : 503).json({ message: error instanceof StaffAccessDenied ? error.message : "The cart authority could not be verified. Try again before preparing payment." })
  }
}
