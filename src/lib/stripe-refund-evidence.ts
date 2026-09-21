export const REFUND_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
] as const;
const id = (value: unknown, prefix: string) => {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_[a-zA-Z0-9_]{1,190}$`).test(value)
  )
    throw new Error("refund_identity_invalid");
  return value;
};
export const refundId = (value: unknown) => id(value, "re");
export function stripeRefundEvidence(value: any) {
  const status = value?.status;
  if (
    value?.object !== "refund" ||
    !REFUND_STATUSES.includes(status) ||
    !Number.isSafeInteger(value.amount) ||
    value.amount <= 0 ||
    !/^[a-z]{3}$/.test(value.currency) ||
    !Number.isSafeInteger(value.created) ||
    value.created <= 0 ||
    !Number.isFinite(new Date(value.created * 1000).getTime())
  )
    throw new Error("refund_evidence_invalid");
  const native = value.metadata?.gp_native_refund_id;
  return {
    refund_id: refundId(value.id),
    payment_intent_id: id(
      typeof value.payment_intent === "string"
        ? value.payment_intent
        : value.payment_intent?.id,
      "pi"
    ),
    native_refund_hint: native == null ? null : id(native, "ref"),
    amount_minor: value.amount as number,
    currency_code: value.currency as string,
    status: status as (typeof REFUND_STATUSES)[number],
    provider_created_at: new Date(value.created * 1000),
  };
}
export type RefundEvidence = ReturnType<typeof stripeRefundEvidence>;
export type RefundScope = {
  account_id: string;
  livemode: boolean;
  starts_at: string;
};
export function refundConfiguration(env: NodeJS.ProcessEnv) {
  const key = env.GP_REFUND_STRIPE_READ_KEY || "";
  const match = /^(?:sk|rk)_(test|live)_[a-zA-Z0-9]+$/.exec(key);
  const starts = env.GP_ORDER_PUBLICATION_START_AT || "";
  if (
    !match ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(starts) ||
    !Number.isFinite(Date.parse(starts))
  )
    throw new Error("refund_scope_configuration_missing");
  return {
    key,
    scope: {
      account_id: id(env.GP_REFUND_STRIPE_ACCOUNT_ID, "acct"),
      livemode: match[1] === "live",
      starts_at: new Date(starts).toISOString(),
    },
  };
}

/** The reconciliation transport cannot issue a charge/refund or follow a redirect. */
export function refundReadClient(key: string, transport: typeof fetch = fetch) {
  async function get(path: string) {
    try {
      const response = await transport(`https://api.stripe.com/v1/${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error("refund_provider_read_unavailable");
    }
  }
  return {
    account: () => get("account"),
    refund: (value: string) => get(`refunds/${refundId(value)}`),
    list: (starts: string, after: string | null) => {
      const query = new URLSearchParams({
        limit: "100",
        "created[gte]": String(Math.floor(Date.parse(starts) / 1000)),
      });
      if (after) query.set("starting_after", refundId(after));
      return get(`refunds?${query}`);
    },
  };
}
