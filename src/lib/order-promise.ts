import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { validCivilDate } from "./fulfillment-calendar";

export const ORDER_PROMISE_KEY = "gp_order_promise_snapshot_id";
const text = z.string().trim().min(1).max(500);
const money = z
  .number()
  .finite()
  .nonnegative()
  .refine(
    (n) =>
      Number.isSafeInteger(Math.round(n * 100)) &&
      Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    "Money must be USD major units rounded to cents"
  );
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(json),
  ])
);
const jsonRecord = z.record(json);
const address = z
  .object({
    first_name: text,
    last_name: text,
    company: z.string().max(500),
    address_1: text,
    address_2: z.string().max(500),
    city: text,
    province: text,
    postal_code: text,
    country_code: z.literal("us"),
  })
  .strict();

/** Only a trusted checkout adapter may construct this from current server data.
 * It is private order evidence, never an analytics/event payload. */
export const orderPromiseSchema = z
  .object({
    schema_version: z.literal(1),
    cart_id: text,
    customer_id: text,
    currency: z.literal("usd"),
    amount_unit: z.literal("major"),
    amount_basis: z.literal("accepted_placement_estimate_v1"),
    placement_total: money,
    item_total: money,
    shipping_total: money,
    tax_total: money,
    discount_total: money,
    shipping_address: address,
    billing_address: address,
    contact: z
      .object({
        checkout_email: z.string().email(),
        receipt_email: z.string().email(),
        receipt_snapshot_id: text,
        phone: z.string().max(80),
      })
      .strict(),
    lines: z
      .array(
        z
          .object({
            cart_line_id: text,
            variant_id: text,
            product_id: text,
            qbd_list_id: text,
            customer_title: text,
            quantity: z.number().int().positive(),
            pricing_mode: z.enum(["fixed_price", "per_lb"]),
            estimated_unit_price: money,
            estimated_line_total: money,
            rate_per_lb: money.nullable(),
            estimated_weight_lb: z.number().finite().positive().nullable(),
            weight_snapshot: jsonRecord.nullable(),
          })
          .strict()
      )
      .min(1)
      .max(500)
      .superRefine((lines, ctx) => {
        if (
          new Set(lines.map((line) => line.cart_line_id)).size !== lines.length
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate cart line",
          });
        for (const line of lines) {
          if (
            line.pricing_mode === "per_lb" &&
            (line.rate_per_lb === null || line.estimated_weight_lb === null)
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Catch-weight pricing basis is missing",
            });
        }
      }),
    fulfillment: z
      .object({
        mode: z.enum([
          "ups_shipping",
          "plant_pickup",
          "atlanta_delivery",
          "southeast_pickup",
        ]),
        arrival_date: z.string().refine(validCivilDate),
        window_label: z.string().max(500),
        timezone: text,
        service_code: text,
        calendar_revision: text,
        calendar_selection: jsonRecord,
        packing_plan: jsonRecord.nullable(),
        accepted_shipping_price: jsonRecord.nullable(),
      })
      .strict(),
    terms: z
      .object({
        review_version: text,
        sale_terms_revision: text,
        payment_mode: z.enum(["card", "invoice"]),
        final_charge_consent_version: text.nullable(),
        final_charge_consent_text: text.nullable(),
        invoice_terms: text.nullable(),
      })
      .strict()
      .superRefine((terms, ctx) => {
        if (
          terms.payment_mode === "card" &&
          (!terms.final_charge_consent_version ||
            !terms.final_charge_consent_text)
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Card consent is missing",
          });
        if (terms.payment_mode === "invoice" && !terms.invoice_terms)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Approved invoice terms are missing",
          });
      }),
    attribution: z
      .object({
        experiment_assignments: z
          .array(
            z
              .object({
                experiment_id: text,
                version: text,
                variant: text,
              })
              .strict()
          )
          .max(100)
          .refine(
            (assignments) =>
              new Set(assignments.map((assignment) => assignment.experiment_id))
                .size === assignments.length,
            "An experiment may have only one accepted assignment"
          ),
        analytics_consent: z.boolean(),
        test_order: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type OrderPromise = z.infer<typeof orderPromiseSchema>;
export class OrderPromiseError extends Error {
  constructor(public code: string, public status = 409) {
    super(code);
    this.name = "OrderPromiseError";
  }
}
const fail = (code: string, status = 409): never => {
  throw new OrderPromiseError(code, status);
};
const identifier = (value: string) =>
  text.safeParse(value).success && value === value.trim()
    ? value
    : fail("order_review_invalid_identifier", 400);
const validNow = (value?: Date) => {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    fail("order_review_invalid_time", 422);
  return now;
};
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      )
    : value;
export function normalizedOrderPromise(value: unknown): OrderPromise {
  const parsed = orderPromiseSchema.safeParse(value);
  if (!parsed.success) return fail("order_review_incomplete", 422);
  // Serialize now so later caller mutations cannot alter accepted evidence.
  const copy = JSON.parse(JSON.stringify(parsed.data));
  copy.lines.sort((a: any, b: any) =>
    a.cart_line_id.localeCompare(b.cart_line_id)
  );
  copy.attribution.experiment_assignments.sort(
    (a: any, b: any) =>
      a.experiment_id.localeCompare(b.experiment_id) ||
      a.version.localeCompare(b.version)
  );
  return copy;
}
export const orderPromiseHash = (value: OrderPromise) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(normalizedOrderPromise(value))))
    .digest("hex");

