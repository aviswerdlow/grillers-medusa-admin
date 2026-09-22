import StripeProvider from "@medusajs/payment-stripe/dist/services/stripe-provider";
import { getSmallestUnit } from "@medusajs/payment-stripe/dist/utils/get-smallest-unit";
import type {
  RefundPaymentInput,
  RefundPaymentOutput,
} from "@medusajs/framework/types";
import { stripeRefundEvidence } from "../../lib/stripe-refund-evidence";

/** Same provider identity and all inherited payment behavior. Never replay a
 * refund to discover its provider ID. Stripe metadata survives a local crash. */
export default class EvidenceStripeProvider extends StripeProvider {
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    if (!(this.options_ as any).recordRefundEvidence)
      return super.refundPayment(input);
    const { data, amount, context } = input;
    const nativeId = context?.idempotency_key;
    if (
      typeof nativeId !== "string" ||
      !/^ref_[a-zA-Z0-9_]{1,190}$/.test(nativeId) ||
      typeof data?.id !== "string" ||
      !/^pi_[a-zA-Z0-9_]+$/.test(data.id)
    )
      throw new Error("refund_evidence_requires_native_identity");
    const minor = getSmallestUnit(amount, String(data.currency));
    const receipt = await this.stripe_.refunds.create(
      {
        amount: minor,
        payment_intent: data.id,
        metadata: { gp_native_refund_id: nativeId },
      },
      { idempotencyKey: nativeId }
    );
    const evidence = stripeRefundEvidence(receipt);
    if (
      evidence.payment_intent_id !== data.id ||
      evidence.amount_minor !== minor ||
      evidence.currency_code !== String(data.currency).toLowerCase() ||
      evidence.native_refund_hint !== nativeId
    )
      throw new Error("refund_provider_response_mismatch");
    if (["failed", "canceled"].includes(String(receipt.status)))
      throw new Error("refund_provider_did_not_accept_refund");
    const previous = data.gp_refund_receipts;
    return {
      data: {
        ...data,
        gp_refund_receipts: {
          ...(previous &&
          typeof previous === "object" &&
          !Array.isArray(previous)
            ? previous
            : {}),
          [nativeId]: {
            id: receipt.id,
            native_refund_id: nativeId,
            amount: receipt.amount,
            currency: receipt.currency,
            status: receipt.status,
            created: receipt.created,
            payment_intent:
              typeof receipt.payment_intent === "string"
                ? receipt.payment_intent
                : receipt.payment_intent?.id,
          },
        },
      },
    };
  }
}
