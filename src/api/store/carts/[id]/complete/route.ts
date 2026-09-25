import { POST as nativeComplete } from "@medusajs/medusa/api/store/carts/[id]/complete/route";
import { requiresOrderReview } from "../../../../../lib/order-review-rollout";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  acceptCheckoutReview,
  assertReviewOwner,
  readReviewAcceptance,
  reviewCart,
  reviewErrorResponse,
} from "../../../../../lib/order-review-checkout";
import { completeReviewedCart } from "../../../../../lib/order-review-completion";
import { OrderPromiseError } from "../../../../../lib/order-promise";

/** Native payment/phone completion retains Medusa's workflow and response
 * envelope. Review identifiers are headers so SDK/native body validators stay
 * unchanged. Customer saved-card and invoice use the dedicated place route. */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    // Only the staff card-at-placement receipt is authorized to use this
    // public native route. place-order invokes completion internally after
    // its saved-card or institutional checks; clients cannot set this proof.
    if ((req as any).gp_staff_cart?.payment_mode !== "collect_card_now")
      throw new OrderPromiseError("checkout_place_order_required", 403);
    const cart = await reviewCart(req.scope, req.params.id);
    const identifiers = {
      review_id: req.headers["x-gp-order-review-id"],
      request_id: req.headers["x-gp-order-request-id"],
    };
    // Preserve native guest/payment response handling on an unreviewed legacy
    // cart; the existing staff, inventory, final-charge and native hooks run.
    if (!requiresOrderReview(cart, identifiers))
      return nativeComplete(req, res);
    const owner = await assertReviewOwner(req, cart);
    if (
      !owner.staff ||
      (req as any).gp_staff_cart?.payment_mode !== "collect_card_now"
    )
      throw new OrderPromiseError("order_review_payment_mode_unavailable", 403);
    const acceptance = readReviewAcceptance({
      review_id: req.headers["x-gp-order-review-id"],
      request_id: req.headers["x-gp-order-request-id"],
      analytics_consent: null,
    });
    await acceptCheckoutReview(
      req.scope,
      cart.id,
      owner.customerId,
      acceptance,
      "card_at_placement"
    );
    const { errors, result } = await completeReviewedCart(req.scope, cart.id);
    if (errors?.[0])
      return res.status(409).json({
        type: "cart",
        error: {
          message:
            "The order could not be completed. Review the order and payment status before retrying.",
        },
      });
    const { data } = await req.scope
      .resolve(ContainerRegistrationKeys.QUERY)
      .graph({
        entity: "order",
        fields: req.queryConfig.fields,
        filters: { id: result.id },
      });
    if (!data?.[0])
      throw new OrderPromiseError(
        "order_review_completion_recovery_required",
        503
      );
    return res.status(200).json({ type: "order", order: data[0] });
  } catch (error) {
    return reviewErrorResponse(res, error);
  }
};
