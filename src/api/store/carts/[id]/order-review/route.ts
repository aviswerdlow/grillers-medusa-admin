import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import {
  acceptCheckoutReview,
  assertReviewOwner,
  issueCheckoutReview,
  reviewCart,
  reviewErrorResponse,
} from "../../../../../lib/order-review-checkout";
import { OrderPromiseError } from "../../../../../lib/order-promise";
import { completeReviewedCart } from "../../../../../lib/order-review-completion";

const bodySchema = z
  .object({
    action: z.enum(["review", "accept", "recover"]),
    payment_mode: z.enum(["card", "card_at_placement", "invoice"]),
    request_id: z.string().uuid(),
    review_id: z.string().min(1).max(100).optional(),
    analytics_consent: z.boolean().nullable(),
  })
  .strict();

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const body = bodySchema.safeParse(req.body);
    if (!body.success)
      throw new OrderPromiseError("order_review_invalid_request", 422);
    const cart = await reviewCart(req.scope, req.params.id);
    const owner = await assertReviewOwner(req, cart);
    if (owner.staff) body.data.analytics_consent = null;
    if (body.data.payment_mode === "card_at_placement" && !owner.staff)
      throw new OrderPromiseError("order_review_payment_mode_unavailable", 403);
    if (body.data.action === "review") {
      const review = await issueCheckoutReview(
        req.scope,
        cart.id,
        owner.customerId,
        body.data.payment_mode,
        body.data.analytics_consent,
        body.data.request_id
      );
      return res.status(200).json({ review });
    }
    if (!body.data.review_id)
      throw new OrderPromiseError("order_review_required", 422);
    if (body.data.action === "recover" && !cart.completed_at)
      throw new OrderPromiseError("order_review_no_completed_order", 409);
    await acceptCheckoutReview(
      req.scope,
      cart.id,
      owner.customerId,
      {
        reviewId: body.data.review_id,
        requestId: body.data.request_id,
        analyticsConsent: body.data.analytics_consent,
      },
      body.data.payment_mode
    );
    if (body.data.action === "recover") {
      const completion = await completeReviewedCart(req.scope, cart.id);
      if (completion.errors?.length)
        throw new OrderPromiseError(
          "order_review_completion_recovery_required",
          503
        );
      return res.status(200).json({ order_id: completion.result.id });
    }
    return res.status(200).json({ accepted: true });
  } catch (error) {
    return reviewErrorResponse(res, error);
  }
};
