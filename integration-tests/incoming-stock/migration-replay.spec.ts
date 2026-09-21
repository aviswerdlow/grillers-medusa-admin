import { Migration20260920150000 as Incoming } from "../../src/modules/gp-inventory-allocation/migrations/Migration20260920150000";
import {
  applyMigration,
  migrationStatements,
  withMigrationFixture,
} from "../migration-fixture";

const fixture = (run: (db: any) => Promise<void>) =>
  withMigrationFixture(process.env.INCOMING_TEST_DATABASE_URL, run);
const batch = {
  id: "batch",
  variant_id: "variant",
  qbd_list_id: "fixture-list-id",
  stock_unit: "pack",
  source_system: "fixture",
  source_ref: "receipt-source",
  expected_quantity: 4,
  confirmed_quantity: 4,
  usable_at: "2026-09-24T12:00:00Z",
  status: "confirmed",
  created_by: "fixture-operator",
};

test.each([1, 2, 3, 4, 5])(
  "incoming migration resumes after %i completed statements",
  async (completed) => {
    await fixture(async (db) => {
      const statements = await migrationStatements(Incoming);
      for (const sql of statements.slice(0, completed)) await db.raw(sql);
      await db("gp_incoming_batch").insert(batch);
      const before = await db("gp_incoming_batch").first();
      await applyMigration(db, Incoming);
      expect(await db("gp_incoming_batch").first()).toEqual(before);
      await expect(
        db("gp_incoming_batch").insert({ ...batch, id: "duplicate-source" })
      ).rejects.toThrow(/unique constraint/);
    });
  }
);

test("incoming migration replay retains commitments, receipts and event history", async () => {
  await fixture(async (db) => {
    await applyMigration(db, Incoming);
    await db("gp_incoming_batch").insert(batch);
    const demand = {
      id: "demand",
      variant_id: "variant",
      qbd_list_id: "fixture-list-id",
      stock_unit: "pack",
      cart_id: "cart",
      line_item_id: "line",
      quantity: 2,
      remaining_quantity: 2,
      needed_by: "2026-09-24T12:00:00Z",
      customer_date: "2026-09-25",
      calendar_revision: "fixture",
      status: "committed",
    };
    await db("gp_incoming_demand").insert(demand);
    await db("gp_incoming_commitment").insert({
      id: "commitment",
      demand_id: "demand",
      batch_id: "batch",
      batch_revision: 0,
      quantity: 2,
      remaining_quantity: 2,
    });
    await db("gp_incoming_receipt").insert({
      id: "receipt",
      batch_id: "batch",
      source_system: "fixture",
      source_ref: "actual-receipt",
      quantity: 4,
      usable_at: batch.usable_at,
      recorded_by: "fixture-operator",
    });
    await db("gp_incoming_event").insert({
      request_id: "request",
      payload_hash: "fixture-hash",
      event_type: "fixture",
      variant_id: "variant",
      actor_id: "fixture-operator",
      reason: "Synthetic migration recovery",
      payload: {},
      result: {},
    });
    const tables = ["batch", "demand", "commitment", "receipt", "event"].map(
      (name) => `gp_incoming_${name}`
    );
    const before = await Promise.all(tables.map((table) => db(table).select()));
    await applyMigration(db, Incoming);
    expect(
      await Promise.all(tables.map((table) => db(table).select()))
    ).toEqual(before);
    await expect(
      db("gp_incoming_demand").insert({ ...demand, id: "duplicate-line" })
    ).rejects.toThrow(/unique constraint/);
    await expect(
      db("gp_incoming_batch").insert({
        ...batch,
        id: "negative",
        source_ref: "negative",
        expected_quantity: -1,
      })
    ).rejects.toThrow(/check constraint/);
  });
});
