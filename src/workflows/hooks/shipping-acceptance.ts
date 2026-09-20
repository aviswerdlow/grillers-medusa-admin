import { ReceiptEmailError } from "../../lib/receipt-email";
import { validateReceiptSnapshot } from "../../lib/receipt-email-orders";
import { completeCartWorkflow } from "@medusajs/medusa/core-flows";
import { StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError } from "@medusajs/framework/utils";
import { validateShippingAcceptance } from "../../lib/shipping-acceptance";
import { ShippingInputError } from "../../lib/shipping-weights";
import { validateCalendarAcceptance } from "../../lib/fulfillment-calendar-runtime";
import { FulfillmentCalendarError } from "../../lib/fulfillment-calendar";
import { validateCheckoutReview } from "../../lib/order-review-checkout";
import { OrderPromiseError } from "../../lib/order-promise";

completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  try {
    await validateReceiptSnapshot(container, cart);
    await validateCalendarAcceptance(container, cart);
    await validateShippingAcceptance(container, cart);
    await validateCheckoutReview(container, cart);
  } catch (error) {
    if (
      error instanceof ShippingInputError ||
      error instanceof FulfillmentCalendarError ||
      error instanceof ReceiptEmailError
    )
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
    if (error instanceof OrderPromiseError)
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "The order details changed or the review expired. Review the current order before placing it."
      );
    throw error;
  }
  return new StepResponse();
});
