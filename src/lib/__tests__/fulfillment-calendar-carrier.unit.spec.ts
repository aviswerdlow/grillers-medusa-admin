import {
  carrierCalendarTransit,
  resetCalendarCarrierCache,
} from "../fulfillment-calendar-carrier";
import { computeFulfillmentCalendar } from "../fulfillment-calendar";
import {
  calendarPolicy,
  calendarTransit,
} from "./__fixtures__/fulfillment-calendar";
const now = new Date("2026-10-05T18:00:00Z");
function args() {
  const choice = computeFulfillmentCalendar({
    policy: calendarPolicy(),
    request: { mode: "ups_shipping", service: "GROUND", postalCode: "10001" },
    now,
    transit: calendarTransit(now),
  }).choices[0];
  const client = {
    quoteSmallpack: jest.fn(async () => ({
      offer: {
        offerId: "fixture",
        productTransactionId: "fixture",
        upsServiceCode: "GND",
        transitDays: 1,
        estimatedDeliveryDate: "2026-10-06",
        price: { value: 10, currency: "USD" },
        raw: {},
      },
      offers: [],
      request: {},
      response: {},
    })),
  };
  return {
    choice,
    client,
    originPostalCode: "30340",
    quoteTtlSeconds: 600,
    clock: () => now,
    request: {
      serviceCode: "GROUND",
      shippingAddress: { postal_code: "10001" },
      shipmentDate: "2026-10-05",
    },
  };
}
beforeEach(resetCalendarCarrierCache);
test("carrier cache binds origin, destination, service, dispatch and package request", async () => {
  const a = args();
  const first = await carrierCalendarTransit(a);
  expect(first).toMatchObject({
    source: "carrier_cache",
    dispatchDate: "2026-10-05",
    estimatedArrivalDate: "2026-10-06",
    businessDays: 1,
  });
  expect(await carrierCalendarTransit(a)).toEqual(first);
  expect(a.client.quoteSmallpack).toHaveBeenCalledTimes(1);
  await carrierCalendarTransit({
    ...a,
    request: { ...a.request, shipmentDate: "2026-10-06" },
  });
  expect(a.client.quoteSmallpack).toHaveBeenCalledTimes(2);
});
test("late responses, unknown date formats and mismatched services do not revive an old quote", async () => {
  const a = args();
  let calls = 0;
  await expect(
    carrierCalendarTransit({
      ...a,
      clock: () => (++calls === 1 ? now : new Date("2026-10-05T18:10:00Z")),
    }),
  ).rejects.toMatchObject({ code: "late_carrier_response" });
  a.client.quoteSmallpack.mockResolvedValueOnce({
    offer: { upsServiceCode: "1DA", transitDays: 1 },
    offers: [],
  } as any);
  await expect(carrierCalendarTransit(a)).rejects.toMatchObject({
    code: "carrier_service_mismatch",
  });
  a.client.quoteSmallpack.mockResolvedValueOnce({
    offer: {
      upsServiceCode: "GND",
      transitDays: 1,
      estimatedDeliveryDate: "maybe Tuesday",
    },
    offers: [],
  } as any);
  await expect(carrierCalendarTransit(a)).rejects.toMatchObject({
    code: "invalid_carrier_arrival",
  });
});
test("unavailable provider returns no transit; it never manufactures a five-day default", async () => {
  const a = args();
  a.client.quoteSmallpack.mockRejectedValueOnce(
    new Error("provider unavailable"),
  );
  expect(await carrierCalendarTransit(a)).toBeNull();
});
