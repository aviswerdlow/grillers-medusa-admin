import {
  FulfillmentCalendarError,
  calendarHash,
  validCivilDate,
  type CalendarChoice,
  type CalendarTransit,
} from "./fulfillment-calendar";
import type {
  WwexQuoteResult,
  WwexRateInput,
} from "../modules/fulfillment/wwex-speedship";
import { normalizeGrillersUpsServiceCode } from "../modules/fulfillment/wwex-speedship";

const cache = new Map<string, { value: CalendarTransit; expires: number }>();
export function resetCalendarCarrierCache() {
  cache.clear();
}

/** A cache entry belongs to the exact dated, packed carrier request, not just
 * a ZIP prefix. Only quoteSmallpack is accepted; booking is never invoked. */
export async function carrierCalendarTransit(input: {
  request: WwexRateInput;
  choice: CalendarChoice;
  originPostalCode: string;
  quoteTtlSeconds: number;
  client: {
    quoteSmallpack: (request: WwexRateInput) => Promise<WwexQuoteResult>;
  };
  clock?: () => Date;
}): Promise<CalendarTransit | null> {
  const clock = input.clock ?? (() => new Date()),
    now = clock();
  const key = calendarHash({
    origin: input.originPostalCode,
    request: input.request,
  });
  const cached = cache.get(key);
  if (cached && cached.expires > now.getTime()) return cached.value;
  let result: WwexQuoteResult;
  try {
    result = await input.client.quoteSmallpack(input.request);
  } catch {
    return null;
  } // Caller may use its specifically approved fallback.
  const receivedAt = clock();
  const expires = Math.min(
    now.getTime() + input.quoteTtlSeconds * 1000,
    Date.parse(input.choice.cutoffAt),
  );
  // A slow response is not given a new full TTL and cannot reopen a cutoff.
  if (expires <= receivedAt.getTime())
    throw new FulfillmentCalendarError("late_carrier_response");
  const offer = result.offer;
  if (
    normalizeGrillersUpsServiceCode(offer.upsServiceCode) !==
    input.request.serviceCode
  )
    throw new FulfillmentCalendarError("carrier_service_mismatch", 503);
  if (offer.transitDays == null) return null;
  if (
    !Number.isInteger(offer.transitDays) ||
    offer.transitDays < 1 ||
    offer.transitDays > 14
  )
    throw new FulfillmentCalendarError("invalid_carrier_transit", 503);
  const arrival = offer.estimatedDeliveryDate;
  // The adapter accepts a date or ISO timestamp. Unrecognized provider text
  // never becomes a guessed promise.
  const isoArrival =
    typeof arrival === "string" &&
    (/^\d{4}-\d{2}-\d{2}$/.test(arrival) ||
      (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        arrival,
      ) &&
        Number.isFinite(Date.parse(arrival))))
      ? arrival.slice(0, 10)
      : null;
  if (arrival != null && !validCivilDate(isoArrival))
    throw new FulfillmentCalendarError("invalid_carrier_arrival", 503);
  const value: CalendarTransit = {
    businessDays: offer.transitDays,
    source: "carrier_cache",
    revision: `wwex:${calendarHash({
      key,
      offerId: offer.offerId,
      transaction: offer.productTransactionId,
      businessDays: offer.transitDays,
      arrival: isoArrival,
    })}`,
    fetchedAt: receivedAt.toISOString(),
    expiresAt: new Date(expires).toISOString(),
    validFrom: input.choice.dispatchDate,
    validThrough: isoArrival ?? input.choice.transit!.validThrough,
    originPostalCode: input.originPostalCode,
    destinationPostalCode: input.request.shippingAddress.postal_code!,
    service: input.request.serviceCode,
    dispatchDate: input.choice.dispatchDate,
    ...(isoArrival ? { estimatedArrivalDate: isoArrival } : {}),
  };
  for (const [id, entry] of cache)
    if (entry.expires <= receivedAt.getTime()) cache.delete(id);
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expires });
  return value;
}
