import { randomUUID } from "node:crypto";
import { claimRefundMeasurement } from "./refund-provider-publication";
import { OPERATIONAL_MEASUREMENT_EVENTS, isOperationalMeasurement, readOperationalMeasurement } from "./order-operational-measurement";
import {
  orderPromiseAnalytics,
  readOriginalOrderPromise,
} from "./order-promise";
import {
  LIFECYCLE_EVENTS,
  readLifecyclePublication,
  reconcileLifecyclePublications,
} from "./order-publication-lifecycle";

export const PUBLICATION_EVENTS = {
  placed: "order_completed",
  finalized: "order_finalized",
  ...LIFECYCLE_EVENTS,
  ...OPERATIONAL_MEASUREMENT_EVENTS,
} as const;
export type PublicationKind = keyof typeof PUBLICATION_EVENTS;
export type PublicationTarget =
  | "jitsu"
  | "gp_analytics"
  | "jitsu_rehearsal"
  | "gp_analytics_rehearsal"
  | "communications"
  | "communications_automation";
export type DeliveryResult = {
  status: "accepted" | "held" | "excluded";
  reason?: string;
};
export const PUBLICATION_TARGETS: PublicationTarget[] = [
  "jitsu",
  "gp_analytics",
  "communications",
  "communications_automation",
];
const retryAt = (now: Date, attempts: number) =>
  new Date(
    now.getTime() + Math.min(3600, 30 * 2 ** Math.min(attempts, 7)) * 1000
  );
const iso = (value: unknown) => {
  const date = new Date(value as any);
  if (value == null || !Number.isFinite(date.getTime()))
    throw new Error("publication_time_unavailable");
  return date.toISOString();
};
const cents = (value: unknown) => {
  const n = Number(value);
  if (
    value == null ||
    value === "" ||
    !Number.isFinite(n) ||
    n < 0 ||
    !Number.isSafeInteger(Math.round(n * 100)) ||
    Math.abs(n * 100 - Math.round(n * 100)) > 1e-6
  )
    throw new Error("publication_amount_unavailable");
  return n;
};

export function publicationIdentity(
  kind: PublicationKind,
  orderId: string,
  sourceId?: string
) {
  if (kind === "placed") return `order.placed:${orderId}:order_completed`;
  if (kind === "finalized")
    return `order.final_charge_succeeded:${orderId}:order_finalized`;
  if (!sourceId || !/^[a-zA-Z0-9_-]{1,200}$/.test(sourceId))
    throw new Error("publication_source_invalid");
  if (kind === "shipping_forecast") {
    if (sourceId !== orderId) throw new Error("publication_source_invalid");
    return `order.placed:${orderId}:shipping_forecast`;
  }
  if (isOperationalMeasurement(kind)) return `order.measurement:${kind}:${orderId}:${sourceId}`;
  return `order.lifecycle:${kind}:${orderId}:${sourceId}`;
}

/** Subscriber persists only an intent. No mutable-order fallback or network. */
export async function requestOrderPublication(
  db: any,
  kind: PublicationKind,
  orderId: string,
  sourceId?: string
) {
  if (
    !/^[a-zA-Z0-9_-]{1,200}$/.test(orderId) ||
    !Object.prototype.hasOwnProperty.call(PUBLICATION_EVENTS, kind)
  )
    throw new Error("publication_identity_invalid");
  await db("gp_order_publication")
    .insert({
      event_id: publicationIdentity(kind, orderId, sourceId),
      kind,
      order_id: orderId,
      source_id: sourceId || null,
    })
    .onConflict("event_id")
    .ignore();
}

/** Never infer a cutover or replay an older final-charge purchase into the new basis. */
export async function publicationEpoch(
  db: any,
  configured: string | undefined
) {
  if (!configured || !/^\d{4}-\d\d-\d\dT.*Z$/.test(configured))
    throw new Error("publication_epoch_required");
  const starts = iso(configured);
  await db("gp_order_publication_epoch")
    .insert({ id: 1, starts_at: starts })
    .onConflict("id")
    .ignore();
  const saved = await db("gp_order_publication_epoch").where({ id: 1 }).first();
  if (iso(saved.starts_at) !== starts)
    throw new Error("publication_epoch_changed");
  return new Date(starts);
}

/** Repairs a missed source event using only successful native bindings and actual
 * final-charge records. Bounded anti-joins ensure later runs advance the backlog. */
