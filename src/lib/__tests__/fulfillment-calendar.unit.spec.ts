import {
  computeFulfillmentCalendar,
  easternInstant,
  easternParts,
  readCalendarPolicy,
  validCivilDate,
} from "../fulfillment-calendar";
import {
  calendarPolicy,
  calendarTransit,
} from "./__fixtures__/fulfillment-calendar";

const now = new Date("2026-10-05T18:00:00Z"); // Monday 14:00 Eastern
function ups(overrides: any = {}) {
  return computeFulfillmentCalendar({
    policy: calendarPolicy(),
    request: { mode: "ups_shipping", service: "GROUND", postalCode: "10001" },
    transit: calendarTransit(now),
    now,
    ...overrides,
  });
}
test("one choice distinguishes arrival, dispatch, preparation, business days and packed exposure", () => {
  expect(ups().choices[0]).toMatchObject({
    arrivalDate: "2026-10-06",
    dispatchDate: "2026-10-05",
    pickDate: "2026-10-05",
    cutoffAt: "2026-10-05T19:00:00.000Z",
    transitBusinessDays: 1,
    elapsedPackingHours: 26,
    packingDays: 2,
  });
});
test("UTC midnight and host timezone do not change the Eastern calendar", () => {
  const previous = process.env.TZ;
  try {
    const results = ["UTC", "America/Los_Angeles", "Asia/Jerusalem"].map(
      (tz) => {
        process.env.TZ = tz;
        return ups({
          now: new Date("2026-10-06T00:05:00Z"),
          transit: calendarTransit(new Date("2026-10-06T00:05:00Z")),
        });
      },
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(easternParts(new Date("2026-10-06T00:05:00Z")).date).toBe(
      "2026-10-05",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
test("actual Eastern DST offsets apply, ambiguous cutoffs use the earlier instant, impossible times reject", () => {
  expect(easternInstant("2026-03-06", "11:00").toISOString()).toBe(
    "2026-03-06T16:00:00.000Z",
  );
  expect(easternInstant("2026-03-09", "11:00").toISOString()).toBe(
    "2026-03-09T15:00:00.000Z",
  );
  expect(easternInstant("2026-11-01", "01:30").toISOString()).toBe(
    "2026-11-01T05:30:00.000Z",
  );
  expect(() => easternInstant("2026-03-08", "02:30")).toThrow();
});
test("the exact cutoff is closed; a previously displayed Tuesday must be reselected", () => {
  expect(
    ups({ now: new Date("2026-10-05T18:59:59Z") }).choices[0].arrivalDate,
  ).toBe("2026-10-06");
  expect(
    ups({
      now: new Date("2026-10-05T19:00:00Z"),
      transit: calendarTransit(new Date("2026-10-05T19:00:00Z")),
    }).choices[0].arrivalDate,
  ).toBe("2026-10-07");
});
test("plant closure and carrier pickup/delivery closures affect their distinct stages", () => {
  const p = calendarPolicy();
  p.operationsBlackouts = ["2026-10-05"];
  expect(ups({ policy: p }).choices[0].dispatchDate).toBe("2026-10-06");
  p.operationsBlackouts = [];
  p.upsPickupBlackouts = ["2026-10-05"];
  expect(ups({ policy: p }).choices[0].dispatchDate).toBe("2026-10-06");
  p.upsPickupBlackouts = [];
  p.upsDeliveryBlackouts = ["2026-10-06"];
  expect(
    ups({ policy: p }).choices.some((c) => c.dispatchDate === "2026-10-05"),
  ).toBe(false);
});
test("multi-day transit never borrows a shorter ZIP table and does not ignore weekend exposure", () => {
  const t = {
    ...calendarTransit(now),
    businessDays: 3,
    service: "3_DAY_SELECT",
  };
  const r = ups({
    request: {
      mode: "ups_shipping",
      service: "3_DAY_SELECT",
      postalCode: "10001",
    },
    transit: t,
  });
  expect(r.choices[0]).toMatchObject({
    arrivalDate: "2026-10-08",
    dispatchDate: "2026-10-05",
    transitBusinessDays: 3,
    elapsedPackingHours: 74,
  });
  expect(
    r.choices.every(
      (c) =>
        ![0, 5, 6].includes(new Date(c.arrivalDate + "T00:00:00Z").getUTCDay()),
    ),
  ).toBe(true);
});
test("expired, wrong destination/service, missing, or out-of-coverage transit cannot offer normal dates", () => {
  for (const transit of [
    null,
    { ...calendarTransit(), expiresAt: now.toISOString() },
    { ...calendarTransit(), service: "OVERNIGHT" },
    { ...calendarTransit(), destinationPostalCode: "90001" },
    { ...calendarTransit(), validThrough: "2026-10-05" },
  ]) {
    expect(ups({ transit }).choices).toEqual([]);
  }
});
test("a late carrier response cannot revive a now-expired transit result", () => {
  const later = new Date("2026-10-05T19:00:01Z");
  expect(ups({ now: later }).unavailableReason).toBe("missing_transit");
});
test("carrier estimated date and dispatch-specific cache must match the computed promise", () => {
  const t = {
    ...calendarTransit(),
    source: "carrier_cache" as const,
    dispatchDate: "2026-10-05",
    estimatedArrivalDate: "2026-10-08",
  };
  expect(ups({ transit: t }).choices).toEqual([]);
  t.estimatedArrivalDate = "2026-10-06";
  expect(ups({ transit: t }).choices).toHaveLength(1);
});
test("past-only Chattanooga, empty Gainesville and unknown routes are explicitly unavailable; approved future route survives", () => {
  for (const routeId of [
    "chattanooga",
    "gainesville",
    "unknown",
    "approved-route",
  ]) {
    const r = computeFulfillmentCalendar({
      policy: calendarPolicy(),
      request: {
        mode: "southeast_pickup",
        service: "SOUTHEAST_PICKUP",
        postalCode: "",
        routeId,
      },
      now,
    });
    expect(r.choices.map((c) => c.arrivalDate)).toEqual(
      routeId === "approved-route" ? ["2026-10-08"] : [],
    );
    if (routeId === "unknown")
      expect(r.unavailableReason).toBe("unknown_route");
  }
});
test("regional cutoff uses configured days and local time, not browser elapsed-day rounding", () => {
  const p = calendarPolicy();
  p.southeast[2].cutoffDays = 3;
  const request = {
    mode: "southeast_pickup" as const,
    service: "SOUTHEAST_PICKUP",
    postalCode: "",
    routeId: "approved-route",
  };
  expect(
    computeFulfillmentCalendar({
      policy: p,
      request,
      now: new Date("2026-10-05T15:59:59Z"),
    }).choices,
  ).toHaveLength(1);
  expect(
    computeFulfillmentCalendar({
      policy: p,
      request,
      now: new Date("2026-10-05T16:00:00Z"),
    }).choices,
  ).toHaveLength(0);
});
test("plant Friday has its own cutoff; local routes do not inherit UPS holidays or a made-up ZIP schedule", () => {
  const p = calendarPolicy();
  p.upsDeliveryBlackouts = ["2026-10-09"];
  const request = {
    mode: "plant_pickup" as const,
    service: "PLANT_PICKUP",
    postalCode: "",
  };
  expect(
    computeFulfillmentCalendar({
      policy: p,
      request,
      now: new Date("2026-10-09T12:59:59Z"),
    }).choices[0].arrivalDate,
  ).toBe("2026-10-09");
  expect(
    computeFulfillmentCalendar({
      policy: p,
      request,
      now: new Date("2026-10-09T13:00:00Z"),
    }).choices[0].arrivalDate,
  ).toBe("2026-10-12");
  expect(
    computeFulfillmentCalendar({
      policy: p,
      request: {
        mode: "atlanta_delivery",
        service: "ATLANTA_DELIVERY",
        postalCode: "00000",
      },
      now,
    }).unavailableReason,
  ).toBe("unknown_route");
});
test("invalid dates, empty policies, expired approval and duplicate routes fail without default dates", () => {
  expect(validCivilDate("2026-02-30")).toBe(false);
  expect(validCivilDate("2026-2-03")).toBe(false);
  expect(() => readCalendarPolicy({}, now)).toThrow();
  const p = calendarPolicy();
  p.validThrough = "2026-09-01";
  expect(() => readCalendarPolicy(p, now)).toThrow();
  const q = calendarPolicy();
  q.atlanta.push(q.atlanta[0]);
  expect(() => readCalendarPolicy(q, now)).toThrow();
});
