import { createHash, randomUUID } from "node:crypto";
import { getSmallestUnit } from "@medusajs/payment-stripe/dist/utils/get-smallest-unit";
import { readOriginalOrderPromise } from "./order-promise";
import {
  refundId,
  stripeRefundEvidence,
  type RefundEvidence,
  type RefundScope,
} from "./stripe-refund-evidence";

const sameScope = (row: any, scope: RefundScope) =>
  row &&
  row.account_id === scope.account_id &&
  row.livemode === scope.livemode &&
  new Date(row.starts_at).toISOString() === scope.starts_at;
export async function pinRefundScope(
  db: any,
  scope: RefundScope,
  account: any
) {
  if (account?.object !== "account" || account.id !== scope.account_id)
    throw new Error("refund_account_mismatch");
  const epoch = await db("gp_order_publication_epoch").where({ id: 1 }).first();
  if (!epoch || new Date(epoch.starts_at).toISOString() !== scope.starts_at)
    throw new Error("refund_publication_epoch_unavailable");
  await db("gp_refund_provider_scope")
    .insert({ id: 1, ...scope })
    .onConflict("id")
    .ignore();
  if (
    !sameScope(
      await db("gp_refund_provider_scope").where({ id: 1 }).first(),
      scope
    )
  )
    throw new Error("refund_scope_changed");
}

/** Caller must verify the endpoint-specific signature over the raw bytes first.
 * Notification payloads only schedule a GET; they never decide the current status. */
export async function queueRefundNotification(
  db: any,
  scope: RefundScope,
  event: any
) {
  if (
    !["refund.created", "refund.updated", "refund.failed"].includes(event?.type)
  )
    return "ignored";
  if (
    !/^evt_[a-zA-Z0-9_]{1,190}$/.test(event.id) ||
    event.livemode !== scope.livemode ||
    event.account != null ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0
  )
    throw new Error("refund_event_scope_invalid");
  const evidence = stripeRefundEvidence(event.data?.object);
  if (evidence.provider_created_at < new Date(scope.starts_at))
    return "before_activation";
  const normalized = {
    event_id: event.id,
    refund_id: evidence.refund_id,
    event_type: event.type,
    event_created_at: new Date(event.created * 1000),
  };
  const hash = createHash("sha256")
    .update(JSON.stringify({ ...normalized, ...evidence }))
    .digest("hex");
  return db.transaction(async (trx: any) => {
    if (
      !sameScope(
        await trx("gp_refund_provider_scope").where({ id: 1 }).first(),
        scope
      )
    )
      throw new Error("refund_scope_not_verified");
    const inserted = await trx("gp_refund_provider_event")
      .insert({ ...normalized, payload_hash: hash })
      .onConflict("event_id")
      .ignore()
      .returning("event_id");
    const saved = await trx("gp_refund_provider_event")
      .where({ event_id: event.id })
      .first();
    if (saved.payload_hash !== hash) throw new Error("refund_event_conflict");
    if (!inserted.length) return "duplicate";
    await trx("gp_refund_provider_queue")
      .insert({ refund_id: evidence.refund_id })
      .onConflict("refund_id")
      .merge({
        due_at: trx.fn.now(),
        generation: trx.raw("gp_refund_provider_queue.generation + 1"),
      });
    return "queued";
  });
}

export async function claimRefundLease(db: any, scope: RefundScope) {
  const token = randomUUID();
  const rows = await db("gp_refund_provider_scope")
    .where({
      id: 1,
      account_id: scope.account_id,
      livemode: scope.livemode,
      starts_at: scope.starts_at,
    })
    .andWhere((q: any) =>
      q.whereNull("lease_until").orWhere("lease_until", "<", db.fn.now())
    )
    .update({
      lease_token: token,
      lease_until: db.raw("now() + interval '5 minutes'"),
    })
    .returning("id");
  return rows.length ? token : null;
}
async function fence(trx: any, token: string) {
  const scope = await trx("gp_refund_provider_scope")
    .where({ id: 1, lease_token: token })
    .where("lease_until", ">", trx.fn.now())
    .forUpdate()
    .first();
  if (!scope) throw new Error("refund_worker_lease_lost");
  return scope;
}
export async function queueRefundPage(
  db: any,
  token: string,
  page: any,
  after: string | null
) {
  if (
    page?.object !== "list" ||
    !Array.isArray(page.data) ||
    page.data.length > 100 ||
    typeof page.has_more !== "boolean" ||
    (page.has_more && !page.data.length)
  )
    throw new Error("refund_provider_page_invalid");
  const ids = page.data.map((r: any) => refundId(r.id));
  if (
    new Set(ids).size !== ids.length ||
    (page.has_more && ids[ids.length - 1] === after)
  )
    throw new Error("refund_provider_cursor_invalid");
  return db.transaction(async (trx: any) => {
    const scope = await fence(trx, token);
    if (scope.scan_after !== after)
      throw new Error("refund_provider_cursor_changed");
    if (ids.length)
      await trx("gp_refund_provider_queue")
        .insert(ids.map((refund_id: string) => ({ refund_id })))
        .onConflict("refund_id")
        .ignore();
    await trx("gp_refund_provider_scope")
      .where({ id: 1 })
      .update({ scan_after: page.has_more ? ids[ids.length - 1] : null });
    return ids.length;
  });
}