async function ownedCart(trx: any, cartId: string, customerId: string) {
  const cart = await trx("cart")
    .where({ id: identifier(cartId) })
    .whereNull("deleted_at")
    .forUpdate()
    .first();
  if (!cart || cart.customer_id !== identifier(customerId))
    fail("order_review_cart_unavailable", 403);
  return cart;
}
const dbDate = (value: string | Date) => new Date(value).toISOString();
function verifiedRow(row: any) {
  try {
    if (!row || orderPromiseHash(row.promise) !== row.content_hash)
      fail("order_promise_evidence_invalid", 503);
  } catch {
    fail("order_promise_evidence_invalid", 503);
  }
  return row;
}

/** Internal: caller must derive owner and the complete promise from trusted server
 * reads, and bound expiresAt by every quote's validity. This is not an API. */
export async function createOrderPromiseReview(
  db: any,
  input: {
    promise: OrderPromise;
    requestId: string;
    expiresAt: Date;
    now?: Date;
  }
) {
  const promise = normalizedOrderPromise(input.promise),
    hash = orderPromiseHash(promise);
  const now = validNow(input.now);
  if (
    !(input.expiresAt instanceof Date) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= now ||
    input.expiresAt.getTime() > now.getTime() + 15 * 60_000
  )
    fail("order_review_invalid_expiry", 422);
  identifier(input.requestId);
  return db.transaction(async (trx: any) => {
    const cart = await ownedCart(trx, promise.cart_id, promise.customer_id);
    const prior = await trx("gp_order_promise_review")
      .where({ cart_id: cart.id, request_id: input.requestId })
      .first();
    if (prior) {
      if (prior.content_hash !== hash)
        fail("order_review_idempotency_conflict");
      return verifiedRow(prior); // Preserve the original expiry; replay never renews it.
    }
    if (
      cart.completed_at ||
      (await trx("order_cart").where({ cart_id: cart.id }).first())
    )
      fail("order_already_placed");
    const row = {
      id: `gpor_${randomUUID()}`,
      cart_id: cart.id,
      customer_id: promise.customer_id,
      request_id: input.requestId,
      content_hash: hash,
      promise,
      created_at: now,
      expires_at: input.expiresAt,
    };
    await trx("gp_order_promise_review").insert(row);
    return row;
  });
}

/** Internal: call before native completion, then compare again in its single
 * validate hook against the exact cart object native Medusa copies. */
