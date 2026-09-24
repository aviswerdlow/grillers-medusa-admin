import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CALENDAR_SELECTION_KEY,
  CALENDAR_ACCEPTED_KEY,
  FulfillmentCalendarError,
  calendarHash,
  validCivilDate,
  type CalendarChoice,
  type CalendarRequest,
  type CalendarResult,
} from "./fulfillment-calendar";

export type CalendarSelection = {
  version: 1;
  quoteId: string;
  cartId: string;
  cartRevision: string;
  shippingOptionId: string;
  request: CalendarRequest;
  calendarRevision: string;
  issuedAt: string;
  expiresAt: string;
  choice: CalendarChoice;
};

export function calendarSigningKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.GRILLERS_CALENDAR_SIGNING_KEY;
  if (!key || Buffer.byteLength(key) < 32)
    throw new FulfillmentCalendarError("calendar_signer_unconfigured", 503);
  return key;
}
export function calendarCartRevision(cart: any): string {
  if (!cart?.id || !Array.isArray(cart.items) || !cart.items.length)
    throw new FulfillmentCalendarError("cart_has_no_items");
  const items = cart.items
    .map((line: any) => {
      const quantity = Number(line.quantity),
        price = Number(line.unit_price);
      if (
        !line.id ||
        !line.variant_id ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(price) ||
        price < 0
      )
        throw new FulfillmentCalendarError("invalid_calendar_cart_line");
      return { id: line.id, variantId: line.variant_id, quantity, price };
    })
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
  const a = cart.shipping_address || {};
  const address = Object.fromEntries(
    [
      "country_code",
      "postal_code",
      "province",
      "city",
      "address_1",
      "address_2",
      "company",
    ].map((key) => [
      key,
      String(a[key] ?? "")
        .trim()
        .toLowerCase(),
    ]),
  );
  return calendarHash({
    cartId: cart.id,
    customerId: cart.customer_id ?? null,
    email: cart.email ?? null,
    currency: cart.currency_code,
    region: cart.region_id,
    address,
    items,
  });
}
const signature = (payload: string, key: string) =>
  createHmac("sha256", key)
    .update("gp-fulfillment-calendar-v1\0" + payload)
    .digest();

export function issueCalendarSelection(input: {
  cart: any;
  shippingOptionId: string;
  calendar: CalendarResult;
  arrivalDate: string;
  windowId?: string;
  key: string;
  now: Date;
}): { token: string; selection: CalendarSelection } {
  if (Buffer.byteLength(input.key) < 32)
    throw new FulfillmentCalendarError("calendar_signer_unconfigured", 503);
  const choice = input.calendar.choices.find(
    (c) =>
      c.arrivalDate === input.arrivalDate &&
      (c.window?.id ?? "") === (input.windowId ?? ""),
  );
  if (!choice) throw new FulfillmentCalendarError("date_or_window_unavailable");
  const expires = Math.min(
    Date.parse(input.calendar.expiresAt),
    Date.parse(choice.cutoffAt),
  );
  if (expires <= input.now.getTime())
    throw new FulfillmentCalendarError("calendar_quote_expired");
  const selection: CalendarSelection = {
    version: 1,
    quoteId: randomUUID(),
    cartId: input.cart.id,
    cartRevision: calendarCartRevision(input.cart),
    shippingOptionId: input.shippingOptionId,
    request: input.calendar.request,
    calendarRevision: input.calendar.calendarRevision,
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(expires).toISOString(),
    choice,
  };
  const payload = Buffer.from(JSON.stringify(selection)).toString("base64url");
  return {
    selection,
    token: `${payload}.${signature(payload, input.key).toString("base64url")}`,
  };
}