export async function reconcileOrderPublications(
  db: any,
  starts: Date,
  limit = 100
) {
  const bindings = await db("gp_order_promise_binding as b")
    .where("b.placed_at", ">=", starts)
    .whereNotExists(
      db("gp_order_publication as p")
        .select(db.raw("1"))
        .whereColumn("p.order_id", "b.order_id")
        .where("p.kind", "placed")
    )
    .orderBy("b.placed_at")
    .orderBy("b.order_id")
    .limit(limit)
    .select("b.order_id");
  for (const b of bindings)
    await requestOrderPublication(db, "placed", b.order_id);
  const finals = await db("gp_order_finalization as f")
    .join("gp_order_promise_binding as b", "b.order_id", "f.order_id")
    .whereNull("f.deleted_at")
    .whereNotNull("f.charged_at")
    .where("b.placed_at", ">=", starts)
    .whereNotExists(
      db("gp_order_publication as p")
        .select(db.raw("1"))
        .whereColumn("p.order_id", "f.order_id")
        .where("p.kind", "finalized")
    )
    .orderBy("f.charged_at")
    .orderBy("f.order_id")
    .limit(limit)
    .select("f.order_id", "f.id");
  for (const f of finals)
    await requestOrderPublication(db, "finalized", f.order_id, f.id);
  const lifecycle = await reconcileLifecyclePublications(
    db,
    starts,
    (kind, orderId, sourceId) =>
      requestOrderPublication(db, kind, orderId, sourceId),
    limit
  );
  return {
    placements: bindings.length,
    finalizations: finals.length,
    lifecycle,
  };
}

export function originalPublicationProperties(original: any) {
  const evidence = orderPromiseAnalytics(original);
  const p = original.promise;
  // This is a purpose-specific allowlist. Never serialize the private promise.
  return {
    ...evidence,
    transaction_id: original.order_id,
    cart_id: p.cart_id,
    customer_id: p.customer_id,
    currency_code: p.currency,
    value: p.placement_total,
    total: p.placement_total,
    estimated_value: p.placement_total,
    item_count: p.lines.length,
    tax: p.tax_total,
    shipping: p.shipping_total,
    discount: p.discount_total,
    source: "medusa-server",
    payment_evidence: "not_implied_by_placement",
    fulfillment_mode: p.fulfillment.mode,
    experiment_context: Object.fromEntries(
      p.attribution.experiment_assignments.map((a: any) => [
        a.experiment_id,
        {
          variant_key: a.variant,
          assignment_id: a.assignment_id,
          version: a.version,
          evaluation_version: a.evaluation_version ?? null,
        },
      ])
    ),
  };
}