export async function acceptOrderPromiseReview(
  db: any,
  input: {
    currentPromise: OrderPromise;
    reviewId: string;
    requestId: string;
    now?: Date;
  }
) {
  const promise = normalizedOrderPromise(input.currentPromise),
    hash = orderPromiseHash(promise);
  identifier(input.reviewId);
  identifier(input.requestId);
  const now = validNow(input.now);
  return db.transaction(async (trx: any) => {
    const cart = await ownedCart(trx, promise.cart_id, promise.customer_id);
    const replay = await trx("gp_order_promise_snapshot")
      .where({ cart_id: cart.id, request_id: input.requestId })
      .first();
    if (replay) {
      if (replay.review_id !== input.reviewId || replay.content_hash !== hash)
        fail("order_acceptance_idempotency_conflict");
      if (cart.metadata?.[ORDER_PROMISE_KEY] !== replay.id)
        fail("order_acceptance_superseded");
      return verifiedRow(replay);
    }
    if (
      cart.completed_at ||
      (await trx("order_cart").where({ cart_id: cart.id }).first())
    )
      fail("order_already_placed");
    const review = await trx("gp_order_promise_review")
      .where({
        id: input.reviewId,
        cart_id: cart.id,
        customer_id: promise.customer_id,
      })
      .first();
    if (
      !review ||
      review.content_hash !== hash ||
      new Date(review.created_at) > now ||
      new Date(review.expires_at) <= now
    )
      fail("order_review_changed_refresh_required");
    verifiedRow(review);
    const reused = await trx("gp_order_promise_snapshot")
      .where({ review_id: review.id })
      .first();
    if (reused) fail("order_review_already_accepted");
    const latest = await trx("gp_order_promise_snapshot")
      .where({ cart_id: cart.id })
      .max("revision as revision")
      .first();
    const row = {
      id: `gpos_${randomUUID()}`,
      cart_id: cart.id,
      customer_id: promise.customer_id,
      review_id: review.id,
      revision: Number(latest?.revision || 0) + 1,
      request_id: input.requestId,
      content_hash: hash,
      promise: review.promise,
      accepted_at: now,
    };
    await trx("gp_order_promise_snapshot").insert(row);
    await trx("cart")
      .where({ id: cart.id })
      .update({
        metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
          JSON.stringify({ [ORDER_PROMISE_KEY]: row.id }),
        ]),
        updated_at: now,
      });
    return row;
  });
}

export async function validateOrderPromiseSnapshot(
  db: any,
  input: {
    snapshotId: string;
    promise: OrderPromise;
    reviewId: string;
    now?: Date;
  }
) {
  const promise = normalizedOrderPromise(input.promise);
  const row = await db("gp_order_promise_snapshot as snapshot")
    .join(
      "gp_order_promise_review as review",
      "review.id",
      "snapshot.review_id"
    )
    .join("cart", "cart.id", "snapshot.cart_id")
    .where({
      "snapshot.id": identifier(input.snapshotId),
      "snapshot.cart_id": promise.cart_id,
      "snapshot.customer_id": promise.customer_id,
      "snapshot.review_id": identifier(input.reviewId),
      "cart.customer_id": promise.customer_id,
    })
    .whereNull("cart.deleted_at")
    .whereNull("cart.completed_at")
    .select("snapshot.*", "review.expires_at", "cart.metadata as cart_metadata")
    .first();
  if (
    !row ||
    row.content_hash !== orderPromiseHash(promise) ||
    row.cart_metadata?.[ORDER_PROMISE_KEY] !== row.id ||
    new Date(row.expires_at) <= validNow(input.now)
  )
    fail("order_acceptance_changed");
  return verifiedRow(row);
}

/** The object must come directly from completeCartWorkflow.run(), never from
 * a request body, order.placed event, or a caller-supplied success flag. */
export function completedCartEvidence(cartId: string, completion: any) {
  identifier(cartId);
  const transaction = completion?.transaction;
  // A recovered distributed transaction keeps the input in its persisted
  // context even when its transient payload property is absent.
  const payload = transaction?.payload ?? transaction?.getContext?.()?.payload;
  if (
    completion?.thrownError ||
    completion?.errors?.length ||
    !transaction ||
    transaction.modelId !== "complete-cart" ||
    transaction.transactionId !== cartId ||
    payload?.id !== cartId ||
    typeof transaction.hasFinished !== "function" ||
    !transaction.hasFinished() ||
    typeof transaction.getState !== "function" ||
    transaction.getState() !== "done" ||
    typeof transaction.getErrors !== "function" ||
    transaction.getErrors().length ||
    typeof transaction.runId !== "string" ||
    !transaction.runId ||
    typeof completion?.result?.id !== "string" ||
    !completion.result.id
  )
    fail("order_promise_completion_unconfirmed", 503);
  return {
    orderId: identifier(completion.result.id),
    runId: identifier(transaction.runId),
  };
}

