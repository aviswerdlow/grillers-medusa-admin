import {
  calendarPolicyFromStrapi,
  approvedTransitFallback,
  loadCalendarSource,
} from "../fulfillment-calendar-source";
import { computeFulfillmentCalendar } from "../fulfillment-calendar";

const now = new Date("2026-10-05T18:00:00Z");
// Explicit test-only policy: no fixture is a production operating default.
const window = {
  Key: "test-window",
  Label: "Test window",
  StartTime: "13:00",
  EndTime: "17:00",
};
const local = {
  CalendarPreparationDays: 0,
  CalendarCutoffDays: 1,
  CalendarCutoffTime: "12:00",
  CalendarPackTime: "10:00",
  CalendarWindows: [window],
};
const rule = {
  Service: "GROUND",
  OriginPostalCode: "30340",
  DestinationZipPrefix: "10",
  BusinessDays: 2,
  Revision: "test-transit",
  ApprovedAt: "2026-08-01T00:00:00Z",
  ApprovalReference: "test-only",
  ValidFrom: "2026-10-01",
  ValidThrough: "2026-10-31",
};
const checkout = () => ({
  PlantPickupAvailableDays: ["Monday", "Friday"],
  PlantPickupAdditionalDates: [{ Date: "2026-10-07" }],
  PlantPickupBlackoutDates: [{ Date: "2026-10-09" }],
  ShippingBlackoutDates: [{ BlackoutDate: "2026-10-12" }],
  FulfillmentBlackoutDates: [
    { Date: "2026-10-14", BlocksOperations: true },
    { Date: "2026-10-15", BlocksUPSPickup: true },
    { Date: "2026-10-16", BlocksUPSDelivery: true },
  ],
  FulfillmentTransitRules: [rule],
  FulfillmentCalendarPolicy: {
    ...local,
    Revision: "test-policy",
    ApprovalReference: "test-only",
    ApprovedAt: "2026-08-01T00:00:00Z",
    ValidFrom: "2026-10-01",
    ValidThrough: "2026-10-31",
    Timezone: "America/New_York",
    OriginPostalCode: "30340",
    LookAheadDays: 30,
    QuoteTtlSeconds: 600,
    OperationsWeekdays: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
    ],
    UPSDispatchWeekdays: ["Monday", "Tuesday", "Wednesday", "Thursday"],
    UPSArrivalWeekdays: ["Tuesday", "Wednesday", "Thursday"],
    UPSCarrierWeekdays: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
    ],
    UPSPreparationDays: 0,
    UPSOrderCutoffTime: "15:00",
    UPSPackTime: "16:00",
    UPSArrivalByTime: "18:00",
    UPSMaxElapsedHours: 96,
    UPSAllowNonDeliveryDayHold: false,
    PlantWindows: [window],
    PlantCutoffOverrides: [{ Weekday: "Friday", CutoffTime: "09:00" }],
  },
});
const route = {
  ...local,
  id: 7,
  documentId: "test-route",
  City: "Synthetic",
  State: "SC",
  IsActive: true,
  AvailableDates: [{ Date: "2026-10-08" }],
};
const zone = {
  ...local,
  documentId: "test-zone",
  ZipCode: "30340",
  IsActive: true,
  Weekdays: ["Thursday"],
};

test("adapts existing published closures, route identity and windows without conflating modes", () => {
  const p = calendarPolicyFromStrapi(
    checkout(),
    [zone],
    [route, { IsActive: false }],
    now,
  );
  expect(p.operationsBlackouts).toEqual(["2026-10-14"]);
  expect(p.upsPickupBlackouts).toEqual(["2026-10-12", "2026-10-15"]);
  expect(p.upsDeliveryBlackouts).toEqual(["2026-10-12", "2026-10-16"]);
  expect(p.plant.cutoffOverrides).toEqual([{ weekday: 5, time: "09:00" }]);
  const calendar = computeFulfillmentCalendar({
    policy: p,
    now,
    request: {
      mode: "southeast_pickup",
      service: "SCHEDULED_DELIVERY",
      postalCode: "",
      routeId: "test-route",
    },
  });
  expect(calendar.choices).toEqual([
    expect.objectContaining({
      arrivalDate: "2026-10-08",
      window: {
        id: "test-window",
        label: "Test window",
        start: "13:00",
        end: "17:00",
      },
    }),
  ]);
});
test("never treats legacy dates, an incomplete active route or an absent approval as a full policy", () => {
  expect(() =>
    calendarPolicyFromStrapi(
      { PlantPickupAvailableDays: ["Monday"] },
      [],
      [],
      now,
    ),
  ).toThrow();
  expect(() =>
    calendarPolicyFromStrapi(
      checkout(),
      [],
      [{ ...route, CalendarWindows: [] }],
      now,
    ),
  ).toThrow();
  const c = checkout();
  c.FulfillmentCalendarPolicy.ApprovalReference = "";
  expect(() => calendarPolicyFromStrapi(c, [], [], now)).toThrow();
});
test("fallback uses the most specific approved origin, service and destination rule and rejects ambiguity", () => {
  const input = {
    rules: [rule, { ...rule, DestinationZipPrefix: "10001", BusinessDays: 1 }],
    now,
    service: "GROUND",
    postalCode: "10001",
    originPostalCode: "30340",
  };
  expect(approvedTransitFallback(input)?.businessDays).toBe(1);
  expect(
    approvedTransitFallback({ ...input, originPostalCode: "99999" }),
  ).toBeNull();
  expect(
    approvedTransitFallback({ ...input, service: "OVERNIGHT" }),
  ).toBeNull();
  expect(
    approvedTransitFallback({
      ...input,
      now: new Date("2026-11-01T18:00:00Z"),
    }),
  ).toBeNull();
  expect(() =>
    approvedTransitFallback({ ...input, rules: [rule, rule] }),
  ).toThrow();
  expect(
    approvedTransitFallback({
      ...input,
      rules: [{ ...rule, ApprovedAt: "2026-10-06T00:00:00Z" }],
    }),
  ).toBeNull();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
test("loads every published page and rejects incomplete collection metadata instead of using empty defaults", async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.includes("/checkout?"))
      return { ok: true, json: async () => ({ data: checkout() }) };
    const page = url.includes("[page]=2") ? 2 : 1;
    if (url.includes("atlanta-delivery-zones"))
      return {
        ok: true,
        json: async () => ({
          data: [
            page === 1
              ? zone
              : { ...zone, ZipCode: "30341", documentId: "test-zone-2" },
          ],
          meta: { pagination: { page, pageCount: 2, total: 2 } },
        }),
      };
    return {
      ok: true,
      json: async () => ({
        data: [route],
        meta: { pagination: { page: 1, pageCount: 1, total: 1 } },
      }),
    };
  });
  global.fetch = fetchMock as any;
  const source = await loadCalendarSource(
    {
      STRAPI_URL: "https://synthetic.invalid",
      STRAPI_TOKEN: "synthetic-test-token",
    },
    now,
  );
  expect(source.policy.atlanta).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls[0][0]).not.toContain("publicationState=preview");
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  })) as any;
  await expect(
    loadCalendarSource(
      {
        STRAPI_URL: "https://synthetic.invalid",
        STRAPI_TOKEN: "synthetic-test-token",
      },
      now,
    ),
  ).rejects.toMatchObject({ status: 503 });
});
