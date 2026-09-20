/** Native records are the durable source. Polling does not depend on delivery of
 * the transient Medusa event and never invokes a payment or fulfillment action. */
export const LIFECYCLE_EVENTS = {
  canceled: "order_canceled",
  fulfillment_created: "fulfillment_created",
  shipped: "order_shipped",
  delivered: "order_delivered",
  return_requested: "return_created",
  refunded: "order_refunded",
} as const;
export type LifecycleKind = keyof typeof LIFECYCLE_EVENTS;

const one = (rows: any[]) => {
  if (rows.length !== 1) throw new Error("lifecycle_source_not_unique");
  return rows[0];
};
const amount = (value: any) => {
  const n = Number(value);
  if (
    value == null ||
    value === "" ||
    !Number.isFinite(n) ||
    n <= 0 ||
    !Number.isSafeInteger(Math.round(n * 100)) ||
    Math.abs(n * 100 - Math.round(n * 100)) > 1e-6
  )
    throw new Error("lifecycle_refund_amount_invalid");
  return n;
};
const currency = (value: any) => {
  if (typeof value !== "string" || !/^[a-zA-Z]{3}$/.test(value))
    throw new Error("lifecycle_currency_invalid");
  return value.toLowerCase();
};

/** Per-kind anti-joins avoid repeatedly selecting the first page of an old
 * backlog. A corrupt source still gets an intent and cannot starve later rows. */
export async function reconcileLifecyclePublications(
  db: any,
  starts: Date,
  request: (
    kind: LifecycleKind,
    orderId: string,
    sourceId: string
  ) => Promise<void>,
  limit = 100
) {
  const base = () =>
    db("gp_order_promise_binding as b").where("b.placed_at", ">=", starts);
  const sources: Array<{ kind: LifecycleKind; source: string; query: any }> = [
    {
      kind: "canceled",
      source: "o.id",
      query: base()
        .join("order as o", "o.id", "b.order_id")
        .whereNull("o.deleted_at")
        .where("o.status", "canceled")
        .whereNotNull("o.canceled_at"),
    },
    ...(["fulfillment_created", "shipped", "delivered"] as const).map(
      (kind) => ({
        kind,
        source: "f.id",
        query: base()
          .join("order_fulfillment as l", "l.order_id", "b.order_id")
          .join("fulfillment as f", "f.id", "l.fulfillment_id")
          .whereNull("l.deleted_at")
          .whereNull("f.deleted_at")
          .whereNotNull(
            `f.${
              kind === "shipped"
                ? "shipped_at"
                : kind === "delivered"
                ? "delivered_at"
                : "created_at"
            }`
          ),
      })
    ),
    {
      kind: "return_requested",
      source: "r.id",
      query: base()
        .join("return as r", "r.order_id", "b.order_id")
        .whereNull("r.deleted_at")
        .whereNotNull("r.requested_at"),
    },
    {
      kind: "refunded",
      source: "r.id",
      query: base()
        .join("order_payment_collection as l", "l.order_id", "b.order_id")
        .join(
          "payment as p",
          "p.payment_collection_id",
          "l.payment_collection_id"
        )
        .join("refund as r", "r.payment_id", "p.id")
        .whereNull("l.deleted_at")
        .whereNull("p.deleted_at")
        .whereNull("r.deleted_at")
        // Refund rows exist before the provider call. The native order transaction
        // is written only after refundPayment returns; a row alone is not proof.
        .whereExists(
          db("order_transaction as t")
            .select(db.raw("1"))
            .whereColumn("t.order_id", "b.order_id")
            .whereColumn("t.reference_id", "r.id")
            .where("t.reference", "refund")
            .whereNull("t.deleted_at")
        ),
    },
    {
      kind: "refunded",
      source: "r.provider_refund_id",
      query: base()
        .join("gp_staff_refund_request as r", "r.order_id", "b.order_id")
        .where("r.payment_id", "like", "final_charge:%")
        .where("r.status", "succeeded")
        .whereNotNull("r.provider_refund_id"),
    },
  ];
  let discovered = 0;
  for (const { kind, source, query } of sources) {
    const rows = await query
      .whereNotExists(
        db("gp_order_publication as j")
          .select(db.raw("1"))
          .whereColumn("j.order_id", "b.order_id")
          .where("j.kind", kind)
          .whereColumn("j.source_id", source)
      )
      .select("b.order_id", `${source} as source_id`)
      .distinct()
      .orderBy("b.order_id")
      .orderBy("source_id")
      .limit(limit);
    for (const row of rows) {
      await request(kind, row.order_id, row.source_id);
      discovered++;
    }
  }
  return discovered;
}

