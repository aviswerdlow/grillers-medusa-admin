import { permitsPrimaryDestination } from "../customer-contact-state"

/** Re-read the owner, not queued traits or another account sharing a phone. */
export async function permitsCustomerSmsDestination(db: any, customerId: unknown, phone: unknown, consentAt: unknown) {
  if (!customerId) return true // Guest orders still require their own exact consent.
  const customer = await db("customer").select("metadata").where({ id: customerId }).whereNull("deleted_at").first()
  return Boolean(customer && permitsPrimaryDestination(customer.metadata, phone, consentAt))
}
