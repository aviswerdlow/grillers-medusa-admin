import { createHmac, timingSafeEqual } from "node:crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export const STAFF_CART_AUTHORITY = "gp_staff_cart_authority"
export const STAFF_LINE_OVERRIDE = "gp_staff_inventory_override"
export type StaffCartAuthority = {
  version: 1
  cart_id: string
  source: "staff_phone_order" | "staff_impersonation"
  actor_id: string
  actor_email: string | null
  actor_name: string
  access_version: number
  session_iat: number
  customer_id: string | null
  email: string
  payment_mode: "collect_card_now" | "send_checkout_link" | "staff_impersonation"
  issued_at: number
  expires_at: number
}

const record = (value: any): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {}
export const normalizedCartEmail = (value: unknown) => String(value || "").trim().toLowerCase()

export function staffCartSigningSecret(scope: { resolve: (key: string) => any }): string {
  const secret = scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)?.projectConfig?.http?.jwtSecret
  if (typeof secret !== "string" || secret.length < 20 || secret === "supersecret") throw new Error("A configured backend signing secret is required for staff carts.")
  return secret
}

function signature(encoded: string, secret: string) {
  return createHmac("sha256", secret).update(`gp-staff-cart-v1.${encoded}`).digest("base64url")
}

export function signStaffCartValue(value: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encoded}.${signature(encoded, secret)}`
}

function verifiedValue(token: unknown, secret?: string): any | null {
  if (!secret || typeof token !== "string" || token.length > 12000) return null
  const parts = token.split(".")
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null
  const expected = Buffer.from(signature(parts[0], secret)), actual = Buffer.from(parts[1])
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) } catch { return null }
}

/** Historical order audits verify the signature and subject, not today's role/expiry. */
export function verifiedStaffCartAuthority(cart: Record<string, any>, secret?: string, historical = false): StaffCartAuthority | null {
  const metadata = record(cart.metadata)
  const proof = verifiedValue(metadata[STAFF_CART_AUTHORITY], secret) as StaffCartAuthority | null
  const cartId = historical ? cart.cart_id || metadata.cart_id : cart.id
  if (!proof || proof.version !== 1 || !proof.cart_id || proof.cart_id !== cartId || !proof.actor_id
    || !["staff_phone_order", "staff_impersonation"].includes(proof.source)
    || !["collect_card_now", "send_checkout_link", "staff_impersonation"].includes(proof.payment_mode)
    || !Number.isSafeInteger(proof.session_iat) || !Number.isSafeInteger(proof.access_version)
    || !Number.isSafeInteger(proof.issued_at) || !Number.isSafeInteger(proof.expires_at)
    || proof.expires_at <= proof.issued_at || normalizedCartEmail(cart.email) !== proof.email
    || (proof.customer_id && cart.customer_id !== proof.customer_id)) return null
  if (!historical && (proof.issued_at > Date.now() || proof.expires_at <= Date.now())) return null
  return proof
}

export function cartHasStaffMarkers(cart: Record<string, any>): boolean {
  const m = record(cart.metadata)
  return Object.keys(m).some(k => k.startsWith("staff_") || k.startsWith("gp_staff_"))
    || String(m.source || "").startsWith("staff_")
}

export function serverOwnedCartKey(key: string): boolean {
  return key.startsWith("gp_staff_") || key === "cart_id" || key.startsWith("payment_")
    || key.startsWith("final_charge_") || key.startsWith("finalization_") || key.startsWith("catch_weight_final") || key.startsWith("fulfillment_gate_")
    || key.startsWith("qbd_posting_") || key.startsWith("quickbooks_posting_") || key.startsWith("gp_credit_")
    || key.startsWith("gp_payment_") || key.startsWith("gp_offline_")
}

export function staffCartMetadataKey(key: string, value?: unknown): boolean {
  return serverOwnedCartKey(key) || key.startsWith("staff_") || key.startsWith("created_by_staff_")
    || key.startsWith("inventory_override_") || (key === "source" && String(value || "").startsWith("staff_"))
}

export function staffCartActorFields(proof: StaffCartAuthority) {
  return { source: proof.source, staff_actor_customer_id: proof.actor_id, staff_actor_email: proof.actor_email,
    staff_actor_name: proof.actor_name, staff_selected_customer_id: proof.customer_id || "", staff_target_customer_id: proof.customer_id || "" }
}

export function staffCartRequestedDate(metadata: unknown): string {
  const m = record(metadata)
  return String(m.scheduledDate || m.requestedDeliveryDate || m.requested_fulfillment_date || m.fulfillment_date || "")
}

function overrideValue(cart: any, line: any, proof: StaffCartAuthority) {
  const m = record(line.metadata)
  return { kind: "inventory_override", cart_authority: record(cart.metadata)[STAFF_CART_AUTHORITY], cart_id: proof.cart_id,
    actor_id: proof.actor_id, variant_id: line.variant_id || line.variant?.id,
    quantity: Number(line.quantity), requested_date: staffCartRequestedDate(cart.metadata),
    reason: String(m.inventory_override_reason || "").trim(), note: String(m.inventory_override_note || "").trim() }
}

export function signStaffLineOverride(cart: any, line: any, proof: StaffCartAuthority, secret: string): string {
  return signStaffCartValue(overrideValue(cart, line, proof), secret)
}

export function verifiedStaffLineOverride(cart: any, line: any, proof: StaffCartAuthority | null, secret?: string): boolean {
  if (!proof) return false
  const expected = overrideValue(cart, line, proof)
  const value = verifiedValue(record(line.metadata)[STAFF_LINE_OVERRIDE], secret)
  return !!expected.reason && !!expected.note && !!expected.variant_id && expected.quantity > 0
    && !!value && JSON.stringify(value) === JSON.stringify(expected)
}
