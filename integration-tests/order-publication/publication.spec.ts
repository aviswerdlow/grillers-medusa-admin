import { randomUUID } from "node:crypto";
import { Migration20260920235000 } from "../../src/modules/gp-communications/migrations/Migration20260920235000";
import { Migration20260920223000 } from "../../src/modules/gp-communications/migrations/Migration20260920223000";
import { pinRehearsalRoute } from "../../src/lib/order-publication-rehearsal";
import { Migration20260920174500 } from "../../src/modules/gp-catch-weight/migrations/Migration20260920174500";
import { Migration20260531183000 } from "../../src/modules/gp-catch-weight/migrations/Migration20260531183000";
import { Migration20260526120000 } from "../../src/modules/gp-communications/migrations/Migration20260526120000";
import { Migration20260526123000 } from "../../src/modules/gp-communications/migrations/Migration20260526123000";
import { Migration20260526133000 } from "../../src/modules/gp-communications/migrations/Migration20260526133000";
import { Migration20260920214500 } from "../../src/modules/gp-communications/migrations/Migration20260920214500";
import {
  acceptOrderPromiseReview,
  bindOrderPromise,
  createOrderPromiseReview,
  ORDER_PROMISE_KEY,
} from "../../src/lib/order-promise";
import {
  completedPromiseCart,
  promiseFixture,
  promiseNow,
} from "../../src/lib/__tests__/fixtures/order-promise";
import {
  claimPublicationDelivery,
  deliverOrderPublications,
  materializeOrderPublications,
  publicationEpoch,
  publicationIdentity,
  reconcileOrderPublications,
  requestOrderPublication,
  settlePublicationDelivery,
} from "../../src/lib/order-publication";
import { deliverPublicationToCommunications } from "../../src/lib/order-publication-communications";

// No external transports or messages in an isolated SQL fixture.
jest.mock("../../src/lib/communications/destinations", () => ({
  writeEventDestinations: jest.fn(),
}));
jest.mock("../../src/lib/communications/queue", () => ({
  enqueueCommunicationEvent: jest.fn().mockResolvedValue(true),
}));
const knex = require("knex"),
  schema = `gp_publication_${randomUUID().replace(/-/g, "")}`;
let db: any, admin: any;
const starts = new Date("2026-09-20T00:00:00Z"),
  now = new Date(Date.now() + 60_000);
