import {
  CALENDAR_SELECTION_KEY,
  computeFulfillmentCalendar,
} from "../fulfillment-calendar";
import {
  calendarCart,
  calendarPolicy,
  calendarTransit,
} from "./__fixtures__/fulfillment-calendar";
import {
  calendarCartRevision,
  issueCalendarSelection,
  readCalendarSelection,
  validateCalendarSelection,
  calendarSelectionMetadata,
  acceptedCalendarMetadata,
  packingContextFromCalendar,
} from "../fulfillment-calendar-selection";
const key = "synthetic-only-key-32-characters-minimum";
const now = new Date("2026-10-05T18:00:00Z");
const calendar = () =>
  computeFulfillmentCalendar({
    policy: calendarPolicy(),
    request: { mode: "ups_shipping", service: "GROUND", postalCode: "10001" },
    transit: calendarTransit(now),
    now,
  });
function selected() {
  const cart = calendarCart();
  const issued = issueCalendarSelection({
    cart,
    shippingOptionId: "so_fixture",
    calendar: calendar(),
    arrivalDate: "2026-10-06",
    key,
    now,
  });
  cart.metadata = calendarSelectionMetadata(issued.token, issued.selection);
  return { cart, ...issued };
}
test("a server-signed choice carries the same promise into packing and accepted-order metadata", () => {
  const { cart, selection } = selected();
  expect(
    validateCalendarSelection({
      cart,
      shippingOptionId: "so_fixture",
      calendar: calendar(),
      key,
      now,
    }),
  ).toEqual(selection);
  expect(packingContextFromCalendar(selection)).toMatchObject({
    dispatchDate: "2026-10-05",
    arrivalDate: "2026-10-06",
    validatedTransit: { days: 1, packingDays: 2, elapsedHours: 26 },
  });
  const accepted = acceptedCalendarMetadata(cart, selection, now);
  expect(accepted).toMatchObject({
    requestedDeliveryDate: "2026-10-06",
    qbdDueDate: "2026-10-05",
    fulfillmentDispatchDate: "2026-10-05",
    fulfillmentCalendarTimezone: "America/New_York",
    fulfillmentWindowLabel: "",
    fulfillmentPickDate: "2026-10-05",
  });
});
test.each(["quantity", "variant", "price", "address", "customer"])(
  "changing %s invalidates a previously signed selection",
  (field) => {
    const { cart } = selected();
    if (field === "quantity") cart.items[0].quantity = 2;
    if (field === "variant") cart.items[0].variant_id = "other";
    if (field === "price") cart.items[0].unit_price = 20;
    if (field === "address") cart.shipping_address.address_1 = "2 Test";
    if (field === "customer") cart.customer_id = "other";
    expect(() =>
      validateCalendarSelection({
        cart,
        shippingOptionId: "so_fixture",
        calendar: calendar(),
        key,
        now,
      }),
    ).toThrow();
  },
);
test("different option, closure revision, forged payload, comment-only date and expired quote cannot be accepted", () => {
  const { cart, token } = selected();
  expect(() =>
    validateCalendarSelection({
      cart,
      shippingOptionId: "other",
      calendar: calendar(),
      key,
      now,
    }),
  ).toThrow();
  const changed = calendar();
  changed.calendarRevision += "changed";
  expect(() =>
    validateCalendarSelection({
      cart,
      shippingOptionId: "so_fixture",
      calendar: changed,
      key,
      now,
    }),
  ).toThrow();
  const [payload, signature] = token.split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
  forged.choice.arrivalDate = "2026-10-07";
  expect(() =>
    readCalendarSelection(
      Buffer.from(JSON.stringify(forged)).toString("base64url") +
        "." +
        signature,
      key,
      now,
    ),
  ).toThrow();
  delete cart.metadata[CALENDAR_SELECTION_KEY];
  cart.metadata.orderNotes = "Please deliver October 6";
  expect(() =>
    validateCalendarSelection({
      cart,
      shippingOptionId: "so_fixture",
      calendar: calendar(),
      key,
      now,
    }),
  ).toThrow();
  expect(() =>
    readCalendarSelection(token, key, new Date("2026-10-05T18:10:00Z")),
  ).toThrow();
});
test("no false promise for an arbitrary date/window; metadata notes do not change basket binding", () => {
  const { cart } = selected(),
    revision = calendarCartRevision(cart);
  cart.metadata.orderNotes = "Test note";
  expect(calendarCartRevision(cart)).toBe(revision);
  expect(() =>
    issueCalendarSelection({
      cart,
      shippingOptionId: "so_fixture",
      calendar: calendar(),
      arrivalDate: "2026-10-11",
      key,
      now,
    }),
  ).toThrow();
  expect(() =>
    issueCalendarSelection({
      cart,
      shippingOptionId: "so_fixture",
      calendar: calendar(),
      arrivalDate: "2026-10-06",
      windowId: "made-up",
      key,
      now,
    }),
  ).toThrow();
});
