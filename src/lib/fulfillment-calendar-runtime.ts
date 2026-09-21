import { Modules } from "@medusajs/framework/utils";
import { z } from "zod";
import {
  CALENDAR_SELECTION_KEY,
  CALENDAR_ACCEPTED_KEY,
  FulfillmentCalendarError,
  calendarHash,
  computeFulfillmentCalendar,
  type CalendarRequest,
  type CalendarResult,
} from "./fulfillment-calendar";
import {
  loadCalendarSource,
  approvedTransitFallback,
  type CalendarSource,
} from "./fulfillment-calendar-source";
import {
  acceptedCalendarMetadata,
  calendarCartRevision,
  calendarSigningKey,
  calendarSelectionMetadata,
  issueCalendarSelection,
  packingContextFromCalendar,
  readCalendarSelection,
  validateCalendarSelection,
  type CalendarSelection,
} from "./fulfillment-calendar-selection";
import {
  createWwexSpeedshipClientFromEnv,
  isUpsServiceCode,
  normalizeGrillersUpsServiceCode,
} from "../modules/fulfillment/wwex-speedship";
import { carrierCalendarTransit } from "./fulfillment-calendar-carrier";
import { getPackagingConfig } from "./packaging-cost-strapi";
import { loadShippingCatalogLines } from "./shipping-catalog-inputs";
import { createShippingPackingPlan } from "./shipping-packing-plan";
import { US_STATES } from "./gp-customer-create";
import {
  calendarEnforcementMode,
  logLegacyCalendarCheckout,
  requiresFulfillmentCalendar,
} from "./fulfillment-calendar-rollout";

const fields = [
  "id",
  "completed_at",
  "customer_id",
  "email",
  "currency_code",
  "region_id",
  "metadata",
  "shipping_address.*",
  "items.*",
  "shipping_methods.*",
];
export const calendarActionSchema = z
  .object({
    action: z.enum(["list", "select", "validate"]),
    cart_id: z
      .string()
      .regex(/^cart_[\w-]+$/)
      .max(160),
    shipping_option_id: z.string().min(1).max(160).optional(),
    route_id: z.string().min(1).max(160).optional(),
    arrival_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    window_id: z.string().max(160).optional(),
    context_revision: z.string().min(1).max(160).optional(),
    replacement_quote: z.string().max(16000).optional(),
  })
  .strict();

