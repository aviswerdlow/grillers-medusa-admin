import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { createCartWorkflow } from "@medusajs/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { StoreCreateCart } from "@medusajs/medusa/api/store/carts/validators"
import { currentStaffCustomer, requestStaffPrincipal, StaffAccessDenied } from "../../../../lib/staff-principal"
import { staffCapabilities, staffSessionIsCurrent } from "../../../../lib/staff-access-policy"
import { normalizedCartEmail, serverOwnedCartKey, signStaffCartValue, staffCartActorFields, staffCartSigningSecret, STAFF_CART_AUTHORITY, type StaffCartAuthority } from "../../../../lib/staff-cart-authority"

/** Native cart creation with a server-owned, cart-bound staff receipt. */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const actor = requestStaffPrincipal(req)
    if (!actor || actor.kind !== "customer") throw new StaffAccessDenied("Create staff orders from a signed-in Office account.")
    const staff = await currentStaffCustomer(req, actor.id)
    if (!staffCapabilities(staff).has("customers.write") || !staffSessionIsCurrent(staff, actor.auth)) throw new StaffAccessDenied("Current Office access is required.")
    const secret = staffCartSigningSecret(req.scope)
    const { customer_id, source, ...raw } = (req.body || {}) as Record<string, any>
    const parsed = StoreCreateCart().safeParse(raw)
    if (!parsed.success || !parsed.data.email || parsed.data.items?.length || parsed.data.additional_data
      || !["staff_phone_order", "staff_impersonation"].includes(source)) {
      return res.status(422).json({ message: "Supply an empty staff cart, customer email and a valid staff order source." })
    }
    const input = parsed.data
    if (Object.keys(input.metadata || {}).some(serverOwnedCartKey)) throw new StaffAccessDenied("Payment and staff authority fields are managed by the backend.")
    const email = normalizedCartEmail(input.email)
    let targetId: string | null = null
    if (customer_id) {
      const target = await req.scope.resolve(Modules.CUSTOMER).retrieveCustomer(customer_id, { select: ["id", "email"] })
      if (!target || normalizedCartEmail(target.email) !== email) throw new StaffAccessDenied("Select the matching customer account before preparing the order.")
      targetId = target.id
    }
    const paymentMode = source === "staff_impersonation" ? "staff_impersonation" : input.metadata?.staff_payment_mode
    if (source === "staff_phone_order" && !["collect_card_now", "send_checkout_link"].includes(String(paymentMode))) return res.status(422).json({ message: "Select a staff payment method." })
    if (source === "staff_impersonation" && !targetId) return res.status(422).json({ message: "Select a customer account." })
    if (source === "staff_phone_order" && (input.metadata?.staff_customer_verified !== true || (paymentMode === "collect_card_now" && input.metadata?.staff_payment_consent !== true))) {
      return res.status(422).json({ message: "Confirm the customer and any card-collection consent before preparing the order." })
    }
    const now = Date.now()
    const proof: StaffCartAuthority = { version: 1, cart_id: "", source, actor_id: actor.id, actor_email: actor.email,
      actor_name: actor.name, access_version: Number(staff.metadata?.staff_access_version || 0), session_iat: actor.auth.iat,
      customer_id: targetId, email, payment_mode: paymentMode as StaffCartAuthority["payment_mode"], issued_at: now, expires_at: now + 7 * 24 * 60 * 60 * 1000 }
    const metadata = { ...(input.metadata || {}), ...staffCartActorFields(proof), staff_selected_customer_email: email,
      staff_audit_log: JSON.stringify([{ action: "staff_cart_prepared", at: new Date(now).toISOString(), ...staffCartActorFields(proof) }]) }
    const { result } = await createCartWorkflow(req.scope).run({ input: { ...input, email, customer_id: targetId, metadata } as any })
    proof.cart_id = result.id
    // Native creation can find/create the guest customer by email. Bind the
    // receipt to that actual buyer as well as to explicitly selected accounts.
    proof.customer_id = result.customer_id || targetId
    // Until the receipt is persisted, all staff cart effects fail closed. A
    // failed seal can leave an unused cart, never an authorized partial order.
    const cart = await req.scope.resolve(Modules.CART).updateCarts(result.id, { metadata: { ...metadata, ...staffCartActorFields(proof),
      staff_audit_log: JSON.stringify([{ action: "staff_cart_prepared", at: new Date(now).toISOString(), ...staffCartActorFields(proof) }]),
      cart_id: result.id, [STAFF_CART_AUTHORITY]: signStaffCartValue(proof, secret) } })
    return res.status(200).json({ cart })
  } catch (error) {
    return res.status(error instanceof StaffAccessDenied ? 403 : 503).json({ message: error instanceof StaffAccessDenied ? error.message : "The staff cart could not be verified. No payment was prepared." })
  }
}
