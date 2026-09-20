import { completeCartWorkflow } from "@medusajs/medusa/core-flows";
import { StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError } from "@medusajs/framework/utils";
import { validateShippingAcceptance } from "../../lib/shipping-acceptance";
import { ShippingInputError } from "../../lib/shipping-weights";

completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  try {
    await validateShippingAcceptance(container, cart);
  } catch (error) {
    if (error instanceof ShippingInputError)
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, error.message);
    throw error;
  }
  return new StepResponse();
});