const later = (seconds = 3600) => new Date(now.getTime() + seconds * 1000);
beforeAll(async () => {
  const explicit = process.env.ORDER_PUBLICATION_TEST_DATABASE_URL;
  if (!explicit)
    throw new Error(
      "Explicit isolated publication database required; DATABASE_URL is never used"
    );
  const url = new URL(explicit);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/gp_(launch|order_publications)$/.test(url.pathname)
  )
    throw new Error("Only a local publication fixture database is allowed");
  admin = knex({ client: "pg", connection: explicit });
  await admin.raw(`create schema ${schema}`);
  db = knex({
    client: "pg",
    connection: explicit,
    searchPath: [schema],
    pool: { min: 0, max: 12 },
  });
  await db.raw(
    "create table cart (id text primary key, customer_id text, email text, metadata jsonb, completed_at timestamptz, deleted_at timestamptz, updated_at timestamptz)"
  );
  await db.raw(
    'create table "order" (id text primary key, customer_id text, metadata jsonb, total numeric, created_at timestamptz, deleted_at timestamptz, status text, canceled_at timestamptz)'
  );
  await db.raw(
    "create table order_cart (order_id text primary key, cart_id text unique, deleted_at timestamptz)"
  );
  for (const sql of [
    "create table fulfillment (id text primary key, created_at timestamptz, shipped_at timestamptz, delivered_at timestamptz, deleted_at timestamptz)",
    "create table order_fulfillment (id text primary key, order_id text, fulfillment_id text, deleted_at timestamptz)",
    'create table "return" (id text primary key, order_id text, requested_at timestamptz, deleted_at timestamptz)',
    "create table payment (id text primary key, payment_collection_id text, currency_code text, deleted_at timestamptz)",
    "create table order_payment_collection (id text primary key, order_id text, payment_collection_id text, deleted_at timestamptz)",
    "create table refund (id text primary key, payment_id text, amount numeric, deleted_at timestamptz)",
    "create table order_transaction (id text primary key, order_id text, reference text, reference_id text, amount numeric, currency_code text, created_at timestamptz, deleted_at timestamptz)",
    "create table gp_staff_refund_request (id text primary key, order_id text, payment_id text, status text, provider_refund_id text, response jsonb)",
  ])
    await db.raw(sql);
  for (const migration of [
    Migration20260920174500,
    Migration20260531183000,
    Migration20260526120000,
    Migration20260526123000,
    Migration20260526133000,
    Migration20260920214500,
    Migration20260920223000,
    Migration20260920235000,
  ]) {
    const sql: string[] = [];
    await migration.prototype.up.call({
      addSql: (s: string) => sql.push(s),
    } as any);
    for (const statement of sql) await db.raw(statement);
  }
});
afterAll(async () => {
  if (db) await db.destroy();
  if (admin) {
    await admin.raw(`drop schema if exists ${schema} cascade`);
    await admin.destroy();
  }
});
beforeEach(async () => {
  const tables = (
    await db.raw("select tablename from pg_tables where schemaname = ?", [
      schema,
    ])
  ).rows;
  await db.raw(
    `truncate ${tables.map((r: any) => `"${r.tablename}"`).join(", ")} cascade`
  );
});
async function prepared(suffix = "1", total = 91.25, attribution: any = {}) {
  const cart = `cart_${suffix}`,
    order = `order_${suffix}`;
  const promise = promiseFixture(cart, "cus_publication");
  promise.placement_total = total;
  promise.attribution = {
    ...promise.attribution,
    test_order: false,
    analytics_consent: true,
    experiment_context_status: "complete",
    experiment_assignments: [],
    ...attribution,
  };
  await db("cart").insert({
    id: cart,
    customer_id: promise.customer_id,
    email: promise.contact.checkout_email,
    metadata: {},
  });
  const review = await createOrderPromiseReview(db, {
    promise,
    requestId: randomUUID(),
    now: promiseNow,
    expiresAt: new Date(promiseNow.getTime() + 900_000),
  });
  const snapshot = await acceptOrderPromiseReview(db, {
    currentPromise: promise,
    reviewId: review.id,
    requestId: randomUUID(),
    now: promiseNow,
  });
  await db("cart").where({ id: cart }).update({ completed_at: promiseNow });
  await db("order").insert({
    id: order,
    customer_id: promise.customer_id,
    metadata: { [ORDER_PROMISE_KEY]: snapshot.id },
    total: 999,
    created_at: promiseNow,
  });
  await db("order_cart").insert({ order_id: order, cart_id: cart });
  return {
    cart,
    order,
    promise,
    bind: () => bindOrderPromise(db, cart, completedPromiseCart(cart, order)),
  };
}
async function bound(suffix = "1", total = 91.25, attribution: any = {}) {
  const x = await prepared(suffix, total, attribution);
  await x.bind();
  return x;
}
async function final(order: string, amount = 100) {
  const id = `final_${order}`,
    at = new Date(promiseNow.getTime() + 60_000);
  await db("gp_final_charge_attempt").insert({
    id: `attempt_${order}`,
    order_id: order,
    finalization_id: id,
    amount,
    currency_code: "usd",
    stripe_payment_method_id: "pm_fixture",
    stripe_payment_intent_id: "pi_fixture",
    status: "succeeded",
    stripe_status: "succeeded",
    succeeded_at: at,
  });
  await db("gp_order_finalization").insert({
    id,
    order_id: order,
    charge_attempt_id: `attempt_${order}`,
    final_order_total: amount,
    currency_code: "usd",
    stripe_payment_intent_id: "pi_fixture",
    charged_at: at,
  });
  return { id, at };
}
async function ready() {
  await reconcileOrderPublications(db, starts);
  await materializeOrderPublications(db, starts, now);
}
const accepted = async () => ({ status: "accepted" as const });

