import { Migration20260920214500 as Original } from "../../src/modules/gp-communications/migrations/Migration20260920214500";
import { Migration20260920223000 as Rehearsal } from "../../src/modules/gp-communications/migrations/Migration20260920223000";
import { Migration20260920235000 as Lifecycle } from "../../src/modules/gp-communications/migrations/Migration20260920235000";
import { Migration20260921001500 as Refunds } from "../../src/modules/gp-communications/migrations/Migration20260921001500";
import { Migration20260921033000 as Operations } from "../../src/modules/gp-communications/migrations/Migration20260921033000";
import { REFUND_PROVIDER_SQL } from "../../src/lib/refund-provider-schema";
import { applyMigration, withMigrationFixture } from "../migration-fixture";

const migrations = [Original, Rehearsal, Lifecycle, Refunds, Operations];
const kinds = [
  "placed",
  "finalized",
  "canceled",
  "fulfillment_created",
  "shipped",
  "delivered",
  "return_requested",
  "refunded",
  "refund_updated",
  "shipping_forecast",
  "inventory_created",
  "inventory_released",
];
const fixture = (run: (db: any) => Promise<void>) =>
  withMigrationFixture(process.env.ORDER_PUBLICATION_TEST_DATABASE_URL, run);
const scope = {
  id: 1,
  account_id: "acct_fixture",
  livemode: false,
  starts_at: "2026-09-24T00:00:00Z",
  scan_after: "saved-cursor",
  lease_token: "saved-lease",
  lease_until: "2026-09-24T12:01:00Z",
};

async function install(db: any) {
  for (const migration of migrations) await applyMigration(db, migration);
}
async function definitions(db: any) {
  return (
    await db.raw(`select conname, pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid in ('gp_order_publication'::regclass, 'gp_order_publication_delivery'::regclass) order by conname`)
  ).rows;
}

test("publication migrations replay without narrowing newer kinds or resetting delivery/refund evidence", async () => {
  await fixture(async (db) => {
    await install(db);
    for (const kind of kinds) {
      await db("gp_order_publication").insert({
        event_id: kind,
        order_id: "order",
        kind,
        source_id: `source-${kind}`,
        state: "ready",
        properties: { test_order: kind === "placed" },
      });
    }
    for (const target of [
      "jitsu",
      "jitsu_rehearsal",
      "gp_analytics_rehearsal",
    ]) {
      await db("gp_order_publication_delivery").insert({
        event_id: "placed",
        target,
        status: "accepted",
        attempts: 3,
        accepted_at: "2026-09-24T12:00:00Z",
      });
    }
    await db("gp_order_publication_route").insert({
      target: "jitsu_rehearsal",
      route_hash: "pinned-route",
    });
    await db("gp_refund_provider_scope").insert(scope);
    await db("gp_refund_provider_event").insert({
      event_id: "event",
      refund_id: "refund",
      event_type: "refund.updated",
      payload_hash: "a".repeat(64),
      event_created_at: "2026-09-24T12:00:00Z",
    });
    await db("gp_refund_provider_queue").insert({
      refund_id: "refund",
      generation: 3,
      attempts: 4,
      reason: "preserved retry",
    });
    await db("gp_refund_provider_receipt").insert({
      id: "receipt",
      refund_id: "refund",
      revision: 2,
      account_id: "acct_fixture",
      livemode: false,
      payment_intent_id: "pi_fixture",
      amount_minor: 125,
      currency_code: "usd",
      status: "succeeded",
      provider_created_at: "2026-09-24T12:00:00Z",
      observed_at: "2026-09-24T12:00:01Z",
    });
    await db("gp_refund_provider_binding").insert({
      refund_id: "refund",
      order_id: "order",
      origin: "provider_only",
    });
    await db("gp_refund_provider_metric").insert({
      refund_id: "refund",
      event_id: "metric",
      order_id: "order",
    });
    const tables = [
      "gp_order_publication",
      "gp_order_publication_delivery",
      "gp_order_publication_route",
      ...["scope", "event", "queue", "receipt", "binding", "metric"].map(
        (name) => `gp_refund_provider_${name}`
      ),
    ];
    const rows = () =>
      Promise.all(tables.map((table) => db(table).select().orderByRaw("1")));
    const before = await rows(),
      checks = await definitions(db);
    await install(db);
    expect(await rows()).toEqual(before);
    expect(await definitions(db)).toEqual(checks);
    // Repetition must not grow the check expression or weaken original guards.
    await install(db);
    expect(await rows()).toEqual(before);
    expect(await definitions(db)).toEqual(checks);
    for (const table of [
      "gp_order_publication",
      "gp_refund_provider_event",
      "gp_refund_provider_receipt",
      "gp_refund_provider_binding",
      "gp_refund_provider_metric",
      "gp_refund_provider_scope",
    ]) {
      await expect(db(table).delete()).rejects.toThrow(/immutable|retained/);
    }
    await expect(
      db("gp_refund_provider_scope").update({ account_id: "changed" })
    ).rejects.toThrow(/immutable/);
    await expect(
      db("gp_order_publication").insert({
        event_id: "duplicate",
        order_id: "order",
        kind: "placed",
      })
    ).rejects.toThrow(/unique constraint/);
    await expect(
      db("gp_order_publication").insert({
        event_id: "invalid",
        order_id: "order",
        kind: "unrecognized",
        source_id: "source",
      })
    ).rejects.toThrow(/check constraint/);
    await expect(
      db("gp_order_publication").insert({
        event_id: "missing-source",
        order_id: "other-order",
        kind: "canceled",
      })
    ).rejects.toThrow(/check constraint/);
    await expect(
      db("gp_order_publication_delivery").insert({
        event_id: "placed",
        target: "unrecognized",
      })
    ).rejects.toThrow(/check constraint/);
    await db("gp_order_publication").insert({
      event_id: "second-cancellation",
      order_id: "order",
      kind: "canceled",
      source_id: "different-source",
    });
  });
});

