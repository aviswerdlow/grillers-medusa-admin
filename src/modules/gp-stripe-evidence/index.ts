import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import Stripe from "@medusajs/payment-stripe";
import NativeStripeProvider from "@medusajs/payment-stripe/dist/services/stripe-provider";
import EvidenceStripeProvider from "./service";

// Retain every existing provider and identifier, including native webhook URLs.
export default ModuleProvider(Modules.PAYMENT, {
  services: Stripe.services.map((service) =>
    service === NativeStripeProvider ? EvidenceStripeProvider : service
  ),
});