const actionTime = () => new Date(promiseNow.getTime() + 120_000);
async function refundFixture(
  order: string,
  id: string,
  value = 12.5,
  transaction = true
) {
  await db("payment")
    .insert({
      id: `pay_${order}`,
      payment_collection_id: `pc_${order}`,
      currency_code: "usd",
    })
    .onConflict("id")
    .ignore();
  await db("order_payment_collection")
    .insert({
      id: `link_${order}`,
      order_id: order,
      payment_collection_id: `pc_${order}`,
    })
    .onConflict("id")
    .ignore();
  await db("refund").insert({ id, payment_id: `pay_${order}`, amount: value });
  if (transaction)
    await db("order_transaction").insert({
      id: `tx_${id}`,
      order_id: order,
      reference: "refund",
      reference_id: id,
      amount: -value,
      currency_code: "usd",
      created_at: actionTime(),
    });
}
async function directRefundFixture(order: string, status: string) {
  const id = `re_${order}`,
    paymentId = `final_charge:pi_${order}`;
  await db("gp_staff_refund_request").insert({
    id: `request_${order}`,
    order_id: order,
    payment_id: paymentId,
    status: "succeeded",
    provider_refund_id: id,
    response: {
      payment: {
        id: paymentId,
        currency_code: "usd",
        refunds: [
          {
            id,
            amount: 12.5,
            data: {
              id,
              status,
              amount: 1250,
              currency: "usd",
              payment_intent: `pi_${order}`,
            },
          },
        ],
      },
    },
  });
  await db("order_transaction").insert({
    id: `tx_${id}`,
    order_id: order,
    reference: "refund",
    reference_id: id,
    amount: -12.5,
    currency_code: "usd",
    created_at: actionTime(),
  });
}

it("recovers lifecycle facts without transient events and does not equate completed with delivered", async () => {
  const x = await bound();
  await db("order").where({ id: x.order }).update({ status: "completed" });
  await ready();
  expect(await db("gp_order_publication")).toHaveLength(1);
  await db("fulfillment").insert({ id: "ful_1", created_at: actionTime() });
  await ready(); // A fulfillment without its native order link is not evidence.
  expect(await db("gp_order_publication")).toHaveLength(1);
  await db("order_fulfillment").insert({
    id: "link_ful",
    order_id: x.order,
    fulfillment_id: "ful_1",
  });
  await ready();
  expect(
    (
      await db("gp_order_publication")
        .where({ kind: "fulfillment_created" })
        .first()
    ).properties
  ).toMatchObject({ fulfillment_id: "ful_1", lifecycle_scope: "fulfillment" });
  expect(
    await db("gp_order_publication").whereIn("kind", ["shipped", "delivered"])
  ).toHaveLength(0);
  await db("fulfillment")
    .where({ id: "ful_1" })
    .update({ shipped_at: actionTime(), delivered_at: actionTime() });
  await db("order")
    .where({ id: x.order })
    .update({ status: "canceled", canceled_at: actionTime(), total: 8888 });
  await db("return").insert({
    id: "return_1",
    order_id: x.order,
    requested_at: actionTime(),
  });
  await Promise.all([
    reconcileOrderPublications(db, starts),
    reconcileOrderPublications(db, starts),
  ]);
  await materializeOrderPublications(db, starts, now);
  const rows = await db("gp_order_publication");
  expect(rows).toHaveLength(6);
  for (const row of rows.filter((r: any) => r.kind !== "placed")) {
    expect(row.state).toBe("ready");
    expect(row.properties).toMatchObject({
      test_order: false,
      analytics_consent: true,
      placement_total: 91.25,
      event_timestamp_ms: actionTime().getTime(),
    });
    expect(row.properties).not.toHaveProperty("value");
    expect(row.properties).not.toHaveProperty("tax");
  }
  expect(rows.find((r: any) => r.kind === "placed").properties.value).toBe(
    91.25
  );
});

