import { randomUUID } from "node:crypto";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { ReceiptEmailError, selectedReceipt } from "./receipt-email";

export const RECEIPT_SNAPSHOT_KEY = "receipt_contact_snapshot_id";
const metadata = (value: any) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const stale = () =>
  new ReceiptEmailError(
    409,
    "receipt_contact_changed",
    "Your receipt email changed. Refresh checkout before placing the order."
  );

/** Server-owned, immutable rows; public cart metadata contains only a pointer. */
export async function prepareReceiptSnapshot(container: any, cartId: string) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  await db.transaction(async (trx: any) => {
    const cart = await trx("cart")
      .where({ id: cartId })
      .whereNull("deleted_at")
      .forUpdate()
      .first();
    if (!cart) throw stale();
    if (cart.completed_at) return;
    if (cart.customer_id)
      await trx("customer").where({ id: cart.customer_id }).forUpdate().first();
    const selected = await selectedReceipt(trx, cart.customer_id, cart.email);
    if (!selected.email) throw stale();
    const priorId = metadata(cart.metadata)[RECEIPT_SNAPSHOT_KEY];
    const prior =
      typeof priorId === "string"
        ? await trx("gp_receipt_snapshot")
            .where({ id: priorId, cart_id: cartId })
            .first()
        : null;
    if (
      prior &&
      prior.customer_id === (cart.customer_id || null) &&
      prior.email === selected.email &&
      Number(prior.contact_revision) === selected.revision
    )
      return;
    const id = `gprs_${randomUUID()}`;
    await trx("gp_receipt_snapshot").insert({
      id,
      cart_id: cartId,
      customer_id: cart.customer_id || null,
      email: selected.email,
      contact_revision: selected.revision,
      source: selected.source,
    });
    await trx("cart")
      .where({ id: cartId })
      .update({
        metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({ [RECEIPT_SNAPSHOT_KEY]: id }),
        ]),
        updated_at: new Date(),
      });
  });
}
export async function validateReceiptSnapshot(container: any, cart: any) {
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  if (await db("order_cart").where({ cart_id: cart.id }).first()) return;
  const id = metadata(cart.metadata)[RECEIPT_SNAPSHOT_KEY];
  if (typeof id !== "string") throw stale();
  const snapshot = await db("gp_receipt_snapshot")
    .where({ id, cart_id: cart.id })
    .first();
  const customerId = cart.customer_id || cart.customer?.id || null;
  const selected = await selectedReceipt(db, customerId, cart.email);
  if (
    !snapshot ||
    snapshot.customer_id !== customerId ||
    snapshot.email !== selected.email ||
    Number(snapshot.contact_revision) !== selected.revision
  )
    throw stale();
}
/** Old orders retain order.email. New orders resolve only their accepted pointer, never today's profile. */
export async function resolveOrderReceiptEmail(
  container: any,
  order: any
): Promise<string> {
  const id = metadata(order.metadata)[RECEIPT_SNAPSHOT_KEY];
  if (id === undefined || id === null) return String(order.email || "");
  if (typeof id !== "string") throw new Error("Invalid receipt snapshot");
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const snapshot = await db("gp_receipt_snapshot").where({ id }).first();
  const link = snapshot
    ? await db("order_cart")
        .where({ order_id: order.id, cart_id: snapshot.cart_id })
        .first()
    : null;
  if (
    !snapshot ||
    !link ||
    snapshot.customer_id !== (order.customer_id || null)
  )
    throw new Error("Order receipt snapshot ownership mismatch");
  return snapshot.email;
}
