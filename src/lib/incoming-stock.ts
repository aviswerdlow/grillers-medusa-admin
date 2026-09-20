import { createHash, randomUUID } from "node:crypto";

/** Internal only. Callers authenticate actors and verify calendar/order state. */
export type IncomingActor = { id: string; reason: string };
type Command = { request_id: string; actor: IncomingActor };
export type StockIdentity = {
  variant_id: string;
  qbd_list_id: string;
  stock_unit: string;
};
type Supply = StockIdentity & { needed_by: string };
export class IncomingStockInvalid extends Error {}
export class IncomingStockConflict extends Error {}

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;
const text = (value: unknown, name: string, max = 200): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > max
  )
    throw new IncomingStockInvalid(`${name} is required.`);
  return value;
};
const units = (value: unknown, zero = false): number => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < (zero ? 0 : 1) ||
    Number(value) > 2147483647
  )
    throw new IncomingStockInvalid(
      "Quantity must be a whole sellable unit within the supported range."
    );
  return Number(value);
};
const instant = (value: unknown, name: string): string => {
  const s = text(value, name);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().replace(".000Z", "Z") !== s.replace(".000Z", "Z")
  )
    throw new IncomingStockInvalid(
      `${name} must be a valid UTC instant from an approved boundary.`
    );
  return new Date(s).toISOString();
};
const dateOnly = (value: unknown): string => {
  const s = text(value, "Customer date");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    throw new IncomingStockInvalid("Customer date must be a real ISO date.");
  return s;
};
const identity = (input: StockIdentity): StockIdentity => ({
  variant_id: text(input.variant_id, "Variant"),
  qbd_list_id: text(input.qbd_list_id, "QuickBooks ListID"),
  stock_unit: text(input.stock_unit, "Stock unit", 80),
});
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: any) =>
  createHash("sha256").update(canonical(value)).digest("hex");

