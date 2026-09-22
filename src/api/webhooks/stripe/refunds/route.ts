import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  rawStripeWebhookBody,
  stripeSignatureHeader,
  verifyStripeWebhookSignature,
} from "../../../../lib/stripe-webhook-signature";
import { refundConfiguration } from "../../../../lib/stripe-refund-evidence";
import { queueRefundNotification } from "../../../../lib/refund-provider";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = process.env.STRIPE_REFUND_WEBHOOK_SECRET;
  if (process.env.GP_REFUND_RECONCILIATION_ENABLED !== "true" || !secret)
    return res
      .status(503)
      .json({ ok: false, error: "refund_reconciliation_unavailable" });
  const rawBody = rawStripeWebhookBody(req);
  if (
    !verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: stripeSignatureHeader(req.headers),
      secret,
    }).ok
  )
    return res.status(400).json({ ok: false, error: "invalid_signature" });
  let event: any;
  try {
    event = JSON.parse(rawBody!);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  try {
    const { scope } = refundConfiguration(process.env);
    const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const result = await queueRefundNotification(db, scope, event);
    return res.status(200).json({ ok: true, result });
  } catch {
    // Retry until the durable queue/scope is available. Never acknowledge a lost event.
    return res
      .status(503)
      .json({ ok: false, error: "refund_evidence_not_recorded" });
  }
}
