import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  getReceiptEmailState,
  parseReceiptRequest,
  ReceiptEmailError,
  requestReceiptEmail,
  revokeReceiptEmail,
  verifyReceiptEmail,
} from "../../../../../lib/receipt-email";
import { sendTrackedEmail } from "../../../../../lib/communications/core";
import { buildReceiptEmailVerification } from "../../../../../lib/emails/templates/receipt-email-verification";

function actor(req: MedusaRequest) {
  const a = (req as any).auth_context;
  if (a?.actor_type !== "customer" || !a.actor_id)
    throw new ReceiptEmailError(401, "sign_in", "Please sign in again.");
  return a.actor_id as string;
}
function error(res: MedusaResponse, e: unknown) {
  if (e instanceof ReceiptEmailError)
    return res.status(e.status).json({ code: e.code, message: e.message });
  return res
    .status(503)
    .json({
      code: "receipt_email_unavailable",
      message: "Receipt settings are unavailable. Please try again.",
    });
}
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const id = actor(req);
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      receipt: await getReceiptEmailState(
        req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION),
        id
      ),
    });
  } catch (e) {
    return error(res, e);
  }
}
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const id = actor(req),
      input = parseReceiptRequest(req.body),
      db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    if (input.action === "request") {
      const { challenge } = await requestReceiptEmail(db, id, input);
      if (challenge) {
        let status = "failed";
        try {
          const result = await sendTrackedEmail(req.scope, {
            to: challenge.email,
            medusa_customer_id: id,
            stream: "transactional",
            purpose: "service",
            template_key: "receipt-email-verification",
            topic: "account",
            idempotency_key: `receipt-challenge:${challenge.id}`,
            ...buildReceiptEmailVerification(challenge.code),
            metadata: { challenge_id: challenge.id },
          });
          status = result.ok
            ? result.skipped
              ? "suppressed"
              : "sent"
            : "failed";
        } catch {
          /* No recipient/code/provider error in the public response. */
        }
        await db("gp_receipt_challenge")
          .where({ id: challenge.id })
          .update({ delivery_status: status, updated_at: new Date() });
      }
    } else if (input.action === "verify")
      await verifyReceiptEmail(db, id, input.challenge_id, input.code);
    else await revokeReceiptEmail(db, id, input);
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(input.action === "request" ? 202 : 200)
      .json({ receipt: await getReceiptEmailState(db, id) });
  } catch (e) {
    return error(res, e);
  }
}
