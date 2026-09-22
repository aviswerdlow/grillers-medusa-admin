import { getAmountFromSmallestUnit } from "@medusajs/payment-stripe/dist/utils/get-smallest-unit";

export async function readProviderRefundPublication(db: any, intent: any) {
  const rows = await db("gp_refund_provider_receipt as r")
    .join("gp_refund_provider_binding as b", "b.refund_id", "r.refund_id")
    .join("gp_refund_provider_scope as s", function (this: any) {
      this.on("s.account_id", "r.account_id").andOn("s.livemode", "r.livemode");
    })
    .where("r.id", intent.source_id)
    .where("b.order_id", intent.order_id)
    .select("r.*", "b.native_refund_id", "b.origin");
  if (rows.length !== 1) throw new Error("refund_provider_receipt_unavailable");
  const r = rows[0];
  const value = getAmountFromSmallestUnit(
    Number(r.amount_minor),
    r.currency_code
  );
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("refund_provider_value_invalid");
  return {
    at: r.observed_at,
    livemode: r.livemode as boolean,
    properties: {
      value,
      total: value,
      refund_amount: value,
      currency: r.currency_code,
      currency_code: r.currency_code,
      refund_id: r.refund_id,
      provider_refund_id: r.refund_id,
      native_refund_id: r.native_refund_id,
      refund_provider_status: r.status,
      refund_observation_revision: r.revision,
      refund_status: "provider_observed",
      refund_origin: r.origin,
      amount_basis: "provider_refund_observation_v1",
      payment_evidence: "provider_status_not_bank_settlement",
      lifecycle_scope: "refund",
      provider_observed_at: new Date(r.observed_at).toISOString(),
    },
  };
}

/** One immutable source owns successful-refund measurement. Reserve existing
 * ready direct-success events and new sources beyond downstream cache TTLs. */
export async function claimRefundMeasurement(
  db: any,
  intent: any,
  properties: any
) {
  const refundId = properties.provider_refund_id;
  if (!/^re_[a-zA-Z0-9_]{1,190}$/.test(refundId || ""))
    throw new Error("refund_measurement_identity_unavailable");
  const old = await db("gp_order_publication")
    .where({ kind: "refunded", source_id: refundId, state: "ready" })
    .whereRaw("properties->>'refund_provider_status' = 'succeeded'")
    .first();
  if (
    old &&
    (old.order_id !== intent.order_id ||
      old.properties.currency !== properties.currency ||
      Number(old.properties.value) !== properties.value)
  )
    throw new Error("refund_measurement_conflict");
  await db("gp_refund_provider_metric")
    .insert({
      refund_id: refundId,
      event_id: old?.event_id || intent.event_id,
      order_id: intent.order_id,
    })
    .onConflict("refund_id")
    .ignore();
  const owner = await db("gp_refund_provider_metric")
    .where({ refund_id: refundId })
    .first();
  if (owner.order_id !== intent.order_id)
    throw new Error("refund_measurement_order_conflict");
  return owner.event_id === intent.event_id;
}
