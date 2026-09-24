import { randomUUID } from "node:crypto";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { GET as incomingGet } from "../../src/api/admin/grillers/inventory/incoming/route";
import { Migration20260920150000 } from "../../src/modules/gp-inventory-allocation/migrations/Migration20260920150000";
import {
  createIncomingBatch,
  reviseIncomingBatch,
  previewIncomingStock,
  reserveIncomingStock,
  releaseIncomingStock,
  stageIncomingReceipt,
  listIncomingStock,
  listIncomingExceptions,
} from "../../src/lib/incoming-stock";
import { incomingStockStaffCommand } from "../../src/lib/incoming-stock-staff";
import { staffCapabilities } from "../../src/lib/staff-access-policy";
import type { StaffPrincipal } from "../../src/lib/staff-principal";

const knex = require("knex"),
  schema = `gp_incoming_${randomUUID().replace(/-/g, "")}`;
let db: any, admin: any;
const actor = {
  id: "cus_receiving",
  reason: "Approved synthetic receiving fixture",
};
const identity = {
  variant_id: "variant_pies",
  qbd_list_id: "8000-FIXTURE",
  stock_unit: "sellable_pack",
};
const usable_at = "2026-10-04T16:00:00.000Z",
  needed_by = "2026-10-05T10:00:00.000Z";
const cmd = () => ({ request_id: randomUUID(), actor });
const demand = (quantity = 8, overrides = {}) => {
  const key = randomUUID();
  return {
    ...cmd(),
    ...identity,
    demand_id: `d_${key}`,
    cart_id: `cart_${key}`,
    line_item_id: `line_${key}`,
    quantity,
    needed_by,
    customer_date: "2026-10-09",
    calendar_revision: "synthetic-calendar-1",
    ...overrides,
  };
};
async function batch(quantity = 10, overrides = {}) {
  const created = await createIncomingBatch(db, {
    ...cmd(),
    ...identity,
    source_system: "approved_manual_fixture",
    source_ref: randomUUID(),
    expected_quantity: quantity,
    usable_at,
    ...overrides,
  });
  return (
    await reviseIncomingBatch(db, {
      ...cmd(),
      batch_id: created.batch.id,
      expected_revision: 0,
      action: "confirm",
      confirmed_quantity: quantity,
      usable_at,
      ...overrides,
    })
  ).batch;
}
async function migrate(connection: any) {
  const sql: string[] = [];
  await Migration20260920150000.prototype.up.call({
    addSql: (statement: string) => sql.push(statement),
  } as any);
  for (const statement of sql) await connection.raw(statement);
}
beforeAll(async () => {
  const connection =
    process.env.INCOMING_TEST_DATABASE_URL ||
    (process.env.INCOMING_TEST_PG_SOCKET
      ? {
          host: process.env.INCOMING_TEST_PG_SOCKET,
          port: 55464,
          user: "gp_incoming_test",
          database: "gp_incoming",
        }
      : null);
  if (!connection)
    throw new Error(
      "Explicit isolated INCOMING_TEST database required. DATABASE_URL is never used."
    );
  admin = knex({ client: "pg", connection });
  await admin.raw(`create schema ${schema}`);
  db = knex({
    client: "pg",
    connection,
    searchPath: [schema],
    pool: { min: 0, max: 10 },
  });
  await migrate(db);
  // Staff-identity fixture only; not the native Medusa stock/checkout harness.
  await db.raw(
    "create table customer (id text primary key, metadata jsonb, deleted_at timestamptz)"
  );
});
beforeEach(async () => {
  await db.raw(
    "truncate gp_incoming_event, gp_incoming_receipt, gp_incoming_commitment, gp_incoming_demand, gp_incoming_batch, customer"
  );
  await db("customer").insert({
    id: actor.id,
    metadata: JSON.stringify({ gp_staff_role: "super_admin" }),
  });
});
afterAll(async () => {
  if (db) await db.destroy();
  if (admin) {
    await admin.raw(`drop schema if exists ${schema} cascade`);
    await admin.destroy();
  }
});

