import {
  CALENDAR_ACCEPTED_KEY,
  CALENDAR_SELECTION_KEY,
} from "./fulfillment-calendar";

/** A backend-first release retains legacy checkout until the coordinated
 * calendar rehearsal has passed. Unknown configured values fail closed. */
export function calendarEnforcementMode(env = process.env): "off" | "required" {
  const mode = env.GP_CALENDAR_ENFORCEMENT?.trim().toLowerCase();
  return !mode || mode === "off" ? "off" : "required";
}

/** Turning enforcement off must not silently reinterpret a dated cart as a
 * legacy cart. Existing selections still need their original validation. */
export function requiresFulfillmentCalendar(cart: any, env = process.env) {
  const metadata = cart?.metadata;
  return (
    calendarEnforcementMode(env) === "required" ||
    Boolean(
      metadata?.[CALENDAR_SELECTION_KEY] ||
        metadata?.[CALENDAR_ACCEPTED_KEY] ||
        metadata?.fulfillmentCalendarQuoteId
    )
  );
}

export function logLegacyCalendarCheckout(scope: any, cartId: string) {
  // A missing logger must not introduce a new completion failure. No customer
  // address, contact details, cart contents or signing material is logged.
  try {
    scope
      .resolve("logger")
      ?.warn?.(
        `[fulfillment-calendar] calendar_enforcement_off: legacy checkout ${cartId}`
      );
  } catch {
    // Logging is observational; payment/inventory guards remain authoritative.
  }
}
