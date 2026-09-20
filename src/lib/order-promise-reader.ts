import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OrderPromiseError,
  orderPromiseAnalytics,
  readOriginalOrderPromise,
} from "./order-promise";

export const ORDER_PROMISE_READ_PATH = "/admin/grillers/analytics/order-promises";
const querySchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export function parseOrderPromiseReadQuery(value: unknown, now = new Date()) {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) throw new OrderPromiseError("invalid_original_read_query", 400);
  const query = parsed.data;
  const start = Date.parse(query.start), end = Date.parse(query.end);
  if (start >= end || end - start > 31 * 86_400_000 || end > now.getTime()
    || (query.offset > 0 && !query.revision)) {
    throw new OrderPromiseError("invalid_original_read_window", 400);
  }
  return { ...query, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** A bounded, read-only window over native orders, not just the evidence table:
 * missing originals cannot disappear from count/revenue. Each page is a database
 * snapshot; a manifest fingerprint rejects changes between requests, including
 * a newly bound order when the total count has not changed. */
export async function readOrderPromisePage(db: any, input: unknown, now = new Date()) {
  const query = parseOrderPromiseReadQuery(input, now);
  return db.transaction(async (trx: any) => {
    const manifest = await trx("order as native_order")
      .fullOuterJoin("gp_order_promise_binding as binding", "binding.order_id", "native_order.id")
      .leftJoin("gp_order_promise_snapshot as snapshot", "snapshot.id", "binding.snapshot_id")
      .leftJoin("order_cart as link", function (this: any) {
        this.on("link.order_id", "native_order.id").andOn("link.cart_id", "binding.cart_id");
      })
      // Retain broken/deleted native evidence once an original was bound. It
      // must fail the read, not erase a historical placement from the window.
      .where(function (this: any) {
        this.whereNull("native_order.deleted_at").orWhereNotNull("binding.order_id");
      })
      .whereRaw("coalesce(binding.placed_at, native_order.created_at) >= ?", [query.start])
      .whereRaw("coalesce(binding.placed_at, native_order.created_at) < ?", [query.end])
      .orderByRaw("coalesce(native_order.id, binding.order_id) asc")
      .select(trx.raw("coalesce(native_order.id, binding.order_id) as id"),
        "native_order.created_at", "native_order.deleted_at", "native_order.customer_id",
        "binding.snapshot_id", "binding.placed_at", "snapshot.content_hash",
        "link.order_id as linked_order_id", "link.deleted_at as link_deleted_at")
      .limit(10_001);
    if (manifest.length > 10_000) throw new OrderPromiseError("original_read_window_too_large", 422);
    const revision = createHash("sha256")
      .update(JSON.stringify({ start: query.start, end: query.end, manifest })).digest("hex");
    if (query.revision && query.revision !== revision)
      throw new OrderPromiseError("original_read_window_changed", 409);
    if (query.offset > manifest.length)
      throw new OrderPromiseError("invalid_original_read_offset", 400);
    const orders = [];
    for (const item of manifest.slice(query.offset, query.offset + query.limit)) {
      const original = await readOriginalOrderPromise(trx, item.id);
      const projected = orderPromiseAnalytics(original);
      if (projected.placed_at !== new Date(item.created_at).toISOString())
        throw new OrderPromiseError("original_read_placement_mismatch", 503);
      orders.push(projected);
    }
    return { contract_version: 1, start: query.start, end: query.end, revision,
      count: manifest.length, offset: query.offset, limit: query.limit, orders };
  }, { isolationLevel: "repeatable read", readOnly: true });
}