it("keeps equal partial refunds distinct, waits for native transactions and preserves original test context", async () => {
  const x = await bound("test", 91.25, { test_order: true });
  await refundFixture(x.order, "ref_1", 12.5, false);
  await ready();
  expect(
    await db("gp_order_publication").where({ kind: "refunded" })
  ).toHaveLength(0);
  await db("order_transaction").insert({
    id: "tx_ref_1",
    order_id: x.order,
    reference: "refund",
    reference_id: "ref_1",
    amount: -12.5,
    currency_code: "usd",
    created_at: actionTime(),
  });
  await refundFixture(x.order, "ref_2");
  await ready();
  await ready();
  const refunds = await db("gp_order_publication")
    .where({ kind: "refunded" })
    .orderBy("source_id");
  expect(refunds).toHaveLength(2);
  expect(new Set(refunds.map((r: any) => r.event_id)).size).toBe(2);
  for (const row of refunds) {
    expect(row.properties).toMatchObject({
      value: 12.5,
      refund_status: "recorded",
      refund_provider_status: "unverified",
      test_order: true,
      analytics_consent: true,
      amount_basis: "recorded_refund_v1",
    });
    expect(row.properties).not.toHaveProperty("items");
    expect(
      await db("gp_order_publication_delivery").where({
        event_id: row.event_id,
      })
    ).toHaveLength(6);
  }
  await deliverOrderPublications(db, accepted, now, 100);
  for (const row of refunds) {
    expect(
      (
        await db("gp_order_publication_delivery")
          .where({ event_id: row.event_id, target: "jitsu" })
          .first()
      ).reason
    ).toBe("test_order");
    expect(
      (
        await db("gp_order_publication_delivery")
          .where({ event_id: row.event_id, target: "jitsu_rehearsal" })
          .first()
      ).status
    ).toBe("accepted");
  }
});

it("holds a conflicting refund amount and recovers only after the native evidence agrees", async () => {
  const x = await bound();
  await refundFixture(x.order, "ref_1");
  await db("order_transaction").update({ amount: -99 });
  await ready();
  const row = await db("gp_order_publication")
    .where({ kind: "refunded" })
    .first();
  expect(row.state).toBe("waiting");
  expect(row.reason).toBe("original_or_lifecycle_evidence_unavailable");
  expect(
    await db("gp_order_publication_delivery").where({ event_id: row.event_id })
  ).toHaveLength(0);
  await db("order_transaction").update({ amount: -12.5 });
  await materializeOrderPublications(db, starts, later());
  expect(
    (await db("gp_order_publication").where({ event_id: row.event_id }).first())
      .properties.value
  ).toBe(12.5);
});

it.each(["pending", "succeeded"])(
  "preserves direct-provider refund status %s without claiming bank settlement",
  async (status) => {
    const x = await bound();
    await directRefundFixture(x.order, status);
    await ready();
    const row = await db("gp_order_publication")
      .where({ kind: "refunded" })
      .first();
    expect(row.state).toBe("ready");
    expect(row.properties).toMatchObject({
      value: 12.5,
      refund_provider_status: status,
      payment_evidence: "recorded_refund_not_bank_settlement",
    });
    expect(JSON.stringify(row.properties)).not.toContain(`pi_${x.order}`);
  }
);

it.each(["failed", "canceled"])(
  "does not publish a completed staff request when its provider receipt is %s",
  async (status) => {
    const x = await bound();
    await directRefundFixture(x.order, status);
    await ready();
    expect(
      (await db("gp_order_publication").where({ kind: "refunded" }).first())
        .state
    ).toBe("waiting");
  }
);

it("does not discover pre-epoch lifecycle facts or publish a return without a confirmed request", async () => {
  const x = await bound();
  await refundFixture(x.order, "ref_1");
  await db("return").insert({ id: "return_1", order_id: x.order });
  await reconcileOrderPublications(db, later());
  expect(await db("gp_order_publication")).toHaveLength(0);
  await ready();
  expect(
    await db("gp_order_publication").where({ kind: "return_requested" })
  ).toHaveLength(0);
});

it("allows separate fulfillment sources while retaining the original event uniqueness after migration", async () => {
  const x = await bound();
  await requestOrderPublication(db, "shipped", x.order, "ful_1");
  await requestOrderPublication(db, "shipped", x.order, "ful_2");
  await requestOrderPublication(db, "placed", x.order);
  await expect(
    db("gp_order_publication").insert({
      event_id: "different_placement",
      order_id: x.order,
      kind: "placed",
    })
  ).rejects.toThrow();
  await expect(
    db("gp_order_publication").insert({
      event_id: "missing_source",
      order_id: x.order,
      kind: "shipped",
    })
  ).rejects.toThrow();
  expect(
    await db("gp_order_publication").where({ kind: "shipped" })
  ).toHaveLength(2);
});