async function command(
  db: any,
  variant: string,
  cmd: Command,
  eventType: string,
  payload: any,
  apply: (trx: any) => Promise<any>
) {
  text(cmd.request_id, "Request id");
  text(cmd.actor?.id, "Verified actor");
  text(cmd.actor?.reason, "Audit reason", 1000);
  const digest = hash({ eventType, payload, actor: cmd.actor });
  return db.transaction(async (trx: any) => {
    // Serialize a request before the stock identity. Ordered multi-variant callers
    // must use their own enclosing transaction and roll it back on any failure.
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-incoming-request:${cmd.request_id}`,
    ]);
    const old = await trx("gp_incoming_event")
      .where({ request_id: cmd.request_id })
      .first();
    if (old) {
      if (old.payload_hash !== digest)
        throw new IncomingStockConflict(
          "This request id was already used with different data."
        );
      return old.result;
    }
    await trx.raw("select pg_advisory_xact_lock(hashtextextended(?, 0))", [
      `gp-incoming-variant:${variant}`,
    ]);
    const result = await apply(trx);
    await trx("gp_incoming_event").insert({
      request_id: cmd.request_id,
      payload_hash: digest,
      event_type: eventType,
      variant_id: variant,
      actor_id: cmd.actor.id,
      reason: cmd.actor.reason,
      payload: JSON.stringify(payload),
      result: JSON.stringify(result),
    });
    return result;
  });
}

async function matchingIdentity(trx: any, value: StockIdentity) {
  const existing = await trx("gp_incoming_batch")
    .where({ variant_id: value.variant_id })
    .first();
  if (
    existing &&
    (existing.qbd_list_id !== value.qbd_list_id ||
      existing.stock_unit !== value.stock_unit)
  )
    throw new IncomingStockConflict(
      "Variant identity or sellable unit differs from the existing ledger. Reconcile before continuing."
    );
}

export async function createIncomingBatch(
  db: any,
  input: Command &
    StockIdentity & {
      source_system: string;
      source_ref: string;
      expected_quantity: number;
      usable_at: string;
    }
) {
  const payload = {
    ...identity(input),
    source_system: text(input.source_system, "Source system"),
    source_ref: text(input.source_ref, "Source reference"),
    expected_quantity: units(input.expected_quantity, true),
    usable_at: instant(input.usable_at, "Usable time"),
  };
  return command(
    db,
    payload.variant_id,
    input,
    "batch_created",
    payload,
    async (trx) => {
      await matchingIdentity(trx, payload);
      if (
        await trx("gp_incoming_batch")
          .where({
            source_system: payload.source_system,
            source_ref: payload.source_ref,
          })
          .first()
      )
        throw new IncomingStockConflict(
          "That incoming source is already recorded."
        );
      const [batch] = await trx("gp_incoming_batch")
        .insert({
          ...payload,
          id: id("gpin"),
          status: "draft",
          revision: 0,
          created_by: input.actor.id,
        })
        .returning("*");
      return { batch };
    }
  );
}

async function batchFor(db: any, batchId: string) {
  const batch = await db("gp_incoming_batch")
    .where({ id: text(batchId, "Batch id") })
    .first();
  if (!batch) throw new IncomingStockInvalid("Incoming batch not found.");
  return batch;
}

async function affectedDemands(trx: any, batch: any) {
  const commitments = await trx("gp_incoming_commitment as c")
    .join("gp_incoming_demand as d", "d.id", "c.demand_id")
    .where("c.batch_id", batch.id)
    .where("c.remaining_quantity", ">", 0)
    .select("d.id", "d.needed_by", "c.remaining_quantity");
  const total = commitments.reduce(
    (sum: number, row: any) => sum + row.remaining_quantity,
    0
  );
  const affected: string[] = [];
  for (const row of commitments) {
    const reason =
      batch.status === "cancelled"
        ? "incoming_cancelled"
        : total > batch.confirmed_quantity
        ? "incoming_short"
        : new Date(batch.usable_at) > new Date(row.needed_by)
        ? "incoming_late"
        : null;
    if (!reason) continue;
    // Do not silently clear an earlier exception after supply changes again.
    await trx("gp_incoming_demand")
      .where({ id: row.id })
      .update({ exception_reason: reason, updated_at: trx.fn.now() });
    affected.push(row.id);
  }
  return affected;
}

export async function reviseIncomingBatch(
  db: any,
  input: Command & {
    batch_id: string;
    expected_revision: number;
    action: "confirm" | "revise" | "cancel";
    confirmed_quantity?: number;
    usable_at?: string;
  }
) {
  const initial = await batchFor(db, input.batch_id);
  if (
    !Number.isSafeInteger(input.expected_revision) ||
    input.expected_revision < 0 ||
    !["confirm", "revise", "cancel"].includes(input.action)
  )
    throw new IncomingStockInvalid(
      "Current revision and a valid action are required."
    );
  const payload = {
    batch_id: input.batch_id,
    expected_revision: input.expected_revision,
    action: input.action,
    confirmed_quantity:
      input.action === "cancel" ? 0 : units(input.confirmed_quantity),
    usable_at:
      input.action === "cancel"
        ? null
        : instant(input.usable_at, "Usable time"),
  };
  return command(
    db,
    initial.variant_id,
    input,
    `batch_${input.action}`,
    payload,
    async (trx) => {
      const batch = await batchFor(trx, input.batch_id);
      if (
        batch.revision !== input.expected_revision ||
        ["cancelled", "receipt_pending"].includes(batch.status)
      )
        throw new IncomingStockConflict(
          "Batch changed or is no longer editable. Refresh before continuing."
        );
      if (
        (input.action === "confirm") !== (batch.status === "draft") &&
        input.action !== "cancel"
      )
        throw new IncomingStockConflict(
          "Confirm a draft, or revise a confirmed batch."
        );
      const [updated] = await trx("gp_incoming_batch")
        .where({ id: batch.id })
        .update({
          confirmed_quantity: payload.confirmed_quantity,
          usable_at: payload.usable_at || batch.usable_at,
          status: input.action === "cancel" ? "cancelled" : "confirmed",
          revision: batch.revision + 1,
          confirmed_by: input.actor.id,
          confirmed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning("*");
      const affected_demand_ids = await affectedDemands(trx, updated);
      return { batch: updated, affected_demand_ids };
    }
  );
}

async function supplyRows(db: any, input: Supply) {
  const batches = await db("gp_incoming_batch")
    .where(identity(input))
    .where({ status: "confirmed" })
    .where("usable_at", "<=", input.needed_by)
    .orderBy("usable_at")
    .orderBy("id");
  const rows: any[] = [];
  for (const batch of batches) {
    const [totals] = await db("gp_incoming_commitment as c")
      .join("gp_incoming_demand as d", "d.id", "c.demand_id")
      .where("c.batch_id", batch.id)
      .where("c.remaining_quantity", ">", 0)
      .select(
        db.raw(
          "coalesce(sum(c.remaining_quantity),0)::integer as committed, count(*) filter (where d.exception_reason is not null)::integer as exceptions"
        )
      );
    rows.push({
      ...batch,
      committed_quantity: totals.committed,
      available_quantity: totals.exceptions
        ? 0
        : Math.max(0, batch.confirmed_quantity - totals.committed),
    });
  }
  return rows;
}

/** Advisory only. No calendar verification, on-hand stock, or reservation side effect. */
export async function previewIncomingStock(db: any, input: Supply) {
  const payload = {
    ...identity(input),
    needed_by: instant(input.needed_by, "Preparation deadline"),
  };
  const rows = await supplyRows(db, payload);
  return {
    available_quantity: rows.reduce(
      (sum, row) => sum + row.available_quantity,
      0
    ),
    batches: rows,
  };
}

/** Internal integration primitive; never expose this directly to Store requests. */
export async function reserveIncomingStock(
  db: any,
  input: Command &
    Supply & {
      demand_id: string;
      order_id?: string;
      cart_id?: string;
      line_item_id: string;
      quantity: number;
      customer_date: string;
      calendar_revision: string;
    }
) {
  const payload = {
    ...identity(input),
    needed_by: instant(input.needed_by, "Preparation deadline"),
    demand_id: text(input.demand_id, "Demand id"),
    order_id: input.order_id ? text(input.order_id, "Order id") : null,
    cart_id: input.cart_id ? text(input.cart_id, "Cart id") : null,
    line_item_id: text(input.line_item_id, "Line id"),
    quantity: units(input.quantity),
    customer_date: dateOnly(input.customer_date),
    calendar_revision: text(
      input.calendar_revision,
      "Accepted calendar revision"
    ),
  };
  if (!payload.order_id && !payload.cart_id)
    throw new IncomingStockInvalid("A verified order or cart is required.");
  return command(
    db,
    payload.variant_id,
    input,
    "demand_committed",
    payload,
    async (trx) => {
      await matchingIdentity(trx, payload);
      if (
        await trx("gp_incoming_demand").where({ id: payload.demand_id }).first()
      )
        throw new IncomingStockConflict(
          "Demand already exists. Use its original request for replay or an audited amendment."
        );
      const supply = await supplyRows(trx, payload);
      if (
        supply.reduce((sum, batch) => sum + batch.available_quantity, 0) <
        payload.quantity
      )
        throw new IncomingStockConflict(
          "Confirmed incoming stock is insufficient before preparation."
        );
      const { demand_id, ...row } = payload;
      await trx("gp_incoming_demand").insert({
        ...row,
        id: demand_id,
        remaining_quantity: payload.quantity,
        status: "committed",
      });
      let remaining = payload.quantity;
      const commitments: any[] = [];
      for (const batch of supply) {
        const quantity = Math.min(remaining, batch.available_quantity);
        if (!quantity) continue;
        const commitment = {
          id: id("gpic"),
          demand_id,
          batch_id: batch.id,
          batch_revision: batch.revision,
          quantity,
          remaining_quantity: quantity,
        };
        await trx("gp_incoming_commitment").insert(commitment);
        commitments.push(commitment);
        remaining -= quantity;
        if (!remaining) break;
      }
      return { demand_id, quantity: payload.quantity, commitments };
    }
  );
}

/** Caller must prove cancellation or eligible pre-fulfillment refund quantities. */
export async function releaseIncomingStock(
  db: any,
  input: Command & {
    demand_id: string;
    quantity: number;
    release_reason: "cancelled" | "prefulfillment_refund" | "amendment";
  }
) {
  const initial = await db("gp_incoming_demand")
    .where({ id: text(input.demand_id, "Demand id") })
    .first();
  if (!initial) throw new IncomingStockInvalid("Demand not found.");
  const payload = {
    demand_id: input.demand_id,
    quantity: units(input.quantity),
    release_reason: input.release_reason,
  };
  if (
    !["cancelled", "prefulfillment_refund", "amendment"].includes(
      payload.release_reason
    )
  )
    throw new IncomingStockInvalid("An eligible release reason is required.");
  return command(
    db,
    initial.variant_id,
    input,
    "demand_released",
    payload,
    async (trx) => {
      const demand = await trx("gp_incoming_demand")
        .where({ id: input.demand_id })
        .first();
      if (payload.quantity > demand.remaining_quantity)
        throw new IncomingStockConflict(
          "Release exceeds the remaining commitment."
        );
      let remaining = payload.quantity;
      const commitments = await trx("gp_incoming_commitment")
        .where({ demand_id: demand.id })
        .where("remaining_quantity", ">", 0)
        .orderBy("id", "desc");
      for (const commitment of commitments) {
        const quantity = Math.min(remaining, commitment.remaining_quantity);
        await trx("gp_incoming_commitment")
          .where({ id: commitment.id })
          .update({
            remaining_quantity: commitment.remaining_quantity - quantity,
            updated_at: trx.fn.now(),
          });
        remaining -= quantity;
        if (!remaining) break;
      }
      if (remaining)
        throw new IncomingStockConflict(
          "Commitments do not reconcile. No quantity was released."
        );
      const next = demand.remaining_quantity - payload.quantity;
      await trx("gp_incoming_demand")
        .where({ id: demand.id })
        .update({
          remaining_quantity: next,
          status: next ? "committed" : "released",
          updated_at: trx.fn.now(),
        });
      return {
        demand_id: demand.id,
        released_quantity: payload.quantity,
        remaining_quantity: next,
      };
    }
  );
}

/** Final/short receipt staging only. #321 owns the atomic native adjustment. */
export async function stageIncomingReceipt(
  db: any,
  input: Command & {
    batch_id: string;
    expected_revision: number;
    source_system: string;
    source_ref: string;
    quantity: number;
    usable_at: string;
  }
) {
  const initial = await batchFor(db, input.batch_id);
  const payload = {
    batch_id: input.batch_id,
    expected_revision: input.expected_revision,
    source_system: text(input.source_system, "Receipt source"),
    source_ref: text(input.source_ref, "Receipt reference"),
    quantity: units(input.quantity, true),
    usable_at: instant(input.usable_at, "Actual usable time"),
  };
  if (
    !Number.isSafeInteger(payload.expected_revision) ||
    payload.expected_revision < 0
  )
    throw new IncomingStockInvalid("Current revision is required.");
  return command(
    db,
    initial.variant_id,
    input,
    "receipt_staged",
    payload,
    async (trx) => {
      const batch = await batchFor(trx, input.batch_id);
      if (
        batch.revision !== payload.expected_revision ||
        batch.status !== "confirmed"
      )
        throw new IncomingStockConflict(
          "Only the current confirmed batch can be received."
        );
      if (
        await trx("gp_incoming_receipt")
          .where({
            source_system: payload.source_system,
            source_ref: payload.source_ref,
          })
          .first()
      )
        throw new IncomingStockConflict(
          "This receipt source is already recorded."
        );
      const { expected_revision, ...record } = payload;
      const [receipt] = await trx("gp_incoming_receipt")
        .insert({ ...record, id: id("gpir"), recorded_by: input.actor.id })
        .returning("*");
      const [updated] = await trx("gp_incoming_batch")
        .where({ id: batch.id })
        .update({
          status: "receipt_pending",
          confirmed_quantity: payload.quantity,
          usable_at: payload.usable_at,
          revision: batch.revision + 1,
          updated_at: trx.fn.now(),
        })
        .returning("*");
      const affected_demand_ids = await affectedDemands(trx, updated);
      return {
        receipt,
        affected_demand_ids,
        inventory_applied: false,
        next_action:
          "Receiving adapter must reconcile the source, native adjustment and existing commitments before stock is usable.",
      };
    }
  );
}

export async function listIncomingStock(db: any, variantId: string) {
  const variant_id = text(variantId, "Variant");
  const [batches, demands, commitments, receipts] = await Promise.all([
    db("gp_incoming_batch").where({ variant_id }).orderBy("created_at"),
    db("gp_incoming_demand").where({ variant_id }).orderBy("created_at"),
    db("gp_incoming_commitment as c")
      .join("gp_incoming_batch as b", "b.id", "c.batch_id")
      .where("b.variant_id", variant_id)
      .select("c.*"),
    db("gp_incoming_receipt as r")
      .join("gp_incoming_batch as b", "b.id", "r.batch_id")
      .where("b.variant_id", variant_id)
      .select("r.*"),
  ]);
  return {
    batches: batches.map((batch: any) => {
      const linked = commitments.filter(
        (row: any) => row.batch_id === batch.id
      );
      const committed_quantity = linked.reduce(
        (sum: number, row: any) => sum + row.remaining_quantity,
        0
      );
      const exception = linked.some(
        (row: any) =>
          row.remaining_quantity > 0 &&
          demands.some((d: any) => d.id === row.demand_id && d.exception_reason)
      );
      return {
        ...batch,
        committed_quantity,
        available_quantity:
          batch.status === "confirmed" && !exception
            ? Math.max(0, batch.confirmed_quantity - committed_quantity)
            : 0,
      };
    }),
    demands,
    commitments,
    receipts,
    checkout_enabled: false,
  };
}

/** Bounded staff work queue across products; original promises remain visible. */
export async function listIncomingExceptions(db: any, after?: string) {
  const query = db("gp_incoming_demand")
    .where({ status: "committed" })
    .where("remaining_quantity", ">", 0)
    .whereNotNull("exception_reason")
    .orderBy("id")
    .limit(51);
  if (after) query.where("id", ">", text(after, "Queue cursor"));
  const rows = await query;
  const demands = rows.slice(0, 50);
  return { demands, next_cursor: rows.length > 50 ? demands[49].id : null };
}