export async function materializeOrderPublications(
  db: any,
  starts: Date,
  now = new Date(),
  limit = 100
) {
  let ready = 0,
    waiting = 0;
  for (let i = 0; i < limit; i++) {
    const outcome = await db.transaction(async (trx: any) => {
      const intent = await trx("gp_order_publication")
        .where({ state: "waiting" })
        .where("next_attempt_at", "<=", now)
        .orderBy("created_at")
        .forUpdate()
        .skipLocked()
        .first();
      if (!intent) return "empty";
      // Savepoint allows a malformed/missing prerequisite to retain its retry
      // receipt even when a SQL read fails. No external side effects here.
      try {
        return await trx.transaction(async (read: any) => {
          const original = await readOriginalOrderPromise(
            read,
            intent.order_id
          );
          const properties: any = originalPublicationProperties(original);
          if (new Date(properties.placed_at) < starts) {
            await read("gp_order_publication")
              .where({ event_id: intent.event_id })
              .update({
                state: "excluded",
                reason: "before_activation",
                ready_at: now,
              });
            return "excluded";
          }
          if (new Date(properties.placed_at) > now)
            throw new Error("publication_placement_time_invalid");
          let at = properties.placed_at;
          if (intent.kind === "finalized") {
            const f = await read("gp_order_finalization")
              .where({ order_id: intent.order_id })
              .whereNull("deleted_at")
              .first();
            const a =
              f?.charge_attempt_id &&
              (await read("gp_final_charge_attempt")
                .where({
                  id: f.charge_attempt_id,
                  order_id: intent.order_id,
                  finalization_id: f.id,
                  status: "succeeded",
                  stripe_status: "succeeded",
                })
                .whereNull("deleted_at")
                .first());
            if (
              !a ||
              !f.charged_at ||
              !a.succeeded_at ||
              !a.stripe_payment_intent_id ||
              f.stripe_payment_intent_id !== a.stripe_payment_intent_id ||
              (intent.source_id && intent.source_id !== f.id)
            )
              throw new Error("publication_finalization_unavailable");
            const amount = cents(a.amount);
            if (
              amount !== cents(f.final_order_total) ||
              String(a.currency_code).toLowerCase() !== properties.currency ||
              String(f.currency_code).toLowerCase() !== properties.currency
            )
              throw new Error("publication_finalization_mismatch");
            at = iso(a.succeeded_at);
            if (
              new Date(at) > now ||
              new Date(at) < new Date(properties.placed_at)
            )
              throw new Error("publication_finalization_time_invalid");
            Object.assign(properties, {
              value: amount,
              total: amount,
              final_value: amount,
              delta:
                Math.round((amount - properties.placement_total) * 100) / 100,
              amount_basis: "successful_final_charge_v1",
              payment_evidence: "recorded_successful_final_charge",
              finalization_id: f.id,
            });
          } else if (isOperationalMeasurement(intent.kind)) {
            const fact = await readOperationalMeasurement(read, intent, original);
            if (!fact) {
              await read("gp_order_publication").where({ event_id: intent.event_id })
                .update({ state: "excluded", reason: "not_carrier_shipping", ready_at: now });
              return "excluded";
            }
            at = iso(fact.at);
            if (new Date(at) > now || new Date(at) < new Date(properties.placed_at))
              throw new Error("operational_measurement_time_invalid");
            for (const field of ["value", "total", "estimated_value", "tax", "shipping", "discount", "items", "item_count"])
              delete properties[field];
            Object.assign(properties, fact.properties);
          } else if (
            Object.prototype.hasOwnProperty.call(LIFECYCLE_EVENTS, intent.kind)
          ) {
            const fact = await readLifecyclePublication(read, intent);
            if ("livemode" in fact && properties.test_order !== !fact.livemode)
              throw new Error("publication_refund_mode_mismatch");
            at = iso(fact.at);
            if (
              new Date(at) > now ||
              new Date(at) < new Date(properties.placed_at)
            )
              throw new Error("publication_lifecycle_time_invalid");
            if (
              "currency" in fact.properties &&
              fact.properties.currency !== properties.currency
            )
              throw new Error("publication_lifecycle_currency_mismatch");
            // These facts are separate from gross placement. In particular a
            // cancellation/delivery must not look like another order's value,
            // and a refund must not claim all original line items were returned.
            for (const field of [
              "value",
              "total",
              "estimated_value",
              "tax",
              "shipping",
              "discount",
              "items",
              "item_count",
            ])
              delete properties[field];
            Object.assign(properties, {
              amount_basis: "non_monetary_lifecycle_v1",
              payment_evidence: "not_implied_by_lifecycle",
              ...fact.properties,
            });
            if (
              ["refunded", "refund_updated"].includes(intent.kind) &&
              properties.refund_provider_status === "succeeded"
            )
              properties.ga4_refund_owner = await claimRefundMeasurement(
                read,
                intent,
                properties
              );
          }
          Object.assign(properties, {
            idempotency_key: intent.event_id,
            medusa_event_id: intent.event_id,
            occurred_at: iso(at),
            event_timestamp_ms: new Date(at).getTime(),
          });
          await read("gp_order_publication")
            .where({ event_id: intent.event_id })
            .update({
              state: "ready",
              properties,
              actor_id: original.customer_id,
              ready_at: now,
              reason: null,
            });
          await read("gp_order_publication_delivery")
            .insert(
              [
                ...(isOperationalMeasurement(intent.kind) ? ["jitsu", "gp_analytics"] : PUBLICATION_TARGETS),
                ...(properties.test_order === true
                  ? ["jitsu_rehearsal", "gp_analytics_rehearsal"]
                  : []),
              ].map((target) => ({
                event_id: intent.event_id,
                target,
                next_attempt_at: now,
              }))
            )
            .onConflict(["event_id", "target"])
            .ignore();
          return "ready";
        });
      } catch {
        await trx("gp_order_publication")
          .where({ event_id: intent.event_id })
          .update({
            attempts: intent.attempts + 1,
            reason: isOperationalMeasurement(intent.kind) ? "original_or_operational_evidence_unavailable" : Object.prototype.hasOwnProperty.call(
              LIFECYCLE_EVENTS,
              intent.kind
            )
              ? "original_or_lifecycle_evidence_unavailable"
              : "original_or_finalization_evidence_unavailable",
            next_attempt_at: retryAt(now, intent.attempts + 1),
          });
        return "waiting";
      }
    });
    if (outcome === "empty") break;
    if (outcome === "waiting") waiting++;
    else ready++;
  }
  return { ready, waiting };
}