/** Resolve by exact provider/native identities. No fuzzy time/amount matching. */
async function bindRefund(trx: any, receipt: any, starts: Date) {
  const native = await trx("payment as p")
    .join(
      "order_payment_collection as l",
      "l.payment_collection_id",
      "p.payment_collection_id"
    )
    .whereRaw("p.data->>'id' = ?", [receipt.payment_intent_id])
    .whereNull("p.deleted_at")
    .whereNull("l.deleted_at")
    .select("p.id as payment_id", "p.currency_code", "l.order_id");
  const final = await trx("gp_order_finalization as f")
    .join("gp_final_charge_attempt as a", "a.id", "f.charge_attempt_id")
    .where("f.stripe_payment_intent_id", receipt.payment_intent_id)
    .where("a.stripe_payment_intent_id", receipt.payment_intent_id)
    .whereColumn("a.order_id", "f.order_id")
    .whereColumn("a.finalization_id", "f.id")
    .where("a.status", "succeeded")
    .where("a.stripe_status", "succeeded")
    .whereNull("a.deleted_at")
    .whereNull("f.deleted_at")
    .select("f.order_id", "f.currency_code");
  const orders = [
    ...new Set([...native, ...final].map((r: any) => r.order_id)),
  ];
  if (orders.length !== 1 || native.length > 1 || final.length > 1)
    throw new Error("refund_order_identity_unavailable");
  const orderId = orders[0];
  const original = await readOriginalOrderPromise(trx, String(orderId));
  if (
    new Date(original.placed_at) < starts ||
    receipt.provider_created_at < new Date(original.placed_at) ||
    original.promise.attribution.test_order !== !receipt.livemode ||
    original.promise.currency !== receipt.currency_code ||
    [...native, ...final].some(
      (r: any) => r.currency_code?.toLowerCase() !== receipt.currency_code
    )
  )
    throw new Error("refund_original_context_mismatch");
  let origin = "provider_only",
    nativeId: string | null = null;
  if (receipt.native_refund_hint) {
    const rows = await trx("refund")
      .where({ id: receipt.native_refund_hint })
      .whereNull("deleted_at");
    if (
      rows.length !== 1 ||
      native.length !== 1 ||
      rows[0].payment_id !== native[0].payment_id ||
      getSmallestUnit(Number(rows[0].amount), receipt.currency_code) !==
        Number(receipt.amount_minor)
    )
      throw new Error("refund_native_identity_unavailable");
    nativeId = rows[0].id;
    origin = "native";
  } else {
    const requests = await trx("gp_staff_refund_request").where({
      provider_refund_id: receipt.refund_id,
    });
    if (requests.length) {
      if (
        requests.length !== 1 ||
        requests[0].order_id !== orderId ||
        requests[0].payment_id !== `final_charge:${receipt.payment_intent_id}`
      )
        throw new Error("refund_direct_identity_conflict");
      origin = "final_charge";
    }
  }
  const previous = await trx("gp_refund_provider_binding")
    .where({ refund_id: receipt.refund_id })
    .first();
  if (previous) {
    if (previous.order_id !== orderId || previous.native_refund_id !== nativeId)
      throw new Error("refund_binding_conflict");
    return;
  }
  await trx("gp_refund_provider_binding").insert({
    refund_id: receipt.refund_id,
    order_id: orderId,
    native_refund_id: nativeId,
    origin,
  });
}

