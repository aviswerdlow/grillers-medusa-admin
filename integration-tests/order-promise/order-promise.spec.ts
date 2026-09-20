import { randomUUID } from "node:crypto";
import { Migration20260920174500 } from "../../src/modules/gp-catch-weight/migrations/Migration20260920174500";
import {
  acceptOrderPromiseReview,
  bindOrderPromise,
  createOrderPromiseReview,
  ORDER_PROMISE_KEY,
  orderPromiseAnalytics,
  readOriginalOrderPromise,
  validateOrderPromiseSnapshot,
} from "../../src/lib/order-promise";
import {
  promiseFixture,
  completedPromiseCart,
  promiseNow,
} from "../../src/lib/__tests__/fixtures/order-promise";

const knex = require("knex"),
  schema = `gp_promise_${randomUUID().replace(/-/g, "")}`;
let db: any, admin: any;
const expiresAt = new Date(promiseNow.getTime() + 15 * 60_000);
beforeAll(async () => {
  const explicit = process.env.ORDER_PROMISE_TEST_DATABASE_URL;
  const socket = process.env.ORDER_PROMISE_TEST_PG_SOCKET;
  if (explicit) {
    const url = new URL(explicit);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^\/gp_(launch|order_promises)$/.test(url.pathname)
    )
      throw new Error(
        "Only an isolated local order-promise test database is permitted"
      );
  }
  const connection =
    explicit ||
    (socket
      ? {
          host: socket,
          port: 55468,
          user: "gp_order_promise_test",
          database: "gp_order_promises",
        }
      : null);
  if (!connection)
    throw new Error(
      "Explicit isolated ORDER_PROMISE_TEST database required; DATABASE_URL is never used"
    );
  admin = knex({ client: "pg", connection });
  await admin.raw(`create schema ${schema}`);
  db = knex({
    client: "pg",
    connection,
    searchPath: [schema],
    pool: { min: 0, max: 8 },
  });
  // Real PostgreSQL transactions and the actual ledger migration. These narrow
  // native-boundary tables do NOT claim to run Medusa's checkout workflow.
  await db.raw(
    "create table cart (id text primary key, customer_id text, email text, metadata jsonb, completed_at timestamptz, deleted_at timestamptz, updated_at timestamptz)"
  );
  await db.raw(
    'create table "order" (id text primary key, customer_id text, metadata jsonb, total numeric, created_at timestamptz, deleted_at timestamptz)'
  );
  await db.raw(
    "create table order_cart (order_id text primary key, cart_id text unique, deleted_at timestamptz)"
  );
  const sql: string[] = [];
  await Migration20260920174500.prototype.up.call({
    addSql: (statement: string) => sql.push(statement),
  } as any);
  for (const statement of sql) await db.raw(statement);
});
afterAll(async () => {
  if (db) await db.destroy();
  if (admin) {
    await admin.raw(`drop schema if exists ${schema} cascade`);
    await admin.destroy();
  }
});
beforeEach(async () => {
  await db.raw(
    'truncate gp_order_promise_binding, gp_order_promise_snapshot, gp_order_promise_review, order_cart, "order", cart'
  );
  await db("cart").insert({
    id: "cart_promise",
    customer_id: "cus_promise",
    email: "checkout@example.invalid",
    metadata: { unrelated: "preserved" },
  });
});
async function review(promise = promiseFixture(), requestId = randomUUID()) {
  return createOrderPromiseReview(db, {
    promise,
    requestId,
    expiresAt,
    now: promiseNow,
  });
}
async function accepted(promise = promiseFixture()) {
  const selected = await review(promise),
    requestId = randomUUID();
  const snapshot = await acceptOrderPromiseReview(db, {
    currentPromise: promise,
    reviewId: selected.id,
    requestId,
    now: promiseNow,
  });
  return { review: selected, snapshot, requestId, promise };
}
async function nativeOrder(snapshotId: string) {
  await db("cart")
    .where({ id: "cart_promise" })
    .update({ completed_at: promiseNow });
  await db("order").insert({
    id: "order_promise",
    customer_id: "cus_promise",
    metadata: { [ORDER_PROMISE_KEY]: snapshotId },
    total: 91.25,
    created_at: promiseNow,
  });
  await db("order_cart").insert({
    order_id: "order_promise",
    cart_id: "cart_promise",
  });
}

