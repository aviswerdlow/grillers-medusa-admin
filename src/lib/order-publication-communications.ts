import { recordCommunicationEvent } from "./communications/core";
import { syncCartLifecycleFromEvent } from "./communications/cart-lifecycle";
import { attributeOrderFromEvent } from "./communications/attribution";
import { evaluateFlowsForEvent } from "./communications/flows";
import {
  PUBLICATION_EVENTS,
  type PublicationKind,
  type DeliveryResult,
} from "./order-publication";

/** Locks the live lease while SQL consumers commit. A stale worker may not
 * record a receipt or increment counters after another owner takes over. */
export async function deliverPublicationToCommunications(
  db: any,
  claim: any
): Promise<DeliveryResult> {
  return db.transaction(async (trx: any) => {
    const lease = await trx("gp_order_publication_delivery")
      .where({
        event_id: claim.event_id,
        target: claim.target,
        status: "inflight",
        lease_token: claim.lease_token,
      })
      .forUpdate()
      .first();
    if (!lease) throw new Error("publication_lease_lost");
    const p = claim.properties;
    // Preserve existing communications trigger names without creating a second
    // event or transport. Analytics uses order_shipped/order_delivered.
    const eventName =
      claim.kind === "shipped"
        ? "shipment_created"
        : claim.kind === "delivered"
        ? "delivery_created"
        : PUBLICATION_EVENTS[claim.kind as PublicationKind];
    if (claim.target === "communications_automation") {
      const recorded = await trx("gp_order_publication_delivery")
        .where({
          event_id: claim.event_id,
          target: "communications",
          status: "accepted",
        })
        .first();
      if (!recorded)
        return { status: "held", reason: "communications_record_pending" };
      const event = await trx("gp_communication_event")
        .where({ event_id: claim.event_id })
        .whereNull("deleted_at")
        .first();
      if (!event)
        throw new Error("publication_communications_record_unavailable");
      // Each order is serialized, and both consumers retain their stable event
      // identity on a crash/retry. No Postmark send happens in this worker.
      await attributeOrderFromEvent(trx, event);
      await evaluateFlowsForEvent(trx, event);
      return { status: "accepted" };
    }
    // Do not copy the accepted receipt email into login/marketing identity.
    // Customer/profile sync owns contacts and purpose-specific opt-ins.
    const event = await recordCommunicationEvent(
      trx,
      {
        event_id: claim.event_id,
        event_name: eventName,
        source: "medusa-server",
        medusa_customer_id: claim.actor_id,
        order_id: claim.order_id,
        cart_id: p.cart_id,
        occurred_at: p.occurred_at,
        properties: p,
        context: { experiment_context: p.experiment_context },
      },
      { deferSideEffects: true }
    );
    if (event.order_id !== claim.order_id || event.event_name !== eventName)
      throw new Error("publication_communications_identity_conflict");
    await syncCartLifecycleFromEvent(trx, event);
    if (claim.kind === "placed" && p.test_order === false && event.profile_id) {
      const inserted = await trx("gp_order_publication_profile")
        .insert({
          order_id: claim.order_id,
          event_id: claim.event_id,
          profile_id: event.profile_id,
          placement_total: p.placement_total,
          placed_at: p.placed_at,
        })
        .onConflict("order_id")
        .ignore()
        .returning("order_id");
      if (inserted.length) {
        await trx("gp_customer_profile")
          .where({ id: event.profile_id })
          .update({
            total_orders: trx.raw("coalesce(total_orders,0) + 1"),
            total_revenue: trx.raw("coalesce(total_revenue,0) + ?", [
              p.placement_total,
            ]),
            avg_order_value: trx.raw(
              "(coalesce(total_revenue,0) + ?) / (coalesce(total_orders,0) + 1)",
              [p.placement_total]
            ),
            first_order_at: trx.raw(
              "least(coalesce(first_order_at, ?::timestamptz), ?::timestamptz)",
              [p.placed_at, p.placed_at]
            ),
            last_order_at: trx.raw(
              "greatest(coalesce(last_order_at, ?::timestamptz), ?::timestamptz)",
              [p.placed_at, p.placed_at]
            ),
            first_basket_size: trx.raw(
              "case when first_order_at is null or first_order_at > ?::timestamptz then ? else first_basket_size end",
              [p.placed_at, p.item_count]
            ),
            updated_at: new Date(),
          });
      }
    }
    return { status: "accepted" };
  });
}
