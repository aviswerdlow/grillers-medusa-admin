import { Migration20260920174500 as PromiseMigration } from "../../src/modules/gp-catch-weight/migrations/Migration20260920174500";
import { applyMigration, withMigrationFixture } from "../migration-fixture";

const fixture = (run: (db: any) => Promise<void>) =>
  withMigrationFixture(process.env.ORDER_PROMISE_TEST_DATABASE_URL, run);
const tables = ["review", "snapshot", "binding"].map(
  (name) => `gp_order_promise_${name}`
);

async function seed(db: any) {
  const identity = {
    cart_id: "cart",
    customer_id: "customer",
    content_hash: "a".repeat(64),
    promise: { original: "retained" },
  };
  await db(tables[0]).insert({
    ...identity,
    id: "review",
    request_id: "review-request",
    created_at: "2026-09-24T12:00:00Z",
    expires_at: "2026-09-24T12:15:00Z",
  });
  await db(tables[1]).insert({
    ...identity,
    id: "snapshot",
    review_id: "review",
    revision: 1,
    request_id: "accept-request",
    accepted_at: "2026-09-24T12:01:00Z",
  });
  await db(tables[2]).insert({
    order_id: "order",
    cart_id: "cart",
    snapshot_id: "snapshot",
    workflow_id: "complete-cart",
    workflow_transaction_id: "cart",
    workflow_run_id: "run",
    placed_at: "2026-09-24T12:02:00Z",
  });
}

test("order-promise migration replay retains original acceptance and all immutable guards", async () => {
  await fixture(async (db) => {
    await applyMigration(db, PromiseMigration);
    await seed(db);
    const before = await Promise.all(tables.map((table) => db(table).select()));
    await applyMigration(db, PromiseMigration);
    expect(
      await Promise.all(tables.map((table) => db(table).select()))
    ).toEqual(before);
    for (const table of tables) {
      await expect(db(table).delete()).rejects.toThrow(/evidence is immutable/);
      await expect(db(table).update({ cart_id: "changed" })).rejects.toThrow(
        /evidence is immutable/
      );
    }
  });
});

test("order-promise recovery installs a missing trigger without dropping existing protection", async () => {
  await fixture(async (db) => {
    await applyMigration(db, PromiseMigration);
    await seed(db);
    await db.raw(
      "drop trigger gp_order_promise_binding_immutable on gp_order_promise_binding"
    );
    await applyMigration(db, PromiseMigration);
    for (const table of tables) {
      expect(await db(table).count("* as count").first()).toEqual({
        count: "1",
      });
      await expect(db(table).delete()).rejects.toThrow(/evidence is immutable/);
    }
  });
});
