import {
  fulfillmentDates,
  fulfillmentDateKey,
  formatFulfillmentDate,
} from "../fulfillment-dates";
import { normalizeOrderForEmail } from "../emails/order-fetch";
import { buildOrderPlacedEmail } from "../emails/templates/order-placed";

test("keeps arrival, preparation and dispatch distinct with legacy date compatibility", () => {
  expect(
    fulfillmentDates({
      fulfillmentType: "ups_shipping",
      requestedDeliveryDate: "10/9/2026",
      scheduledDate: "2026-10-08",
      qbdDueDate: "2026-10-07",
      fulfillmentDispatchDate: "2026-10-06",
      fulfillmentPickDate: "2026-10-05",
    }),
  ).toEqual({
    arrivalDate: "2026-10-09",
    dispatchDate: "2026-10-06",
    pickDate: "2026-10-05",
  });
  expect(
    fulfillmentDates({
      fulfillmentType: "ups_shipping",
      requestedDeliveryDate: "2026-10-09",
    }),
  ).toEqual({ arrivalDate: "2026-10-09", dispatchDate: null, pickDate: null });
  expect(
    fulfillmentDates({
      fulfillmentType: "plant_pickup",
      scheduledDate: "10/9/2026",
    }).dispatchDate,
  ).toBe("2026-10-09");
});

test.each([
  "2026-02-30",
  "2/29/2026",
  "2026-13-01",
  "2026-10-08T00:00:00Z",
  {},
  null,
])("does not roll an invalid civil date into a real promise: %p", (value) => {
  expect(fulfillmentDateKey(value)).toBeNull();
  expect(formatFulfillmentDate(value)).toBe("");
});

test.each([
  "ups_shipping",
  "atlanta_delivery",
  "plant_pickup",
  "southeast_pickup",
])("email preserves customer arrival and approved window for %s", (mode) => {
  const email = buildOrderPlacedEmail(
    normalizeOrderForEmail({
      id: "order_calendar_fixture",
      items: [],
      currency_code: "usd",
      metadata: {
        fulfillmentType: mode,
        scheduledDate: "2026-10-08",
        requestedDeliveryDate: "2026-10-08",
        fulfillmentPickDate: "2026-10-05",
        qbdDueDate: "2026-10-07",
        fulfillmentDispatchDate: "2026-10-07",
        fulfillmentWindowLabel: mode === "ups_shipping" ? "" : "2–4 PM",
        fulfillmentCalendarTimezone: "America/New_York",
      },
    }),
  );
  for (const body of [email.html, email.text]) {
    expect(body).toContain("Thu, Oct 8, 2026");
    expect(body).not.toContain("Oct 7");
    expect(body).not.toContain("Oct 5");
    if (mode === "ups_shipping") expect(body).toContain("tracking number");
    else {
      expect(body).not.toContain("tracking number");
      expect(body).toContain("2–4 PM ET");
    }
  }
  if (mode.includes("pickup")) expect(email.html).toContain("Pickup details");
});