export function publicationEligibility(
  target: PublicationTarget,
  properties: any
): DeliveryResult | null {
  if (target === "communications") return null; // Operational truth is not marketing consent.
  const rehearsal =
    target === "jitsu_rehearsal" || target === "gp_analytics_rehearsal";
  if (rehearsal && properties.test_order === false)
    return { status: "excluded", reason: "production_order" };
  if (!rehearsal && properties.test_order === true)
    return { status: "excluded", reason: "test_order" };
  if (properties.test_order !== (rehearsal ? true : false))
    return { status: "held", reason: "test_classification_unknown" };
  if (target === "communications_automation") return null; // Existing purpose consent, suppressions and holdouts still apply.
  if (properties.analytics_consent === false)
    return { status: "excluded", reason: "analytics_opt_out" };
  if (properties.analytics_consent !== true)
    return { status: "held", reason: "analytics_consent_unknown" };
  if (
    properties.experiment_context_status !== "complete" ||
    !Array.isArray(properties.experiment_assignments) ||
    properties.experiment_assignments.some((a: any) => !a.version)
  )
    return { status: "held", reason: "experiment_context_unknown" };
  return null;
}

export async function claimPublicationDelivery(db: any, now = new Date()) {
  return db.transaction(async (trx: any) => {
    const row = await trx("gp_order_publication_delivery")
      .where("next_attempt_at", "<=", now)
      .where((q: any) =>
        q
          .whereIn("status", ["pending", "retry", "held"])
          .orWhere((x: any) =>
            x.where("status", "inflight").where("lease_until", "<=", now)
          )
      )
      .orderBy("next_attempt_at")
      .orderBy("event_id")
      .forUpdate()
      .skipLocked()
      .first();
    if (!row) return null;
    const token = randomUUID();
    await trx("gp_order_publication_delivery")
      .where({ event_id: row.event_id, target: row.target })
      .update({
        status: "inflight",
        lease_token: token,
        lease_until: new Date(now.getTime() + 90_000),
        attempts: row.attempts + 1,
        updated_at: now,
      });
    const publication = await trx("gp_order_publication")
      .where({ event_id: row.event_id, state: "ready" })
      .first();
    if (!publication) throw new Error("publication_not_ready");
    return {
      ...row,
      ...publication,
      target: row.target as PublicationTarget,
      attempts: row.attempts + 1,
      lease_token: token,
    };
  });
}

/** Pending test or unclassified facts must not page the production destination. */
export async function hasProductionPublicationBacklog(db: any) {
  return Boolean(await db("gp_order_publication as p")
    .join("gp_order_publication_delivery as d", "d.event_id", "p.event_id")
    .where("p.state", "ready")
    .whereRaw("p.properties -> 'test_order' = 'false'::jsonb")
    .whereIn("d.status", ["pending", "held", "retry"])
    .whereIn("d.target", ["jitsu", "gp_analytics", "communications", "communications_automation"])
    .select("p.event_id").first());
}

export async function settlePublicationDelivery(
  db: any,
  claim: any,
  result: DeliveryResult | { status: "retry"; reason: string },
  now = new Date()
) {
  return db("gp_order_publication_delivery")
    .where({
      event_id: claim.event_id,
      target: claim.target,
      status: "inflight",
      lease_token: claim.lease_token,
    })
    .update({
      status: result.status,
      reason: result.reason || null,
      lease_token: null,
      lease_until: null,
      accepted_at: result.status === "accepted" ? now : null,
      updated_at: now,
      next_attempt_at: retryAt(now, claim.attempts),
    });
}

export async function deliverOrderPublications(
  db: any,
  send: (claim: any) => Promise<DeliveryResult>,
  now = new Date(),
  limit = 50
) {
  const counts = { accepted: 0, held: 0, excluded: 0, retry: 0 };
  for (let i = 0; i < limit; i++) {
    const claim = await claimPublicationDelivery(db, now);
    if (!claim) break;
    let result: DeliveryResult | { status: "retry"; reason: string };
    try {
      result =
        publicationEligibility(claim.target, claim.properties) ||
        (await send(claim));
    } catch {
      result = { status: "retry", reason: "delivery_not_acknowledged" };
    }
    if (await settlePublicationDelivery(db, claim, result, now))
      counts[result.status]++;
  }
  return counts;
}