it("retains an event-before-binding without emitting, then publishes once after native success", async () => {
  const x = await prepared();
  await requestOrderPublication(db, "placed", x.order);
  expect(await materializeOrderPublications(db, starts, now)).toEqual({
    ready: 0,
    waiting: 1,
  });
  expect(await db("gp_order_publication_delivery")).toHaveLength(0);
  await x.bind();
  await materializeOrderPublications(db, starts, later());
  await requestOrderPublication(db, "placed", x.order);
  const rows = await db("gp_order_publication");
  expect(rows).toHaveLength(1);
  expect(rows[0].properties.value).toBe(91.25);
  expect(rows[0].properties.placed_at).toBe(promiseNow.toISOString());
  expect(await db("gp_order_publication_delivery")).toHaveLength(4);
});
it("failed or legacy native completion never becomes a purchase from current totals", async () => {
  const x = await prepared();
  await requestOrderPublication(db, "placed", x.order);
  await materializeOrderPublications(db, starts, now);
  await materializeOrderPublications(db, starts, later());
  expect((await db("gp_order_publication").first()).state).toBe("waiting");
  expect(await db("gp_order_publication_delivery")).toHaveLength(0);
});
it("reconciles missed events and concurrent workers with one original and fixed zero", async () => {
  const x = await bound("zero", 0);
  await Promise.all([
    reconcileOrderPublications(db, starts),
    reconcileOrderPublications(db, starts),
  ]);
  await Promise.all([
    materializeOrderPublications(db, starts, now),
    materializeOrderPublications(db, starts, now),
  ]);
  await db("order").where({ id: x.order }).update({ total: 777 });
  const send = jest.fn(accepted);
  await Promise.all([
    deliverOrderPublications(db, send, now),
    deliverOrderPublications(db, send, now),
  ]);
  expect(send).toHaveBeenCalledTimes(4);
  expect((await db("gp_order_publication").first()).properties.value).toBe(0);
  expect(
    await db("gp_order_publication_delivery").where({ status: "accepted" })
  ).toHaveLength(4);
  await expect(
    db("gp_order_publication").update({ properties: { value: 999 } })
  ).rejects.toThrow("immutable");
});
it("failed destination retries do not resend already accepted destinations", async () => {
  await bound();
  await ready();
  const calls: string[] = [];
  await deliverOrderPublications(
    db,
    async (c) => {
      calls.push(c.target);
      if (c.target === "jitsu") throw new Error("lost response");
      return accepted();
    },
    now
  );
  expect(
    await db("gp_order_publication_delivery").where({ status: "retry" })
  ).toHaveLength(1);
  await deliverOrderPublications(
    db,
    async (c) => {
      calls.push(c.target);
      return accepted();
    },
    later()
  );
  expect(calls.filter((t) => t === "jitsu")).toHaveLength(2);
  expect(calls.filter((t) => t === "gp_analytics")).toHaveLength(1);
});
it("recovers an expired network lease while rejecting the old owner's receipt", async () => {
  await bound();
  await ready();
  const first = await claimPublicationDelivery(db, now);
  await db("gp_order_publication_delivery")
    .whereNot({ target: first.target })
    .update({ next_attempt_at: later(9999) });
  const second = await claimPublicationDelivery(db, later(100));
  expect(second.lease_token).not.toBe(first.lease_token);
  expect(
    await settlePublicationDelivery(db, first, { status: "accepted" }, later())
  ).toBe(0);
  expect(
    await settlePublicationDelivery(db, second, { status: "accepted" }, later())
  ).toBe(1);
});
it("keeps a later final charge distinct from placement, including actual zero and timestamp", async () => {
  const x = await bound();
  const f = await final(x.order, 0);
  await ready();
  const rows = await db("gp_order_publication").orderBy("kind");
  expect(rows).toHaveLength(2);
  const charge = rows.find((r: any) => r.kind === "finalized"),
    placement = rows.find((r: any) => r.kind === "placed");
  expect(placement.properties.value).toBe(91.25);
  expect(charge.properties).toMatchObject({
    value: 0,
    delta: -91.25,
    occurred_at: f.at.toISOString(),
    amount_basis: "successful_final_charge_v1",
  });
  expect(charge.event_id).not.toBe(placement.event_id);
  await db("gp_order_finalization").update({ final_order_total: 999 });
  await ready();
  expect(
    (await db("gp_order_publication").where({ kind: "finalized" }).first())
      .properties.value
  ).toBe(0);
});
it.each(["failed", "mismatched_amount", "mismatched_intent"])(
  "holds unverified final charge %s without minting a second purchase",
  async (failure) => {
    const x = await bound();
    const f = await final(x.order);
    if (failure === "failed")
      await db("gp_final_charge_attempt").update({ status: "failed" });
    if (failure === "mismatched_amount")
      await db("gp_final_charge_attempt").update({ amount: 1 });
    if (failure === "mismatched_intent")
      await db("gp_order_finalization").update({
        stripe_payment_intent_id: "pi_other",
      });
    await requestOrderPublication(db, "finalized", x.order, f.id);
    await ready();
    expect(
      (await db("gp_order_publication").where({ kind: "finalized" }).first())
        .state
    ).toBe("waiting");
    expect(
      await db("gp_order_publication").where({ kind: "placed", state: "ready" })
    ).toHaveLength(1);
  }
);
it("requires a pinned activation date and excludes replayed pre-cutover orders", async () => {
  await expect(publicationEpoch(db, undefined)).rejects.toThrow(
    "epoch_required"
  );
  expect(await publicationEpoch(db, starts.toISOString())).toEqual(starts);
  await expect(publicationEpoch(db, later().toISOString())).rejects.toThrow(
    "epoch_changed"
  );
  const x = await bound();
  await requestOrderPublication(db, "placed", x.order);
  await materializeOrderPublications(
    db,
    new Date(promiseNow.getTime() + 1),
    now
  );
  expect((await db("gp_order_publication").first()).state).toBe("excluded");
  expect(await db("gp_order_publication_delivery")).toHaveLength(0);
});
it.each([
  [{ test_order: true }, "excluded"],
  [{ analytics_consent: false }, "excluded"],
  [{ test_order: null }, "held"],
  [{ analytics_consent: null }, "held"],
  [{ experiment_context_status: "unverified" }, "held"],
])(
  "keeps analytics consent/test/context policy across retries %j",
  async (attribution, status) => {
    await bound("policy", 91.25, attribution);
    await ready();
    const send = jest.fn(accepted);
    await deliverOrderPublications(db, send, now);
    const j = await db("gp_order_publication_delivery")
      .where({ target: "jitsu" })
      .first();
    expect(j.status).toBe(status);
    expect(send.mock.calls.some(([c]: any[]) => c.target === "jitsu")).toBe(
      false
    );
  }
);
it("records lifecycle communications once with compatible triggers and unchanged gross purchase counters", async () => {
  const x = await bound();
  await refundFixture(x.order, "ref_1");
  await refundFixture(x.order, "ref_2");
  await db("fulfillment").insert({
    id: "ful_1",
    created_at: actionTime(),
    shipped_at: actionTime(),
    delivered_at: actionTime(),
  });
  await db("order_fulfillment").insert({
    id: "link_ful",
    order_id: x.order,
    fulfillment_id: "ful_1",
  });
  await db("order")
    .where({ id: x.order })
    .update({ status: "canceled", canceled_at: actionTime() });
  await ready();
  const send = (claim: any) =>
    claim.target === "communications"
      ? deliverPublicationToCommunications(db, claim)
      : accepted();
  await deliverOrderPublications(db, send, now, 100);
  await deliverOrderPublications(db, send, later(), 100);
  const events = await db("gp_communication_event");
  expect(events).toHaveLength(7);
  expect(
    events.filter((e: any) => e.event_name === "order_refunded")
  ).toHaveLength(2);
  expect(events.map((e: any) => e.event_name)).toEqual(
    expect.arrayContaining([
      "shipment_created",
      "delivery_created",
      "order_canceled",
    ])
  );
  const profile = await db("gp_customer_profile").first();
  expect(Number(profile.total_orders)).toBe(1);
  expect(Number(profile.total_revenue)).toBe(91.25);
  expect(await db("gp_order_publication_profile")).toHaveLength(1);
});