export async function recordRefundObservation(
  db: any,
  token: string,
  queue: any,
  value: any,
  now = new Date()
) {
  const evidence = stripeRefundEvidence(value);
  if (evidence.refund_id !== queue.refund_id)
    throw new Error("refund_requested_identity_mismatch");
  return db.transaction(async (trx: any) => {
    const scope = await fence(trx, token);
    if (
      evidence.provider_created_at < new Date(scope.starts_at) ||
      evidence.provider_created_at > now
    )
      throw new Error("refund_provider_time_invalid");
    const previous = await trx("gp_refund_provider_receipt")
      .where({ refund_id: evidence.refund_id })
      .orderBy("revision", "desc")
      .first();
    if (
      previous &&
      (previous.payment_intent_id !== evidence.payment_intent_id ||
        previous.native_refund_hint !== evidence.native_refund_hint ||
        Number(previous.amount_minor) !== evidence.amount_minor ||
        previous.currency_code !== evidence.currency_code ||
        new Date(previous.provider_created_at).getTime() !==
          evidence.provider_created_at.getTime())
    )
      throw new Error("refund_provider_facts_changed");
    const receipt = {
      ...evidence,
      account_id: scope.account_id,
      livemode: scope.livemode,
    };
    const changed = !previous || previous.status !== evidence.status;
    if (changed)
      await trx("gp_refund_provider_receipt").insert({
        ...receipt,
        id: `rr_${randomUUID().replace(/-/g, "")}`,
        revision: (previous?.revision || 0) + 1,
        observed_at: now,
      });
    let reason: string | null = null;
    // Keep authentic provider evidence even when the native order is temporarily missing.
    try {
      await trx.transaction((bind: any) =>
        bindRefund(bind, receipt, new Date(scope.starts_at))
      );
    } catch {
      reason = "refund_order_binding_unavailable";
    }
    const minutes =
      reason || ["pending", "requires_action"].includes(evidence.status)
        ? 5
        : 360;
    await trx("gp_refund_provider_queue")
      .where({ refund_id: queue.refund_id, generation: queue.generation })
      .update({
        due_at: new Date(now.getTime() + minutes * 60_000),
        attempts: 0,
        reason,
        last_checked_at: now,
      });
    return {
      changed,
      held: Boolean(reason),
      attention: ["failed", "canceled", "requires_action"].includes(
        evidence.status
      ),
    };
  });
}

export async function reconcileRefunds(
  db: any,
  scope: RefundScope,
  client: {
    account(): Promise<any>;
    list(starts: string, after: string | null): Promise<any>;
    refund(id: string): Promise<any>;
  }
) {
  await pinRefundScope(db, scope, await client.account());
  const token = await claimRefundLease(db, scope);
  const summary = {
    busy: !token,
    discovered: 0,
    observed: 0,
    held: 0,
    attention: 0,
    readFailures: 0,
  };
  if (!token) return summary;
  try {
    const saved = await db("gp_refund_provider_scope").where({ id: 1 }).first();
    try {
      summary.discovered = await queueRefundPage(
        db,
        token,
        await client.list(scope.starts_at, saved.scan_after),
        saved.scan_after
      );
    } catch {
      summary.readFailures++;
    }
    const queue = await db("gp_refund_provider_queue")
      .where("due_at", "<=", db.fn.now())
      .orderBy("due_at")
      .orderBy("refund_id")
      .limit(10);
    for (const item of queue) {
      try {
        const result = await recordRefundObservation(
          db,
          token,
          item,
          await client.refund(item.refund_id)
        );
        if (result.changed) summary.observed++;
        if (result.held) summary.held++;
        if (result.attention) summary.attention++;
      } catch {
        await db.transaction(async (trx: any) => {
          await fence(trx, token);
          await trx("gp_refund_provider_queue")
            .where({ refund_id: item.refund_id, generation: item.generation })
            .update({
              attempts: item.attempts + 1,
              reason: "refund_read_or_evidence_unavailable",
              due_at: trx.raw("now() + interval '5 minutes'"),
            });
        });
        summary.readFailures++;
      }
    }
    return summary;
  } finally {
    await db("gp_refund_provider_scope")
      .where({ id: 1, lease_token: token })
      .update({ lease_token: null, lease_until: null });
  }
}