it("pages the cross-product exception queue without dropping a boundary row and omits released commitments", async () => {
  const rows = Array.from({ length: 53 }, (_, i) => ({
    id: `d_${String(i).padStart(3, "0")}`,
    variant_id: `variant_${i}`,
    qbd_list_id: `fixture_${i}`,
    stock_unit: "pack",
    cart_id: `cart_${i}`,
    line_item_id: `line_${i}`,
    quantity: 1,
    remaining_quantity: i === 0 ? 0 : 1,
    needed_by,
    customer_date: "2026-10-09",
    calendar_revision: "fixture",
    status: i === 0 ? "released" : "committed",
    exception_reason: "incoming_short",
  }));
  await db("gp_incoming_demand").insert(rows);
  const first = await listIncomingExceptions(db),
    second = await listIncomingExceptions(db, first.next_cursor);
  expect(first.demands).toHaveLength(50);
  expect(second.demands).toHaveLength(2);
  expect(second.next_cursor).toBeNull();
  expect(
    new Set([...first.demands, ...second.demands].map((row) => row.id)).size
  ).toBe(52);
});

it("returns the queue through the staff route with product names and an explicit read-only capability", async () => {
  const b = await batch();
  const d = demand();
  await reserveIncomingStock(db, d);
  await reviseIncomingBatch(db, {
    ...cmd(),
    batch_id: b.id,
    expected_revision: 1,
    action: "cancel",
  });
  const principal = {
    id: "cus_picker",
    kind: "customer",
    capabilities: new Set(["inventory.read"]),
  };
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const req = {
    query: { view: "exceptions" },
    gp_staff_principal: principal,
    scope: {
      resolve: (key: string) =>
        key === ContainerRegistrationKeys.PG_CONNECTION
          ? db
          : {
              graph: async () => ({
                data: [
                  {
                    id: identity.variant_id,
                    sku: "PIE-FIXTURE",
                    product: { title: "Fixture pies" },
                  },
                ],
              }),
            },
    },
  };
  await incomingGet(req as any, res as any);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      can_manage: false,
      demands: [
        expect.objectContaining({
          product_title: "Fixture pies",
          exception_reason: "incoming_cancelled",
        }),
      ],
    })
  );
  res.json.mockClear();
  delete (req as any).gp_staff_principal;
  await incomingGet(req as any, res as any);
  expect(res.status).toHaveBeenCalledWith(403);
});