/** Internal completion adapter only. Requires a successful native return,
 * its actual durable order/cart link and both server-owned snapshot pointers.
 * Grouped native events are not a substitute for this completion receipt. */
export async function bindOrderPromise(
  db: any,
  cartId: string,
  completion: unknown
) {
  const { orderId, runId } = completedCartEvidence(cartId, completion);
  return db.transaction(async (trx: any) => {
    const cart = await trx("cart")
      .where({ id: cartId })
      .whereNull("deleted_at")
      .forUpdate()
      .first();
    const order = await trx("order")
      .where({ id: identifier(orderId) })
      .whereNull("deleted_at")
      .forUpdate()
      .first();
    if (!order || !cart?.completed_at || cart.customer_id !== order.customer_id)
      fail("order_promise_order_unavailable", 503);
    const link = await trx("order_cart")
      .where({ order_id: orderId, cart_id: cartId })
      .whereNull("deleted_at")
      .first();
    const id = order.metadata?.[ORDER_PROMISE_KEY];
    const snapshot =
      link &&
      typeof id === "string" &&
      cart.metadata?.[ORDER_PROMISE_KEY] === id
        ? await trx("gp_order_promise_snapshot")
            .where({
              id,
              cart_id: link.cart_id,
              customer_id: order.customer_id,
            })
            .first()
        : null;
    if (!snapshot) fail("order_promise_binding_unavailable", 503);
    verifiedRow(snapshot);
    const existing = await trx("gp_order_promise_binding")
      .where({ order_id: orderId })
      .first();
    if (existing) {
      if (existing.cart_id !== cartId || existing.snapshot_id !== snapshot.id)
        fail("order_promise_binding_conflict", 503);
      return existing;
    }
    const placedAt = new Date(order.created_at);
    if (!order.created_at || !Number.isFinite(placedAt.getTime()))
      fail("order_promise_order_unavailable", 503);
    const binding = {
      order_id: orderId,
      cart_id: cartId,
      snapshot_id: snapshot.id,
      workflow_id: "complete-cart",
      workflow_transaction_id: cartId,
      workflow_run_id: runId,
      placed_at: placedAt,
    };
    await trx("gp_order_promise_binding").insert(binding);
    return binding;
  });
}

/** Read-only, explicit unavailable result. Never substitute current/final totals. */
export async function readOriginalOrderPromise(db: any, orderId: string) {
  const row = await db("gp_order_promise_binding as binding")
    .join(
      "gp_order_promise_snapshot as snapshot",
      "snapshot.id",
      "binding.snapshot_id"
    )
    .join("order as native_order", "native_order.id", "binding.order_id")
    .join("order_cart as link", function (this: any) {
      this.on("link.order_id", "binding.order_id").andOn(
        "link.cart_id",
        "binding.cart_id"
      );
    })
    .where("binding.order_id", identifier(orderId))
    .whereNull("native_order.deleted_at")
    .whereNull("link.deleted_at")
    .whereColumn("native_order.customer_id", "snapshot.customer_id")
    .select("snapshot.*", "binding.order_id", "binding.placed_at")
    .first();
  if (!row) fail("order_promise_original_unavailable", 503);
  return verifiedRow(row);
}

/** An allowlist, not redaction of the private promise. No contacts, address,
 * line items, QBD identities or payment instruments can enter this projection. */
export function orderPromiseAnalytics(row: any) {
  verifiedRow(row);
  if (!row.order_id || !row.placed_at)
    fail("order_promise_original_unavailable", 503);
  return {
    order_id: row.order_id,
    accepted_revision: Number(row.revision),
    accepted_at: dbDate(row.accepted_at),
    placed_at: dbDate(row.placed_at),
    amount_basis: row.promise.amount_basis,
    amount_unit: row.promise.amount_unit,
    currency: row.promise.currency,
    placement_total: row.promise.placement_total,
    calendar_revision: row.promise.fulfillment.calendar_revision,
    review_version: row.promise.terms.review_version,
    experiment_assignments: row.promise.attribution.experiment_assignments.map(
      (assignment: any) => ({ ...assignment })
    ),
    analytics_consent: row.promise.attribution.analytics_consent,
    test_order: row.promise.attribution.test_order,
  };
}
