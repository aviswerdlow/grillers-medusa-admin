import NativeStripe from "@medusajs/payment-stripe/dist/services/stripe-provider";
import StripeModule from "@medusajs/payment-stripe";
import EvidenceModule from "../../modules/gp-stripe-evidence";
import EvidenceStripe from "../../modules/gp-stripe-evidence/service";
import {
  refundConfiguration,
  refundReadClient,
  stripeRefundEvidence,
} from "../stripe-refund-evidence";

const receipt = () => ({
  object: "refund",
  id: "re_test",
  amount: 1250,
  currency: "usd",
  status: "pending",
  created: 1790000000,
  payment_intent: "pi_test",
  metadata: { gp_native_refund_id: "ref_test" },
});
const input: any = {
  amount: 12.5,
  data: { id: "pi_test", currency: "usd", keep: "original" },
  context: { idempotency_key: "ref_test" },
};
function provider(response: any = receipt()) {
  const p: any = Object.create(EvidenceStripe.prototype);
  p.options_ = { recordRefundEvidence: true };
  p.stripe_ = { refunds: { create: jest.fn().mockResolvedValue(response) } };
  return p;
}
it("preserves all six existing service identities and only replaces the card provider", () => {
  expect(EvidenceModule.services).toHaveLength(6);
  expect(EvidenceModule.services.map((s: any) => s.identifier)).toEqual(
    StripeModule.services.map((s: any) => s.identifier)
  );
  expect(EvidenceStripe.identifier).toBe(NativeStripe.identifier);
  expect(
    EvidenceModule.services.filter((s: any) => s === EvidenceStripe)
  ).toHaveLength(1);
});
it("keeps the native idempotency key, makes one refund, and stores only sanitized evidence", async () => {
  const p = provider({
    ...receipt(),
    contact: "private",
    failure_reason: "private",
  });
  const result = await p.refundPayment(input);
  expect(p.stripe_.refunds.create).toHaveBeenCalledTimes(1);
  expect(p.stripe_.refunds.create).toHaveBeenCalledWith(
    {
      amount: 1250,
      payment_intent: "pi_test",
      metadata: { gp_native_refund_id: "ref_test" },
    },
    { idempotencyKey: "ref_test" }
  );
  expect(result.data).toMatchObject({
    keep: "original",
    gp_refund_receipts: { ref_test: { id: "re_test", status: "pending" } },
  });
  expect(JSON.stringify(result)).not.toContain("private");
});
it.each(["failed", "canceled"])(
  "does not report %s as native acceptance or retry money",
  async (status) => {
    const p = provider({ ...receipt(), status });
    await expect(p.refundPayment(input)).rejects.toThrow("did_not_accept");
    expect(p.stripe_.refunds.create).toHaveBeenCalledTimes(1);
  }
);
it("delegates unchanged behavior while disabled", async () => {
  const old = jest
    .spyOn(NativeStripe.prototype, "refundPayment")
    .mockResolvedValue({ data: { old: true } });
  try {
    const p = provider();
    p.options_ = {};
    await expect(p.refundPayment(input)).resolves.toEqual({
      data: { old: true },
    });
    expect(old).toHaveBeenCalledWith(input);
    expect(p.stripe_.refunds.create).not.toHaveBeenCalled();
  } finally {
    old.mockRestore();
  }
});
it("rejects absent native identity before money, and mismatched provider evidence after one call", async () => {
  const p = provider();
  await expect(p.refundPayment({ ...input, context: {} })).rejects.toThrow(
    "native_identity"
  );
  expect(p.stripe_.refunds.create).not.toHaveBeenCalled();
  p.stripe_.refunds.create.mockResolvedValue({ ...receipt(), amount: 5 });
  await expect(p.refundPayment(input)).rejects.toThrow("response_mismatch");
  expect(p.stripe_.refunds.create).toHaveBeenCalledTimes(1);
});
it.each([
  ["jpy", 1250, 1250],
  ["kwd", 1.25, 1250],
])("preserves installed conversion for %s", async (currency, amount, minor) => {
  const p = provider({ ...receipt(), currency, amount: minor });
  await p.refundPayment({
    ...input,
    amount,
    data: { ...input.data, currency },
  });
  expect(p.stripe_.refunds.create.mock.calls[0][0].amount).toBe(minor);
});
it.each(["pending", "requires_action", "succeeded", "failed", "canceled"])(
  "records valid %s evidence without requiring a nonexistent refund livemode field",
  (status) => {
    expect(stripeRefundEvidence({ ...receipt(), status }).status).toBe(status);
  }
);
it.each([
  { amount: 1.2 },
  { status: null },
  { currency: "" },
  { payment_intent: null },
  { id: "ref_native" },
])("refuses unsupported evidence %j", (patch) => {
  expect(() => stripeRefundEvidence({ ...receipt(), ...patch })).toThrow();
});
it("pins explicit account, key mode and epoch; no broad key fallback", () => {
  const env = {
    GP_REFUND_STRIPE_READ_KEY: "rk_test_synthetic",
    GP_REFUND_STRIPE_ACCOUNT_ID: "acct_test",
    GP_ORDER_PUBLICATION_START_AT: "2026-09-20T00:00:00Z",
  };
  expect(refundConfiguration(env).scope).toEqual({
    account_id: "acct_test",
    livemode: false,
    starts_at: "2026-09-20T00:00:00.000Z",
  });
  expect(() =>
    refundConfiguration({
      ...env,
      GP_REFUND_STRIPE_READ_KEY: "",
      STRIPE_API_KEY: "sk_live_synthetic",
    })
  ).toThrow();
});
it("permits only fixed-origin GETs, refuses redirects and never exposes provider errors", async () => {
  const transport = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({}) });
  const client = refundReadClient("synthetic", transport as any);
  await client.account();
  await client.list("2026-09-20T00:00:00Z", "re_page");
  await client.refund("re_test");
  expect(
    transport.mock.calls.every(
      ([url, init]) =>
        url.startsWith("https://api.stripe.com/v1/") &&
        init.method === "GET" &&
        init.redirect === "error" &&
        !init.body
    )
  ).toBe(true);
  expect(() => client.refund("../../charges")).toThrow();
  transport.mockRejectedValue(new Error("secret and customer body"));
  await expect(client.account()).rejects.toThrow(
    /^refund_provider_read_unavailable$/
  );
});