test("refund migration resumes from a pinned scope and restores missing immutable triggers", async () => {
  await fixture(async (db) => {
    for (const migration of [Original, Rehearsal, Lifecycle])
      await applyMigration(db, migration);
    const firstTable = REFUND_PROVIDER_SQL.slice(
      0,
      REFUND_PROVIDER_SQL.indexOf(
        "create table if not exists gp_refund_provider_event"
      )
    );
    await db.raw(firstTable);
    await db("gp_refund_provider_scope").insert(scope);
    const before = await db("gp_refund_provider_scope").first();
    await applyMigration(db, Refunds);
    await db.raw(
      "drop trigger gp_refund_scope_immutable on gp_refund_provider_scope"
    );
    await applyMigration(db, Refunds);
    expect(await db("gp_refund_provider_scope").first()).toEqual(before);
    await expect(db("gp_refund_provider_scope").delete()).rejects.toThrow(
      /immutable/
    );
    await expect(
      db("gp_refund_provider_scope").update({
        starts_at: "2027-01-01T00:00:00Z",
      })
    ).rejects.toThrow(/immutable/);
  });
});

test.each([
  ["gp_order_publication", "gp_order_publication_kind_check", Operations],
  [
    "gp_order_publication",
    "gp_order_publication_lifecycle_source_check",
    Lifecycle,
  ],
  [
    "gp_order_publication_delivery",
    "gp_order_publication_delivery_target_check",
    Rehearsal,
  ],
] as const)(
  "recovery restores missing %s.%s and then permits older migrations to replay",
  async (table, constraint, migration) => {
    await fixture(async (db) => {
      await install(db);
      await db("gp_order_publication").insert({
        event_id: "inventory",
        order_id: "order",
        kind: "inventory_created",
        source_id: "allocation",
      });
      await db.raw(`alter table ${table} drop constraint ${constraint}`);
      await applyMigration(db, migration);
      await install(db);
      expect(await db("gp_order_publication").first()).toMatchObject({
        kind: "inventory_created",
        source_id: "allocation",
      });
      const found = (await definitions(db)).find(
        (row: any) => row.conname === constraint
      );
      expect(found).toBeDefined();
      await expect(
        db("gp_order_publication").insert({
          event_id: "invalid",
          order_id: "order",
          kind: "unrecognized",
          source_id: "source",
        })
      ).rejects.toThrow(/check constraint/);
    });
  }
);
