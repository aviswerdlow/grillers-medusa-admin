import type {
  CalendarPolicy,
  CalendarTransit,
} from "../../fulfillment-calendar";

// Synthetic operating policy for tests only. No value is a production default.
export function calendarPolicy(): CalendarPolicy {
  const windows = [
    { id: "afternoon", label: "Test afternoon", start: "13:00", end: "17:00" },
  ];
  const local = {
    preparationDays: 0,
    cutoffDays: 1,
    cutoffTime: "12:00",
    packTime: "10:00",
    windows,
  };
  return {
    revision: "synthetic-policy-1",
    approvedAt: "2026-08-01T00:00:00Z",
    approvalReference: "synthetic-fixture-only",
    validFrom: "2026-03-01",
    validThrough: "2026-12-31",
    timezone: "America/New_York",
    lookAheadDays: 30,
    quoteTtlSeconds: 600,
    operationsWeekdays: [1, 2, 3, 4, 5],
    operationsBlackouts: [],
    upsPickupBlackouts: [],
    upsDeliveryBlackouts: [],
    ups: {
      dispatchWeekdays: [1, 2, 3, 4],
      arrivalWeekdays: [1, 2, 3, 4],
      carrierWeekdays: [1, 2, 3, 4, 5],
      preparationDays: 0,
      cutoffTime: "15:00",
      packTime: "16:00",
      arrivalByTime: "18:00",
      maxElapsedHours: 96,
      allowNonDeliveryDayHold: false,
    },
    plant: {
      ...local,
      cutoffDays: 0,
      cutoffTime: "11:00",
      packTime: "12:00",
      weekdays: [1, 2, 3, 4, 5],
      additionalDates: [],
      blackoutDates: [],
      cutoffOverrides: [{ weekday: 5, time: "09:00" }],
    },
    atlanta: [
      { ...local, id: "synthetic-atlanta", zip: "30340", weekdays: [2, 3, 4] },
    ],
    southeast: [
      {
        ...local,
        id: "chattanooga",
        city: "Chattanooga",
        state: "TN",
        active: true,
        dates: ["2026-04-28"],
      },
      {
        ...local,
        id: "gainesville",
        city: "Gainesville",
        state: "FL",
        active: true,
        dates: [],
      },
      {
        ...local,
        id: "approved-route",
        city: "Synthetic future route",
        state: "SC",
        active: true,
        dates: ["2026-10-08"],
      },
    ],
  };
}
export function calendarTransit(
  now = new Date("2026-10-05T18:00:00Z"),
): CalendarTransit {
  return {
    businessDays: 1,
    source: "approved_fallback",
    revision: "synthetic-transit-1",
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    validFrom: "2026-03-01",
    validThrough: "2026-12-31",
    originPostalCode: "30340",
    destinationPostalCode: "10001",
    service: "GROUND",
  };
}
export function calendarCart(): any {
  return {
    id: "cart_synthetic",
    customer_id: "cus_synthetic",
    currency_code: "usd",
    region_id: "reg_synthetic",
    metadata: {},
    shipping_address: {
      country_code: "us",
      postal_code: "10001",
      province: "NY",
      city: "Synthetic",
      address_1: "1 Test",
    },
    items: [
      {
        id: "line_synthetic",
        variant_id: "variant_synthetic",
        quantity: 1,
        unit_price: 10,
      },
    ],
  };
}