export function modeForCalendarService(
  service: string
): CalendarRequest["mode"] {
  if (isUpsServiceCode(service)) return "ups_shipping";
  if (service === "PICKUP") return "plant_pickup";
  if (service === "ATLANTA_DELIVERY") return "atlanta_delivery";
  if (service === "SCHEDULED_DELIVERY") return "southeast_pickup";
  throw new FulfillmentCalendarError("calendar_service_unknown");
}
async function readCalendarCart(scope: any, cartId: string) {
  const query = scope.resolve("query");
  const { data } = await query.graph({
    entity: "cart",
    fields,
    filters: { id: cartId },
  });
  const cart = data?.[0];
  if (!cart) throw new FulfillmentCalendarError("calendar_cart_not_found");
  return { cart, query };
}
async function context(
  scope: any,
  cartId: string,
  shippingOptionId?: string,
  routeId?: string,
  loaded?: { cart: any; query: any }
) {
  const { cart, query } = loaded ?? (await readCalendarCart(scope, cartId));
  if (cart.completed_at) return { cart, query, completed: true as const };
  const selectedId =
    shippingOptionId ??
    (cart.shipping_methods?.length === 1
      ? cart.shipping_methods[0].shipping_option_id
      : null);
  if (!selectedId)
    throw new FulfillmentCalendarError("calendar_shipping_option_required");
  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "data"],
    filters: { id: selectedId },
  });
  if (options?.length !== 1 || options[0].id !== selectedId)
    throw new FulfillmentCalendarError("calendar_shipping_option_unknown");
  const service = normalizeGrillersUpsServiceCode(
    options[0].data?.service_code
  );
  const mode = modeForCalendarService(service);
  const rawZip = String(cart.shipping_address?.postal_code ?? "").trim();
  const postalCode = /^\d{5}(?:-\d{4})?$/.test(rawZip)
    ? rawZip.slice(0, 5)
    : "";
  if (mode !== "plant_pickup" && mode !== "southeast_pickup" && !postalCode)
    throw new FulfillmentCalendarError("calendar_address_required");
  const countryCode = String(cart.shipping_address?.country_code ?? "")
    .trim()
    .toLowerCase();
  if (mode !== "plant_pickup" && countryCode !== "us")
    throw new FulfillmentCalendarError("calendar_destination_unavailable");
  const rawState = String(cart.shipping_address?.province ?? "")
    .trim()
    .toLowerCase()
    .replace(/^us-/, "");
  const province = US_STATES.find(
    (state) =>
      state.code.toLowerCase() === rawState ||
      state.name.toLowerCase() === rawState
  )?.code;
  if (mode === "southeast_pickup" && !province)
    throw new FulfillmentCalendarError("calendar_address_required");
  const request: CalendarRequest = {
    mode,
    service,
    postalCode,
    ...(mode === "southeast_pickup"
      ? {
          routeId: routeId ?? cart.metadata?.pickupLocationId,
          countryCode,
          province,
        }
      : {}),
  };
  return {
    cart,
    query,
    completed: false as const,
    shippingOptionId: selectedId,
    request,
  };
}
function calendarFor(
  source: CalendarSource,
  request: CalendarRequest,
  now: Date,
  carrierSelection?: CalendarSelection
) {
  if (request.mode === "southeast_pickup") {
    const route = source.policy.southeast.find(
      (r) => r.id === request.routeId && r.active
    );
    if (
      request.countryCode !== "us" ||
      !request.province ||
      (route && route.state !== request.province)
    )
      throw new FulfillmentCalendarError("calendar_destination_unavailable");
  }
  const transit =
    request.mode === "ups_shipping"
      ? carrierSelection?.choice.transit?.source === "carrier_cache"
        ? carrierSelection.choice.transit
        : approvedTransitFallback({
            rules: source.transitRules,
            service: request.service,
            postalCode: request.postalCode,
            originPostalCode: source.originPostalCode,
            now,
          })
      : null;
  return computeFulfillmentCalendar({
    policy: source.policy,
    request,
    now,
    transit,
  });
}
const contextRevision = (cart: any, option: string, calendar: CalendarResult) =>
  calendarHash({
    cart: calendarCartRevision(cart),
    option,
    request: calendar.request,
    revision: calendar.calendarRevision,
    transitRevisions: [
      ...new Set(
        calendar.choices.map((choice) => choice.transit?.revision ?? null)
      ),
    ].sort(),
  });

