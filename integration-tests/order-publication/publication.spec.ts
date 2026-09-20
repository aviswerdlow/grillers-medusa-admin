import { randomUUID } from "node:crypto";
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
    'create table "order" (id text primary key, customer_id text, metadata jsonb, total numeric, created_at timestamptz, deleted_at timestamptz)'
  );
  await db.raw(
    "create table order_cart (order_id text primary key, cart_id text unique, deleted_at timestamptz)"
  );
  for (const migration of [
    Migration20260920174500,
    Migration20260531183000,
    Migration20260526120000,
    Migration20260526123000,
    Migration20260526133000,
    Migration20260920214500,
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