it("replays a review without extending its expiry and rejects changed reuse", async () => {
  const requestId = randomUUID(),
    first = await review(promiseFixture(), requestId);
  const second = await createOrderPromiseReview(db, {
    promise: promiseFixture(),
    requestId,
    now: new Date(promiseNow.getTime() + 60_000),
    expiresAt: new Date(expiresAt.getTime() + 60_000),
  });
  expect(second.id).toBe(first.id);
  expect(new Date(second.expires_at)).toEqual(expiresAt);
  await expect(
    review({ ...promiseFixture(), placement_total: 100 }, requestId)
  ).rejects.toMatchObject({ code: "order_review_idempotency_conflict" });
});
it("serializes duplicate accepts, preserves cart metadata and creates one revision", async () => {
  const selected = await review(),
    requestId = randomUUID();
  const input = {
    currentPromise: promiseFixture(),
    reviewId: selected.id,
    requestId,
    now: promiseNow,
  };
  const results = await Promise.all([
    acceptOrderPromiseReview(db, input),
    acceptOrderPromiseReview(db, input),
  ]);
  expect(results[0].id).toBe(results[1].id);
  expect(await db("gp_order_promise_snapshot").count("* as n").first()).toEqual(
    { n: "1" }
  );
  expect((await db("cart").first()).metadata).toEqual({
    unrelated: "preserved",
    [ORDER_PROMISE_KEY]: results[0].id,
  });
});
it("allows one accept when different requests race on one reviewed promise", async () => {
  const selected = await review();
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      acceptOrderPromiseReview(db, {
        currentPromise: promiseFixture(),
        reviewId: selected.id,
        requestId: randomUUID(),
        now: promiseNow,
      })
    )
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.code
  ).toBe("order_review_already_accepted");
});
it.each(["amount", "address", "date", "receipt", "terms"])(
  "rejects a changed %s before acceptance",
  async (field) => {
    const selected = await review(),
      promise = promiseFixture();
    if (field === "amount") promise.placement_total = 120;
    if (field === "address")
      promise.shipping_address.address_1 = "2 Fixture Road";
    if (field === "date") promise.fulfillment.arrival_date = "2026-09-25";
    if (field === "receipt")
      promise.contact.receipt_email = "changed@example.invalid";
    if (field === "terms")
      promise.terms.sale_terms_revision = "synthetic-terms-2";
    await expect(
      acceptOrderPromiseReview(db, {
        currentPromise: promise,
        reviewId: selected.id,
        requestId: randomUUID(),
        now: promiseNow,
      })
    ).rejects.toMatchObject({ code: "order_review_changed_refresh_required" });
    expect(await db("gp_order_promise_snapshot")).toHaveLength(0);
    expect(
      (await db("cart").first()).metadata[ORDER_PROMISE_KEY]
    ).toBeUndefined();
  }
);
it("rejects expired or foreign reviews and completed carts", async () => {
  const selected = await review();
  await expect(
    acceptOrderPromiseReview(db, {
      currentPromise: promiseFixture(),
      reviewId: selected.id,
      requestId: randomUUID(),
      now: new Date(promiseNow.getTime() - 1),
    })
  ).rejects.toMatchObject({ code: "order_review_changed_refresh_required" });
  await expect(
    acceptOrderPromiseReview(db, {
      currentPromise: promiseFixture(),
      reviewId: selected.id,
      requestId: randomUUID(),
      now: expiresAt,
    })
  ).rejects.toMatchObject({ code: "order_review_changed_refresh_required" });
  await expect(
    review(promiseFixture("cart_promise", "cus_other"))
  ).rejects.toMatchObject({ status: 403 });
  await db("cart")
    .where({ id: "cart_promise" })
    .update({ completed_at: promiseNow });
  await expect(review()).rejects.toMatchObject({
    code: "order_already_placed",
  });
});
it("rolls back a snapshot if its cart pointer cannot be saved", async () => {
  const selected = await review();
  await db.raw(
    "create function reject_promise_pointer() returns trigger as $$ begin raise exception 'synthetic pointer failure'; end; $$ language plpgsql; create trigger reject_promise_pointer before update on cart for each row execute function reject_promise_pointer()"
  );
  try {
    await expect(
      acceptOrderPromiseReview(db, {
        currentPromise: promiseFixture(),
        reviewId: selected.id,
        requestId: randomUUID(),
        now: promiseNow,
      })
    ).rejects.toThrow("synthetic pointer failure");
    expect(await db("gp_order_promise_snapshot")).toHaveLength(0);
    expect(
      (await db("cart").first()).metadata[ORDER_PROMISE_KEY]
    ).toBeUndefined();
  } finally {
    await db.raw(
      "drop trigger reject_promise_pointer on cart; drop function reject_promise_pointer()"
    );
  }
});
it("does not revive an older acceptance after a newer review is accepted", async () => {
  const first = await accepted(),
    promise = { ...promiseFixture(), placement_total: 100 };
  const second = await accepted(promise);
  expect(second.snapshot.revision).toBe(2);
  await expect(
    acceptOrderPromiseReview(db, {
      currentPromise: first.promise,
      reviewId: first.review.id,
      requestId: first.requestId,
      now: promiseNow,
    })
  ).rejects.toMatchObject({ code: "order_acceptance_superseded" });
  await expect(
    validateOrderPromiseSnapshot(db, {
      snapshotId: first.snapshot.id,
      promise: first.promise,
      reviewId: first.review.id,
      now: promiseNow,
    })
  ).rejects.toMatchObject({ code: "order_acceptance_changed" });
  expect(
    (
      await validateOrderPromiseSnapshot(db, {
        snapshotId: second.snapshot.id,
        promise,
        reviewId: second.review.id,
        now: promiseNow,
      })
    ).id
  ).toBe(second.snapshot.id);
});
it("revalidates expiry and the current cart owner at the native boundary", async () => {
  const value = await accepted();
  const input = {
    snapshotId: value.snapshot.id,
    promise: value.promise,
    reviewId: value.review.id,
    now: expiresAt,
  };
  await expect(validateOrderPromiseSnapshot(db, input)).rejects.toMatchObject({
    code: "order_acceptance_changed",
  });
  await db("cart")
    .where({ id: "cart_promise" })
    .update({ customer_id: "cus_other" });
  await expect(
    validateOrderPromiseSnapshot(db, { ...input, now: promiseNow })
  ).rejects.toMatchObject({ code: "order_acceptance_changed" });
});
it("requires successful native completion even when an event, order and cart link exist", async () => {
  const value = await accepted();
  await nativeOrder(value.snapshot.id);
  const failed = completedPromiseCart();
  failed.transaction.getState = () => "reverted";
  await expect(
    bindOrderPromise(db, "cart_promise", failed)
  ).rejects.toMatchObject({ code: "order_promise_completion_unconfirmed" });
  await expect(
    bindOrderPromise(db, "cart_promise", { id: "order_promise" })
  ).rejects.toMatchObject({ code: "order_promise_completion_unconfirmed" });
  expect(await db("gp_order_promise_binding")).toHaveLength(0);
  await expect(
    readOriginalOrderPromise(db, "order_promise")
  ).rejects.toMatchObject({ code: "order_promise_original_unavailable" });
});
it.each([
  "owner",
  "order pointer",
  "cart pointer",
  "link",
  "deleted order",
  "deleted link",
  "incomplete cart",
])("rejects invalid native %s evidence", async (field) => {
  const value = await accepted();
  await nativeOrder(value.snapshot.id);
  if (field === "owner") await db("order").update({ customer_id: "cus_other" });
  if (field === "order pointer")
    await db("order").update({
      metadata: { [ORDER_PROMISE_KEY]: "gpos_fake" },
    });
  if (field === "cart pointer") await db("cart").update({ metadata: {} });
  if (field === "link")
    await db("order_cart").update({ cart_id: "cart_other" });
  if (field === "deleted order")
    await db("order").update({ deleted_at: promiseNow });
  if (field === "deleted link")
    await db("order_cart").update({ deleted_at: promiseNow });
  if (field === "incomplete cart")
    await db("cart").update({ completed_at: null });
  await expect(
    bindOrderPromise(db, "cart_promise", completedPromiseCart())
  ).rejects.toMatchObject({ status: 503 });
  expect(await db("gp_order_promise_binding")).toHaveLength(0);
});
it("binds once and keeps the original promise after final amounts or current contact details change", async () => {
  const value = await accepted();
  await nativeOrder(value.snapshot.id);
  await bindOrderPromise(db, "cart_promise", completedPromiseCart());
  const retry = completedPromiseCart();
  retry.transaction.runId = "run_retry";
  expect(
    (await bindOrderPromise(db, "cart_promise", retry)).workflow_run_id
  ).toBe("run_fixture");
  await db("order").update({
    total: 115,
    metadata: { final_charge_amount: 115 },
  });
  await db("cart").update({ email: "new@example.invalid", metadata: {} });
  const original = await readOriginalOrderPromise(db, "order_promise");
  expect(original.promise).toEqual(value.promise);
  expect(orderPromiseAnalytics(original)).toMatchObject({
    placement_total: 91.25,
    amount_unit: "major",
    placed_at: promiseNow.toISOString(),
  });
  expect(await db("gp_order_promise_binding")).toHaveLength(1);
});
it("enforces append-only evidence at the database boundary", async () => {
  const value = await accepted();
  await nativeOrder(value.snapshot.id);
  await bindOrderPromise(db, "cart_promise", completedPromiseCart());
  for (const table of [
    "gp_order_promise_review",
    "gp_order_promise_snapshot",
    "gp_order_promise_binding",
  ]) {
    await expect(db(table).delete()).rejects.toThrow(
      "Accepted-order evidence is immutable"
    );
    await expect(
      db(table).update(
        table === "gp_order_promise_binding"
          ? { workflow_run_id: "changed" }
          : { content_hash: "a".repeat(64) }
      )
    ).rejects.toThrow("Accepted-order evidence is immutable");
  }
});
it("will not export an original for a missing or deleted native order", async () => {
  await expect(
    readOriginalOrderPromise(db, "order_missing")
  ).rejects.toMatchObject({ code: "order_promise_original_unavailable" });
  const value = await accepted();
  await nativeOrder(value.snapshot.id);
  await bindOrderPromise(db, "cart_promise", completedPromiseCart());
  await db("order").update({ deleted_at: promiseNow });
  await expect(
    readOriginalOrderPromise(db, "order_promise")
  ).rejects.toMatchObject({ code: "order_promise_original_unavailable" });
});