export function readCalendarSelection(
  token: unknown,
  key: string,
  now: Date,
): CalendarSelection {
  if (typeof token !== "string" || token.length > 16000)
    throw new FulfillmentCalendarError("calendar_selection_required");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)))
    throw new FulfillmentCalendarError("invalid_calendar_signature");
  const digest = Buffer.from(parts[1], "base64url"),
    expected = signature(parts[0], key);
  if (digest.length !== expected.length || !timingSafeEqual(digest, expected))
    throw new FulfillmentCalendarError("invalid_calendar_signature");
  let selection: CalendarSelection;
  try {
    selection = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new FulfillmentCalendarError("invalid_calendar_selection");
  }
  if (
    selection?.version !== 1 ||
    !selection.quoteId ||
    !selection.cartId ||
    !selection.shippingOptionId ||
    !selection.choice ||
    !validCivilDate(selection.choice.arrivalDate) ||
    !Number.isFinite(Date.parse(selection.issuedAt)) ||
    Date.parse(selection.issuedAt) > now.getTime() ||
    !Number.isFinite(Date.parse(selection.expiresAt)) ||
    Date.parse(selection.expiresAt) <= now.getTime()
  )
    throw new FulfillmentCalendarError("calendar_quote_expired");
  return selection;
}

/** Compare the promise, not cache fetch timestamps. Fresh policy/transit
 * checks still run separately, including expiry and source revision. */
export function calendarChoiceIdentity(choice: CalendarChoice) {
  return calendarHash({
    ...choice,
    transit: choice.transit
      ? { ...choice.transit, fetchedAt: null, expiresAt: null }
      : null,
  });
}
export function validateCalendarSelection(input: {
  cart: any;
  shippingOptionId: string;
  calendar: CalendarResult;
  key: string;
  now: Date;
}): CalendarSelection {
  const selected = readCalendarSelection(
    input.cart.metadata?.[CALENDAR_SELECTION_KEY],
    input.key,
    input.now,
  );
  if (
    selected.cartId !== input.cart.id ||
    selected.cartRevision !== calendarCartRevision(input.cart) ||
    selected.shippingOptionId !== input.shippingOptionId ||
    selected.calendarRevision !== input.calendar.calendarRevision ||
    calendarHash(selected.request) !== calendarHash(input.calendar.request)
  )
    throw new FulfillmentCalendarError("calendar_context_changed");
  const current = input.calendar.choices.find(
    (c) =>
      calendarChoiceIdentity(c) === calendarChoiceIdentity(selected.choice),
  );
  if (!current || Date.parse(current.cutoffAt) <= input.now.getTime())
    throw new FulfillmentCalendarError(
      "calendar_selection_no_longer_available",
    );
  return selected;
}

export function calendarSelectionMetadata(
  token: string,
  selection: CalendarSelection,
) {
  const c = selection.choice;
  return {
    [CALENDAR_SELECTION_KEY]: token,
    fulfillmentType: selection.request.mode,
    fulfillmentZip: selection.request.postalCode,
    requestedDeliveryDate: c.arrivalDate,
    scheduledDate: c.arrivalDate,
    scheduledTimeWindow: c.window?.id ?? "",
    pickupLocationId: selection.request.routeId ?? "",
    qbdDueDate: c.dispatchDate,
    fulfillmentDispatchDate: c.dispatchDate,
    fulfillmentPickDate: c.pickDate,
    fulfillmentWindowLabel: c.window?.label ?? "",
    fulfillmentCalendarTimezone: "America/New_York",
    fulfillmentCalendarQuoteId: selection.quoteId,
  };
}
export function acceptedCalendarMetadata(
  cart: any,
  selection: CalendarSelection,
  now: Date,
) {
  return {
    ...cart.metadata,
    ...calendarSelectionMetadata(
      cart.metadata[CALENDAR_SELECTION_KEY],
      selection,
    ),
    [CALENDAR_ACCEPTED_KEY]: { ...selection, acceptedAt: now.toISOString() },
  };
}
export function packingContextFromCalendar(
  selection: Pick<CalendarSelection, "request" | "choice">,
) {
  const c = selection.choice;
  if (selection.request.mode !== "ups_shipping" || !c.transit)
    throw new FulfillmentCalendarError("carrier_calendar_required");
  return {
    service: selection.request.service,
    postalCode: selection.request.postalCode,
    dispatchDate: c.dispatchDate,
    arrivalDate: c.arrivalDate,
    validatedTransit: {
      packedAt: c.packedAt,
      arrivalBy: c.arrivalBy,
      days: c.transitBusinessDays,
      packingDays: c.packingDays,
      elapsedHours: c.elapsedPackingHours,
      revision: c.transit.revision,
    },
  };
}