it("does not invent supply for a distant customer date or an unconfirmed forecast", async () => {
  await createIncomingBatch(db, {
    ...cmd(),
    ...identity,
    source_system: "vendor_estimate",
    source_ref: "draft",
    expected_quantity: 100,
    usable_at,
  });
  expect(
    (
      await previewIncomingStock(db, {
        ...identity,
        needed_by: "2027-10-05T10:00:00.000Z",
      })
    ).available_quantity
  ).toBe(0);
  await expect(
    reserveIncomingStock(
      db,
      demand(8, {
        needed_by: "2027-10-05T10:00:00.000Z",
        customer_date: "2027-10-09",
      })
    )
  ).rejects.toThrow("insufficient");
  expect(await db("gp_incoming_demand").count("*").first()).toEqual({
    count: "0",
  });
});
it("serializes two orders for eight against ten and preserves exactly two available", async () => {
  await batch();
  const result = await Promise.allSettled([
    reserveIncomingStock(db, demand()),
    reserveIncomingStock(db, demand()),
  ]);
  expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((row) => row.status === "rejected")).toHaveLength(1);
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(2);
  expect(
    (
      await db("gp_incoming_commitment")
        .sum("remaining_quantity as qty")
        .first()
    ).qty
  ).toBe("8");
});
it("replays concurrent identical requests without a second commitment and rejects changed payloads", async () => {
  await batch();
  const input = demand();
  const results = await Promise.all([
    reserveIncomingStock(db, input),
    reserveIncomingStock(db, input),
  ]);
  expect(results[0]).toEqual(results[1]);
  await expect(
    reserveIncomingStock(db, { ...input, quantity: 2 })
  ).rejects.toThrow("different data");
  await expect(
    reserveIncomingStock(db, { ...input, request_id: randomUUID() })
  ).rejects.toThrow("Demand already exists");
  expect(await db("gp_incoming_commitment").count("*").first()).toEqual({
    count: "1",
  });
});
it("rejects stock usable October 6 for October 5 preparation despite October 9 arrival", async () => {
  await batch(10, { usable_at: "2026-10-06T08:00:00.000Z" });
  await expect(reserveIncomingStock(db, demand())).rejects.toThrow(
    "insufficient"
  );
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(0);
});
it("allocates across compatible batches but never across a different stock unit or ListID", async () => {
  await batch(4);
  await batch(6);
  await expect(
    reserveIncomingStock(db, demand(8, { stock_unit: "pounds" }))
  ).rejects.toThrow("differs");
  await expect(
    reserveIncomingStock(db, demand(8, { qbd_list_id: "wrong" }))
  ).rejects.toThrow("differs");
  const result = await reserveIncomingStock(db, demand());
  expect(result.commitments).toHaveLength(2);
  expect(
    result.commitments.reduce((sum: number, row: any) => sum + row.quantity, 0)
  ).toBe(8);
});
it("rejects duplicate active cart-line demand even when the caller invents a new demand key", async () => {
  await batch(20);
  const input = demand();
  await reserveIncomingStock(db, input);
  await expect(
    reserveIncomingStock(db, {
      ...input,
      request_id: randomUUID(),
      demand_id: "new-key",
    })
  ).rejects.toThrow("gp_incoming_demand_cart_line");
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(12);
});
it("rolls back supply reservation and audit together when persistence fails", async () => {
  await batch();
  await db.raw(
    "alter table gp_incoming_event add constraint reject_test_demand check (event_type <> 'demand_committed')"
  );
  try {
    await expect(reserveIncomingStock(db, demand())).rejects.toThrow(
      "reject_test_demand"
    );
  } finally {
    await db.raw(
      "alter table gp_incoming_event drop constraint reject_test_demand"
    );
  }
  expect(await db("gp_incoming_demand").count("*").first()).toEqual({
    count: "0",
  });
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(10);
});
it("allows an enclosing checkout transaction to roll back all lines when another line has no supply", async () => {
  await batch();
  await expect(
    db.transaction(async (trx: any) => {
      await reserveIncomingStock(trx, demand());
      await reserveIncomingStock(
        trx,
        demand(1, {
          variant_id: "variant_without_supply",
          qbd_list_id: "8001-FIXTURE",
        })
      );
    })
  ).rejects.toThrow("insufficient");
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(10);
  expect(await db("gp_incoming_demand").count("*").first()).toEqual({
    count: "0",
  });
});
it.each(["revise", "cancel"])(
  "flags affected orders on %s and never changes the accepted date",
  async (action) => {
    const b = await batch();
    const input = demand();
    await reserveIncomingStock(db, input);
    const result = await reviseIncomingBatch(db, {
      ...cmd(),
      batch_id: b.id,
      expected_revision: b.revision,
      action: action as any,
      confirmed_quantity: 6,
      usable_at,
    });
    expect(result.affected_demand_ids).toEqual([input.demand_id]);
    const stored = await db("gp_incoming_demand")
      .where({ id: input.demand_id })
      .first();
    expect(stored.exception_reason).toBe(
      action === "cancel" ? "incoming_cancelled" : "incoming_short"
    );
    expect(new Date(stored.customer_date).toISOString().slice(0, 10)).toBe(
      "2026-10-09"
    );
    expect(new Date(stored.needed_by).toISOString()).toBe(needed_by);
    expect(
      (await previewIncomingStock(db, { ...identity, needed_by }))
        .available_quantity
    ).toBe(0);
  }
);
it("keeps late-batch exceptions open even if the supply date is moved back", async () => {
  const b = await batch();
  const input = demand();
  await reserveIncomingStock(db, input);
  const late = await reviseIncomingBatch(db, {
    ...cmd(),
    batch_id: b.id,
    expected_revision: 1,
    action: "revise",
    confirmed_quantity: 10,
    usable_at: "2026-10-06T08:00:00.000Z",
  });
  expect(late.affected_demand_ids).toEqual([input.demand_id]);
  await reviseIncomingBatch(db, {
    ...cmd(),
    batch_id: b.id,
    expected_revision: 2,
    action: "revise",
    confirmed_quantity: 10,
    usable_at,
  });
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(0);
  expect(
    (await listIncomingStock(db, identity.variant_id)).demands[0]
      .exception_reason
  ).toBe("incoming_late");
});
it("applies partial releases once, rejects over-release and preserves original demand", async () => {
  await batch();
  const input = demand();
  await reserveIncomingStock(db, input);
  const refund = {
    ...cmd(),
    demand_id: input.demand_id,
    quantity: 3,
    release_reason: "prefulfillment_refund" as const,
  };
  await Promise.all([
    releaseIncomingStock(db, refund),
    releaseIncomingStock(db, refund),
  ]);
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(5);
  await expect(
    releaseIncomingStock(db, {
      ...cmd(),
      demand_id: input.demand_id,
      quantity: 6,
      release_reason: "cancelled",
    })
  ).rejects.toThrow("exceeds");
  await releaseIncomingStock(db, {
    ...cmd(),
    demand_id: input.demand_id,
    quantity: 5,
    release_reason: "cancelled",
  });
  await reserveIncomingStock(db, input); // Old placement replay must not resurrect cancelled stock.
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(10);
  expect(
    await db("gp_incoming_demand").where({ id: input.demand_id }).first()
  ).toMatchObject({ quantity: 8, remaining_quantity: 0, status: "released" });
});
it("stages a short receipt once, flags demand and refuses any claim that native stock was applied", async () => {
  const b = await batch();
  const d = demand();
  await reserveIncomingStock(db, d);
  const input = {
    ...cmd(),
    batch_id: b.id,
    expected_revision: 1,
    source_system: "receiving_fixture",
    source_ref: "receipt-1",
    quantity: 6,
    usable_at,
  };
  const results = await Promise.all([
    stageIncomingReceipt(db, input),
    stageIncomingReceipt(db, input),
  ]);
  expect(results[0].receipt.id).toEqual(results[1].receipt.id);
  expect(results[0]).toMatchObject({
    inventory_applied: false,
    affected_demand_ids: [d.demand_id],
    receipt: { status: "pending_adapter", quantity: 6 },
  });
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(0);
  expect(await db("gp_incoming_receipt").count("*").first()).toEqual({
    count: "1",
  });
  await expect(
    stageIncomingReceipt(db, { ...input, request_id: randomUUID() })
  ).rejects.toThrow("current confirmed batch");
});
it("replays a zero final receipt after an unknown response without claiming stock", async () => {
  const b = await batch(8);
  const d = demand(8);
  await reserveIncomingStock(db, d);
  const input = {
    ...cmd(), batch_id: b.id, expected_revision: 1,
    source_system: "receiving_fixture", source_ref: "zero-final",
    quantity: 0, usable_at,
  };
  // The first response is intentionally discarded, as after a caller timeout.
  await stageIncomingReceipt(db, input);
  const replay = await stageIncomingReceipt(db, input);
  expect(replay).toMatchObject({
    inventory_applied: false,
    affected_demand_ids: [d.demand_id],
    receipt: { quantity: 0, status: "pending_adapter" },
  });
  expect(await db("gp_incoming_receipt").count("*").first()).toEqual({ count: "1" });
  expect(await db("gp_incoming_event").where({ event_type: "receipt_staged" }).count("*").first()).toEqual({ count: "1" });
  expect((await db("gp_incoming_demand").where({ id: d.demand_id }).first()).exception_reason).toBe("incoming_short");
});
it("allows only one of two independent consumers to stage the same source", async () => {
  const firstBatch = await batch(3), secondBatch = await batch(3);
  const input = {
    source_system: "receiving_fixture", source_ref: "shared-source",
    quantity: 3, usable_at,
  };
  const attempts = await Promise.allSettled([
    stageIncomingReceipt(db, { ...cmd(), ...input, batch_id: firstBatch.id, expected_revision: 1 }),
    stageIncomingReceipt(db, { ...cmd(), ...input, batch_id: secondBatch.id, expected_revision: 1 }),
  ]);
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  expect(await db("gp_incoming_receipt").count("*").first()).toEqual({ count: "1" });
  expect((await db("gp_incoming_batch").where({ status: "receipt_pending" })).length).toBe(1);
});
it("keeps rolling partial receipts blocked at the current final-only staging boundary", async () => {
  const b = await batch(5);
  const d = demand(4);
  await reserveIncomingStock(db, d);
  await stageIncomingReceipt(db, {
    ...cmd(), batch_id: b.id, expected_revision: 1,
    source_system: "receiving_fixture", source_ref: "part-one",
    quantity: 3, usable_at,
  });
  await expect(stageIncomingReceipt(db, {
    ...cmd(), batch_id: b.id, expected_revision: 2,
    source_system: "receiving_fixture", source_ref: "part-two",
    quantity: 2, usable_at,
  })).rejects.toThrow("current confirmed batch");
  expect(await db("gp_incoming_receipt").count("*").first()).toEqual({ count: "1" });
  expect((await db("gp_incoming_batch").where({ id: b.id }).first()).status).toBe("receipt_pending");
  expect((await db("gp_incoming_demand").where({ id: d.demand_id }).first()).exception_reason).toBe("incoming_short");
});
it("prevents the same receipt source being recorded for a second batch", async () => {
  const a = await batch(),
    b = await batch();
  const input = {
    ...cmd(),
    batch_id: a.id,
    expected_revision: 1,
    source_system: "receiving_fixture",
    source_ref: "same-receipt",
    quantity: 10,
    usable_at,
  };
  await stageIncomingReceipt(db, input);
  await expect(
    stageIncomingReceipt(db, {
      ...input,
      request_id: randomUUID(),
      batch_id: b.id,
    })
  ).rejects.toThrow("already recorded");
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(10);
});
it("rejects stale edits, impossible dates and fractional quantities before they affect capacity", async () => {
  const b = await batch();
  await expect(
    reviseIncomingBatch(db, {
      ...cmd(),
      batch_id: b.id,
      expected_revision: 0,
      action: "revise",
      confirmed_quantity: 3,
      usable_at,
    })
  ).rejects.toThrow("changed");
  await expect(reserveIncomingStock(db, demand(1.5))).rejects.toThrow(
    "whole sellable unit"
  );
  await expect(
    reserveIncomingStock(db, demand(1, { needed_by: "2026-02-30T08:00:00Z" }))
  ).rejects.toThrow("valid UTC");
  await expect(
    reserveIncomingStock(db, demand(1, { customer_date: "2026-02-30" }))
  ).rejects.toThrow("real ISO date");
  expect(
    (await previewIncomingStock(db, { ...identity, needed_by }))
      .available_quantity
  ).toBe(10);
});
it("serializes revision against reservations so total promises never exceed available confirmed stock", async () => {
  const b = await batch();
  const results = await Promise.allSettled([
    reserveIncomingStock(db, demand()),
    reviseIncomingBatch(db, {
      ...cmd(),
      batch_id: b.id,
      expected_revision: 1,
      action: "revise",
      confirmed_quantity: 6,
      usable_at,
    }),
  ]);
  expect(results[1].status).toBe("fulfilled");
  const current = await listIncomingStock(db, identity.variant_id);
  if (results[0].status === "fulfilled")
    expect(current.demands[0].exception_reason).toBe("incoming_short");
  else expect(current.demands).toHaveLength(0);
  expect(current.batches[0].available_quantity).toBe(
    results[0].status === "fulfilled" ? 0 : 6
  );
});
it("requires a current named receiving operator and sources identity/actor from the server", async () => {
  const old = process.env.GP_INCOMING_STOCK_OPERATOR_IDS;
  const principal: StaffPrincipal = {
    id: actor.id,
    kind: "customer",
    role: "super_admin",
    email: null,
    name: "Fixture",
    capabilities: staffCapabilities({
      metadata: { gp_staff_role: "super_admin" },
    }),
    transport_id: "gateway",
    auth: { iat: 100 },
  };
  const body = {
    action: "create",
    request_id: randomUUID(),
    reason: actor.reason,
    ...identity,
    source_system: "approved_manual_fixture",
    source_ref: "staff-entry",
    expected_quantity: 10,
    usable_at,
    actor: { id: "forged" },
  };
  const query = {
    graph: async () => ({
      data: [
        {
          id: identity.variant_id,
          metadata: { qbd_list_id: identity.qbd_list_id },
        },
      ],
    }),
  };
  try {
    process.env.GP_INCOMING_STOCK_OPERATOR_IDS = "";
    await expect(
      incomingStockStaffCommand(db, query, principal, body)
    ).rejects.toThrow("explicitly approved");
    process.env.GP_INCOMING_STOCK_OPERATOR_IDS = actor.id;
    await expect(
      incomingStockStaffCommand(db, query, principal, {
        ...body,
        qbd_list_id: "forged",
      })
    ).rejects.toThrow("verified matching");
    const result = await incomingStockStaffCommand(db, query, principal, body);
    expect(result.batch.created_by).toBe(actor.id);
    expect(result.batch.qbd_list_id).toBe(identity.qbd_list_id);
    await incomingStockStaffCommand(db, query, principal, {
      ...body,
      request_id: randomUUID(),
      action: "confirm",
      batch_id: result.batch.id,
      expected_revision: 0,
      confirmed_quantity: 10,
    });
    const receiptBody = {
      ...body,
      request_id: randomUUID(),
      action: "stage_receipt",
      batch_id: result.batch.id,
      expected_revision: 1,
      source_ref: "staff-receipt",
      quantity: 8,
    };
    await expect(
      incomingStockStaffCommand(db, query, principal, receiptBody)
    ).rejects.toThrow("final delivery");
    expect(await db("gp_incoming_receipt").count("*").first()).toEqual({
      count: "0",
    });
    expect(
      await incomingStockStaffCommand(db, query, principal, {
        ...receiptBody,
        receipt_final_confirmed: true,
      })
    ).toMatchObject({
      inventory_applied: false,
      receipt: { quantity: 8, status: "pending_adapter" },
    });
    await db("customer")
      .where({ id: actor.id })
      .update({
        metadata: JSON.stringify({
          gp_staff_role: "super_admin",
          staff_access_revoked: true,
        }),
      });
    await expect(
      incomingStockStaffCommand(db, query, principal, {
        ...body,
        action: "confirm",
        batch_id: result.batch.id,
        expected_revision: 0,
        confirmed_quantity: 10,
      })
    ).rejects.toThrow("access changed");
  } finally {
    if (old === undefined) delete process.env.GP_INCOMING_STOCK_OPERATOR_IDS;
    else process.env.GP_INCOMING_STOCK_OPERATOR_IDS = old;
  }
});