export async function fulfillmentCalendarAction(
  scope: any,
  raw: unknown,
  env = process.env,
  clock = () => new Date()
) {
  const input = calendarActionSchema.safeParse(raw);
  if (!input.success)
    throw new FulfillmentCalendarError("invalid_calendar_request", 400);
  const body = input.data;
  if (body.action === "validate") {
    const accepted = await currentCalendarSelection(
      scope,
      body.cart_id,
      env,
      clock
    );
    return {
      state:
        !accepted && calendarEnforcementMode(env) === "off"
          ? "legacy"
          : "valid",
      summary: accepted?.selection.choice ?? null,
    };
  }
  const loaded = await readCalendarCart(scope, body.cart_id);
  if (
    !loaded.cart.completed_at &&
    !requiresFulfillmentCalendar(loaded.cart, env)
  )
    throw new FulfillmentCalendarError("calendar_not_enabled", 503);
  const c = await context(
    scope,
    body.cart_id,
    body.shipping_option_id,
    body.route_id,
    loaded
  );
  if (c.completed)
    throw new FulfillmentCalendarError("calendar_order_already_accepted");
  let now = clock();
  const source = await loadCalendarSource(env, now);
  // Use the completion of source reads as the current clock for cutoffs.
  now = clock();
  const key = calendarSigningKey(env);
  let replacement: CalendarSelection | undefined;
  if (body.replacement_quote) {
    replacement = readCalendarSelection(body.replacement_quote, key, now);
    if (
      replacement.cartId !== c.cart.id ||
      replacement.cartRevision !== calendarCartRevision(c.cart) ||
      replacement.shippingOptionId !== c.shippingOptionId ||
      calendarHash(replacement.request) !== calendarHash(c.request)
    )
      throw new FulfillmentCalendarError("calendar_context_changed");
  }
  let calendar = calendarFor(source, c.request, now, replacement);
  if (replacement && replacement.calendarRevision !== calendar.calendarRevision)
    throw new FulfillmentCalendarError("calendar_context_changed");
  let revision = contextRevision(c.cart, c.shippingOptionId, calendar);
  if (body.action === "list")
    return {
      state: "available",
      calendar,
      contextRevision: revision,
      regionalLocations:
        c.request.mode === "southeast_pickup"
          ? source.policy.southeast
              .filter(
                (route) => route.active && route.state === c.request.province
              )
              .map(({ id, city, state }) => ({ id, city, state }))
          : [],
    };
  if (!body.arrival_date || body.context_revision !== revision)
    throw new FulfillmentCalendarError("calendar_context_changed");
  let choice = calendar.choices.find(
    (x) =>
      x.arrivalDate === body.arrival_date &&
      (x.window?.id ?? "") === (body.window_id ?? "")
  );
  if (!choice) throw new FulfillmentCalendarError("date_or_window_unavailable");

  if (c.request.mode === "ups_shipping" && !replacement) {
    const client = createWwexSpeedshipClientFromEnv(env);
    if (client) {
      const origin =
        env.WWEX_ORIGIN_POSTAL_CODE || env.GRILLERS_SHIP_FROM_POSTAL_CODE;
      if (origin !== source.originPostalCode)
        throw new FulfillmentCalendarError(
          "calendar_carrier_origin_mismatch",
          503
        );
      const lines = await loadShippingCatalogLines(c.query, c.cart.items);
      const plan = createShippingPackingPlan(
        lines,
        packingContextFromCalendar({ request: c.request, choice }),
        await getPackagingConfig(env)
      );
      const transit = await carrierCalendarTransit({
        client,
        originPostalCode: source.originPostalCode,
        choice,
        quoteTtlSeconds: source.policy.quoteTtlSeconds,
        clock,
        request: {
          serviceCode: c.request.service,
          shippingAddress: {
            ...c.cart.shipping_address,
            postal_code: c.request.postalCode,
          },
          estimatedPackingPlan: plan,
          shipmentDate: choice.dispatchDate,
          residentialDelivery: true,
        },
      });
      now = clock();
      // Even a failed/empty carrier response cannot use an expired fallback.
      calendar = computeFulfillmentCalendar({
        policy: source.policy,
        request: c.request,
        now,
        transit: transit ?? choice.transit,
      });
      revision = contextRevision(c.cart, c.shippingOptionId, calendar);
      const exact = calendar.choices.find(
        (x) =>
          x.arrivalDate === body.arrival_date &&
          x.dispatchDate === choice!.dispatchDate
      );
      if (!exact) {
        const proposed = calendar.choices[0];
        if (!proposed)
          throw new FulfillmentCalendarError("carrier_date_unavailable");
        const issued = issueCalendarSelection({
          cart: c.cart,
          shippingOptionId: c.shippingOptionId,
          calendar,
          arrivalDate: proposed.arrivalDate,
          key,
          now,
        });
        // This does not mutate the cart or silently accept a changed date. The
        // customer must explicitly choose the replacement on a subsequent call.
        return {
          state: "changed",
          calendar,
          contextRevision: revision,
          replacementQuote: issued.token,
          message:
            "The carrier returned a different arrival estimate. Please choose the updated date to continue.",
        };
      }
      choice = exact;
    }
  }
  const issued = issueCalendarSelection({
    cart: c.cart,
    shippingOptionId: c.shippingOptionId,
    calendar,
    arrivalDate: choice.arrivalDate,
    windowId: body.window_id,
    key,
    now: clock(),
  });
  return {
    state: "selected",
    summary: issued.selection.choice,
    metadata: calendarSelectionMetadata(issued.token, issued.selection),
    calendar,
    contextRevision: revision,
  };
}