/** A resolved lifecycle publication is subsequently immutable. Do not copy
 * contact data, mutable totals or provider payloads into the analytics record. */
export async function readLifecyclePublication(db: any, intent: any) {
  const { kind, order_id: orderId, source_id: sourceId } = intent;
  if (kind === "canceled") {
    const row = one(
      await db("order")
        .where({ id: orderId, status: "canceled" })
        .whereNull("deleted_at")
    );
    if (sourceId !== orderId) throw new Error("lifecycle_order_mismatch");
    return { at: row.canceled_at, properties: { lifecycle_scope: "order" } };
  }
  if (["fulfillment_created", "shipped", "delivered"].includes(kind)) {
    const row = one(
      await db("fulfillment as f")
        .join("order_fulfillment as l", "l.fulfillment_id", "f.id")
        .where("f.id", sourceId)
        .where("l.order_id", orderId)
        .whereNull("f.deleted_at")
        .whereNull("l.deleted_at")
        .select("f.*")
    );
    const field =
      kind === "shipped"
        ? "shipped_at"
        : kind === "delivered"
        ? "delivered_at"
        : "created_at";
    return {
      at: row[field],
      properties: { fulfillment_id: sourceId, lifecycle_scope: "fulfillment" },
    };
  }
  if (kind === "return_requested") {
    const row = one(
      await db("return")
        .where({ id: sourceId, order_id: orderId })
        .whereNull("deleted_at")
    );
    return {
      at: row.requested_at,
      properties: {
        return_id: sourceId,
        return_status: "requested",
        lifecycle_scope: "return",
      },
    };
  }
  if (kind !== "refunded") throw new Error("lifecycle_kind_invalid");
  const native = await db("refund as r")
    .join("payment as p", "p.id", "r.payment_id")
    .join(
      "order_payment_collection as l",
      "l.payment_collection_id",
      "p.payment_collection_id"
    )
    .where("r.id", sourceId)
    .where("l.order_id", orderId)
    .whereNull("r.deleted_at")
    .whereNull("p.deleted_at")
    .whereNull("l.deleted_at")
    .select("r.amount", "p.currency_code");
  const direct = await db("gp_staff_refund_request")
    .where({
      order_id: orderId,
      provider_refund_id: sourceId,
      status: "succeeded",
    })
    .where("payment_id", "like", "final_charge:%");
  if (native.length + direct.length !== 1)
    throw new Error("lifecycle_refund_source_not_unique");
  let value: number,
    currencyCode: string,
    providerStatus = "unverified";
  if (native.length) {
    value = amount(native[0].amount);
    currencyCode = currency(native[0].currency_code);
  } else {
    const request = direct[0],
      payment = request.response?.payment;
    const refund = one(
      (payment?.refunds || []).filter((r: any) => r.id === sourceId)
    );
    const receipt = refund.data;
    if (
      payment.id !== request.payment_id ||
      receipt?.id !== sourceId ||
      receipt.payment_intent !==
        request.payment_id.slice("final_charge:".length) ||
      !["pending", "succeeded"].includes(receipt.status)
    )
      throw new Error("lifecycle_provider_receipt_unavailable");
    value = amount(refund.amount);
    currencyCode = currency(payment.currency_code);
    if (
      Math.round(value * 100) !== receipt.amount ||
      currency(receipt.currency) !== currencyCode
    )
      throw new Error("lifecycle_provider_amount_mismatch");
    providerStatus = receipt.status;
  }
  const transaction = one(
    await db("order_transaction")
      .where({ order_id: orderId, reference: "refund", reference_id: sourceId })
      .whereNull("deleted_at")
  );
  if (
    Number(transaction.amount) !== -value ||
    currency(transaction.currency_code) !== currencyCode
  )
    throw new Error("lifecycle_refund_transaction_mismatch");
  return {
    at: transaction.created_at,
    properties: {
      value,
      total: value,
      refund_amount: value,
      refund_id: sourceId,
      currency: currencyCode,
      currency_code: currencyCode,
      amount_basis: "recorded_refund_v1",
      payment_evidence: "recorded_refund_not_bank_settlement",
      refund_status: "recorded",
      refund_provider_status: providerStatus,
      lifecycle_scope: "refund",
    },
  };
}
