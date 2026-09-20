import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { fulfillmentCalendarAction } from "../../../../../lib/fulfillment-calendar-runtime";
import { FulfillmentCalendarError } from "../../../../../lib/fulfillment-calendar";
import { ShippingInputError } from "../../../../../lib/shipping-weights";

/** Cart identifiers use the same guest capability boundary as native Store
 * carts. This endpoint only reads/quotes; cart mutations retain their native
 * customer/staff middleware and the completion guard revalidates the token. */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  try {
    return res.json(await fulfillmentCalendarAction(req.scope, req.body));
  } catch (error) {
    if (error instanceof FulfillmentCalendarError)
      return res
        .status(error.status)
        .json({
          type: "fulfillment_date_review_required",
          message: error.message,
        });
    if (error instanceof ShippingInputError)
      return res
        .status(409)
        .json({ type: "shipping_review_required", message: error.message });
    throw error;
  }
}