export async function currentCalendarSelection(
  scope: any,
  cartId: string,
  env = process.env,
  clock = () => new Date()
) {
  const loaded = await readCalendarCart(scope, cartId);
  if (loaded.cart.completed_at) return null;
  if (!requiresFulfillmentCalendar(loaded.cart, env)) {
    logLegacyCalendarCheckout(scope, cartId);
    return null;
  }
  const c = await context(scope, cartId, undefined, undefined, loaded);
  if (c.completed) return null;
  const source = await loadCalendarSource(env, clock()),
    now = clock(),
    key = calendarSigningKey(env);
  const token = readCalendarSelection(
    c.cart.metadata?.[CALENDAR_SELECTION_KEY],
    key,
    now
  );
  const calendar = calendarFor(source, c.request, now, token);
  const selection = validateCalendarSelection({
    cart: c.cart,
    shippingOptionId: c.shippingOptionId,
    calendar,
    key,
    now,
  });
  if (
    c.cart.metadata?.fulfillmentType !== selection.request.mode ||
    c.cart.metadata?.requestedDeliveryDate !== selection.choice.arrivalDate ||
    c.cart.metadata?.scheduledDate !== selection.choice.arrivalDate ||
    (c.cart.metadata?.scheduledTimeWindow ?? "") !==
      (selection.choice.window?.id ?? "")
  )
    throw new FulfillmentCalendarError("calendar_metadata_changed");
  return { ...c, selection, now };
}
export async function prepareCalendarAcceptance(scope: any, cartId: string) {
  const c = await currentCalendarSelection(scope, cartId);
  if (!c) return;
  await scope.resolve(Modules.CART).updateCarts(cartId, {
    metadata: acceptedCalendarMetadata(c.cart, c.selection, c.now),
  });
}
export async function validateCalendarAcceptance(scope: any, loadedCart: any) {
  const c = await currentCalendarSelection(scope, loadedCart.id);
  if (!c) {
    if (!loadedCart.completed_at && requiresFulfillmentCalendar(loadedCart)) {
      const fresh = await readCalendarCart(scope, loadedCart.id);
      if (!fresh.cart.completed_at)
        throw new FulfillmentCalendarError("calendar_acceptance_changed");
    }
    return;
  }
  const accepted = loadedCart.metadata?.[CALENDAR_ACCEPTED_KEY];
  if (
    calendarCartRevision(loadedCart) !== c.selection.cartRevision ||
    calendarHash(loadedCart.metadata?.[CALENDAR_SELECTION_KEY]) !==
      calendarHash(c.cart.metadata?.[CALENDAR_SELECTION_KEY]) ||
    !accepted ||
    !Number.isFinite(Date.parse(accepted.acceptedAt)) ||
    calendarHash({ ...accepted, acceptedAt: null }) !==
      calendarHash({ ...c.selection, acceptedAt: null }) ||
    loadedCart.metadata?.qbdDueDate !== c.selection.choice.dispatchDate ||
    loadedCart.metadata?.fulfillmentDispatchDate !==
      c.selection.choice.dispatchDate ||
    loadedCart.metadata?.fulfillmentWindowLabel !==
      (c.selection.choice.window?.label ?? "") ||
    loadedCart.metadata?.fulfillmentCalendarTimezone !== "America/New_York" ||
    loadedCart.metadata?.fulfillmentPickDate !== c.selection.choice.pickDate
  )
    throw new FulfillmentCalendarError("calendar_acceptance_changed");
}

/** Rates can preview the earliest available date while a customer is choosing.
 * Only a valid signed selection can pass completion; a preview is never an
 * accepted promise. Read current cart data instead of caller method metadata. */
export async function calendarPackingContextForRate(
  query: any,
  cartId: unknown,
  service: string,
  env = process.env,
  clock = () => new Date()
) {
  if (typeof cartId !== "string" || !cartId.startsWith("cart_"))
    throw new FulfillmentCalendarError("calendar_cart_required");
  const { data } = await query.graph({
    entity: "cart",
    fields,
    filters: { id: cartId },
  });
  const cart = data?.[0];
  if (!cart || cart.completed_at)
    throw new FulfillmentCalendarError("calendar_cart_unavailable");
  const source = await loadCalendarSource(env, clock()),
    now = clock(),
    key = calendarSigningKey(env);
  const rawZip = String(cart.shipping_address?.postal_code ?? "").trim();
  if (
    !/^\d{5}(?:-\d{4})?$/.test(rawZip) ||
    String(cart.shipping_address?.country_code).toLowerCase() !== "us"
  )
    throw new FulfillmentCalendarError("calendar_destination_unavailable");
  const request: CalendarRequest = {
    mode: "ups_shipping",
    service,
    postalCode: rawZip.slice(0, 5),
  };
  let token: CalendarSelection | undefined;
  try {
    const value = readCalendarSelection(
      cart.metadata?.[CALENDAR_SELECTION_KEY],
      key,
      now
    );
    if (
      value.cartId === cart.id &&
      value.cartRevision === calendarCartRevision(cart) &&
      calendarHash(value.request) === calendarHash(request)
    )
      token = value;
  } catch (error) {
    if (!(error instanceof FulfillmentCalendarError)) throw error;
  }
  const calendar = calendarFor(source, request, now, token);
  if (token && token.calendarRevision === calendar.calendarRevision) {
    const accepted = validateCalendarSelection({
      cart,
      shippingOptionId: token.shippingOptionId,
      calendar,
      key,
      now,
    });
    return packingContextFromCalendar(accepted);
  }
  const preview = calendar.choices[0];
  if (!preview)
    throw new FulfillmentCalendarError("no_available_calendar_dates");
  return packingContextFromCalendar({ request, choice: preview });
}