it("records communications, original profile totals and recovery atomically on crash/replay", async () => {
  const x = await bound();
  await ready();
  const eventId = publicationIdentity("placed", x.order);
  await db("gp_order_publication_delivery")
    .whereNot({ target: "communications" })
    .update({ next_attempt_at: later(9999) });
  const claim = await claimPublicationDelivery(db, now);
  await deliverPublicationToCommunications(db, claim); // Simulated crash before acknowledging delivery.
  const reclaimed = await claimPublicationDelivery(db, later(100));
  await deliverPublicationToCommunications(db, reclaimed);
  await settlePublicationDelivery(db, reclaimed, { status: "accepted" });
  expect(
    await db("gp_communication_event").where({ event_id: eventId })
  ).toHaveLength(1);
  expect(await db("gp_order_publication_profile")).toHaveLength(1);
  const profile = await db("gp_customer_profile").first();
  expect(Number(profile.total_orders)).toBe(1);
  expect(Number(profile.total_revenue)).toBe(91.25);
  expect(profile.email_consent).toBe(false);
  expect(profile.email).toBeNull();
  expect(new Date(profile.first_order_at)).toEqual(promiseNow);
  expect(
    await settlePublicationDelivery(db, claim, { status: "accepted" })
  ).toBe(0);
});
it("does not lose parallel orders in one profile's counters or count finalization/refund as another purchase", async () => {
  const first = await bound("a", 0),
    second = await bound("b", 120);
  await final(second.order, 125);
  await ready();
  await Promise.all([
    deliverOrderPublications(
      db,
      (c) =>
        c.target === "communications"
          ? deliverPublicationToCommunications(db, c)
          : accepted(),
      now
    ),
    deliverOrderPublications(
      db,
      (c) =>
        c.target === "communications"
          ? deliverPublicationToCommunications(db, c)
          : accepted(),
      now
    ),
  ]);
  const profile = await db("gp_customer_profile").first();
  expect(Number(profile.total_orders)).toBe(2);
  expect(Number(profile.total_revenue)).toBe(120);
  expect(
    await db("gp_communication_event").where({ event_name: "order_completed" })
  ).toHaveLength(2);
  expect(
    await db("gp_communication_event").where({ event_name: "order_finalized" })
  ).toHaveLength(1);
  await db("gp_communication_event").insert({
    id: "refund_fixture",
    event_id: "refund_fixture",
    event_name: "order_refunded",
    occurred_at: now,
    received_at: now,
    order_id: first.order,
    properties: { total: 1 },
  });
  expect(
    (await db("gp_order_publication").where({ order_id: first.order }).first())
      .properties.value
  ).toBe(0);
});
it("rolls back both the communications event and counters on a consumer failure", async () => {
  await bound();
  await ready();
  await db("gp_order_publication_delivery")
    .whereNot({ target: "communications" })
    .update({ next_attempt_at: later(9999) });
  const claim = await claimPublicationDelivery(db, now);
  await db.raw(
    "alter table gp_order_publication_profile add constraint synthetic_failure check (placement_total < 1)"
  );
  await expect(deliverPublicationToCommunications(db, claim)).rejects.toThrow();
  expect(await db("gp_communication_event")).toHaveLength(0);
  expect(await db("gp_order_publication_profile")).toHaveLength(0);
  await db.raw(
    "alter table gp_order_publication_profile drop constraint synthetic_failure"
  );
  await deliverPublicationToCommunications(db, claim);
  expect(Number((await db("gp_customer_profile").first()).total_orders)).toBe(
    1
  );
});
it("retries automation with one attribution, excludes future touches and retains one enrollment per trigger", async () => {
  const x = await bound();
  await ready();
  await deliverOrderPublications(
    db,
    (c) =>
      c.target === "communications"
        ? deliverPublicationToCommunications(db, c)
        : accepted(),
    now
  );
  const profile = await db("gp_customer_profile").first();
  await db("gp_campaign").insert({
    id: "campaign_fixture",
    name: "Fixture",
    metrics: {},
  });
  for (const [id, sent] of [
    ["before", new Date(promiseNow.getTime() - 60_000)],
    ["after", new Date(promiseNow.getTime() + 60_000)],
  ] as const) {
    await db("gp_message_log").insert({
      id,
      profile_id: profile.id,
      email: "fixture@example.invalid",
      email_lower: "fixture@example.invalid",
      cart_id: x.cart,
      campaign_id: "campaign_fixture",
      message_purpose: "broadcast",
      status: "sent",
      sent_at: sent,
    });
  }
  const eventId = publicationIdentity("placed", x.order);
  const reset = async () =>
    db("gp_order_publication_delivery")
      .where({ event_id: eventId, target: "communications_automation" })
      .update({ status: "pending", next_attempt_at: now });
  await reset();
  let claim = await claimPublicationDelivery(db, now);
  await deliverPublicationToCommunications(db, claim); // Commit consumer effects, lose receipt.
  claim = await claimPublicationDelivery(db, later(100));
  await deliverPublicationToCommunications(db, claim);
  const rows = await db("gp_attribution");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    attribution_type: "last_touch",
    message_id: "before",
  });
  const campaign = await db("gp_campaign").first();
  expect(campaign.metrics).toMatchObject({
    attributed_orders: 1,
    attributed_revenue: 91.25,
  });
  const duplicate = await db("gp_flow_enrollment")
    .select("flow_key", "trigger_event_id")
    .count("* as n")
    .groupBy("flow_key", "trigger_event_id")
    .havingRaw("count(*) > 1");
  expect(duplicate).toHaveLength(0);
  expect(await db("gp_message_log")).toHaveLength(2); // Only the two input fixtures; no sends.
});

