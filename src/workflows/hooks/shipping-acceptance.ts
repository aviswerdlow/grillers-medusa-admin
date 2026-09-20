import { completeCartWorkflow } from "@medusajs/medusa/core-flows";
import { StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError } from "@medusajs/framework/utils";
import { validateShippingAcceptance } from "../../lib/shipping-acceptance";
import { ShippingInputError } from "../../lib/shipping-weights";
import { validateCalendarAcceptance } from "../../lib/fulfillment-calendar-runtime";
import { FulfillmentCalendarError } from "../../lib/fulfillment-calendar";

completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  try {
    await validateCalendarAcceptance(container, cart);
    await validateShippingAcceptance(container, cart);
  } catch (error) {
    if (
      error instanceof ShippingInputError ||
      error instanceof FulfillmentCalendarError
    )
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
    throw error;
  }
  return new StepResponse();
});