it("isolates test delivery receipts from production and marketing across retry", async () => {
  await bound("rehearsal", 0, { test_order: true });
  await ready();
  expect(await db("gp_order_publication_delivery")).toHaveLength(6);
  const calls: any[] = [];
  await deliverOrderPublications(
    db,
    async (claim) => {
      calls.push(claim);
      if (claim.target === "jitsu_rehearsal")
        throw new Error("ambiguous transport");
      return { status: "accepted" };
    },
    now
  );
  expect(calls.map((c) => c.target).sort()).toEqual([
    "communications",
    "gp_analytics_rehearsal",
    "jitsu_rehearsal",
  ]);
  expect(calls.every((c) => c.properties.test_order === true)).toBe(true);
  const completed = await db("gp_order_publication_delivery").whereIn(
    "target",
    ["jitsu", "gp_analytics", "communications_automation"]
  );
  expect(completed.every((r: any) => r.status === "excluded")).toBe(true);
  const retry = jest.fn(async (_claim: any) => accepted());
  await deliverOrderPublications(db, retry, later());
  expect(retry).toHaveBeenCalledTimes(1);
  expect(retry.mock.calls[0][0].target).toBe("jitsu_rehearsal");
  expect((await db("gp_order_publication").first()).properties.test_order).toBe(
    true
  );
});
it("pins rehearsal destinations concurrently and refuses retargeting", async () => {
  expect(
    await Promise.all([
      pinRehearsalRoute(db, "jitsu_rehearsal", "first"),
      pinRehearsalRoute(db, "jitsu_rehearsal", "first"),
    ])
  ).toEqual([true, true]);
  expect(await pinRehearsalRoute(db, "jitsu_rehearsal", "changed")).toBe(false);
  expect(
    await pinRehearsalRoute(db, "gp_analytics_rehearsal", "independent")
  ).toBe(true);
  expect(await db("gp_order_publication_route")).toHaveLength(2);
});
it("backfills only known test receipts without reopening production delivery", async () => {
  await bound("prod", 1);
  await bound("test", 0, { test_order: true });
  await ready();
  await db("gp_order_publication_delivery")
    .whereIn("target", ["jitsu_rehearsal", "gp_analytics_rehearsal"])
    .delete();
  await db("gp_order_publication_delivery").update({ status: "excluded" });
  const sql: string[] = [];
  await Migration20260920223000.prototype.up.call({
    addSql: (s: string) => sql.push(s),
  } as any);
  // Apply the migration's actual backfill after existing receipt dispositions.
  await db.raw(
    sql[0].slice(sql[0].indexOf("insert into gp_order_publication_delivery"))
  );
  const rows = await db("gp_order_publication_delivery").where({
    status: "pending",
  });
  expect(rows).toHaveLength(2);
  expect(rows.every((r: any) => r.event_id.includes("order_test:"))).toBe(true);
  expect(
    await db("gp_order_publication_delivery").where({ status: "excluded" })
  ).toHaveLength(8);
});
