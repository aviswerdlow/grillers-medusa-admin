import {
  fulfillmentCalendarAction,
  currentCalendarSelection,
  prepareCalendarAcceptance,
  validateCalendarAcceptance,
  calendarPackingContextForRate,
} from "../fulfillment-calendar-runtime";
import {
  CALENDAR_ACCEPTED_KEY,
  FulfillmentCalendarError,
} from "../fulfillment-calendar";
import { loadCalendarSource } from "../fulfillment-calendar-source";
import { getPackagingConfig } from "../packaging-cost-strapi";
import { createWwexSpeedshipClientFromEnv } from "../../modules/fulfillment/wwex-speedship";
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
} from "../shipping-packing-plan";
import { packingContextFromCalendar } from "../fulfillment-calendar-selection";
import {
  prepareShippingAcceptance,
  validateShippingAcceptance,
} from "../shipping-acceptance";
import {
  prepareNativeShippingAcceptance,
  publicShippingProjection,
} from "../../api/middlewares/shipping-inputs";
import {
  calendarCart,
  calendarPolicy,
} from "./__fixtures__/fulfillment-calendar";
import { shippingLine, packingConfig } from "./__fixtures__/shipping-inputs";
import { calendarEnforcementMode } from "../fulfillment-calendar-rollout";
import { GET as calendarCapability } from "../../api/store/grillers/checkout/fulfillment-calendar/route";
jest.mock("../fulfillment-calendar-source", () => ({
  ...jest.requireActual("../fulfillment-calendar-source"),
  loadCalendarSource: jest.fn(),
}));
jest.mock("../packaging-cost-strapi", () => ({
  getPackagingConfig: jest.fn(),
}));
jest.mock("../../modules/fulfillment/wwex-speedship", () => ({
  ...jest.requireActual("../../modules/fulfillment/wwex-speedship"),
  createWwexSpeedshipClientFromEnv: jest.fn(),
}));
const now = new Date("2026-10-05T18:00:00Z"),
  key = "synthetic-fixture-only-calendar-key-32";
const savedKey = process.env.GRILLERS_CALENDAR_SIGNING_KEY;
const savedEnforcement = process.env.GP_CALENDAR_ENFORCEMENT;
const env = {
  GRILLERS_CALENDAR_SIGNING_KEY: key,
  GP_CALENDAR_ENFORCEMENT: "required",
  WWEX_ORIGIN_POSTAL_CODE: "30340",
};
const clone = (v: any) => JSON.parse(JSON.stringify(v));
function source() {
  return {
    policy: calendarPolicy(),
    originPostalCode: "30340",
    transitRules: [
      {
        Service: "GROUND",
        OriginPostalCode: "30340",
        DestinationZipPrefix: "100",
        BusinessDays: 1,
        Revision: "fixture",
        ApprovedAt: "2026-08-01T00:00:00Z",
        ApprovalReference: "synthetic",
        ValidFrom: "2026-03-01",
        ValidThrough: "2026-12-31",
      },
    ],
  };
}
function harness(service = "GROUND") {
  const cart = calendarCart();
  cart.items = [{ ...shippingLine(), unit_price: 10 }];
  cart.shipping_methods = [
    { id: "sm_fixture", shipping_option_id: "so_fixture", data: {} },
  ];
  const query = {
    graph: jest.fn(async ({ entity }: any) => ({
      data:
        entity === "cart"
          ? [clone(cart)]
          : entity === "shipping_option"
          ? [{ id: "so_fixture", data: { service_code: service } }]
          : [clone(cart.items[0].variant)],
    })),
  };
  const module = {
    updateCarts: jest.fn(async (_id: string, data: any) =>
      Object.assign(cart, data)
    ),
    updateLineItems: jest.fn(async (rows: any[]) =>
      rows.forEach((row) =>
        Object.assign(
          cart.items.find((i: any) => i.id === row.id),
          row
        )
      )
    ),
  };
  const scope = {
    resolve: (name: string) => (name === "query" ? query : module),
  };
  return { cart, query, module, scope };
}
async function select(h: ReturnType<typeof harness>, extra: any = {}) {
  const list: any = await fulfillmentCalendarAction(
    h.scope,
    {
      action: "list",
      cart_id: h.cart.id,
      shipping_option_id: "so_fixture",
      ...extra,
    },
    env,
    () => now
  );
  const choice = list.calendar.choices[0];
  const result: any = await fulfillmentCalendarAction(
    h.scope,
    {
      action: "select",
      cart_id: h.cart.id,
      shipping_option_id: "so_fixture",
      context_revision: list.contextRevision,
      arrival_date: choice.arrivalDate,
      ...(choice.window ? { window_id: choice.window.id } : {}),
      ...extra,
    },
    env,
    () => now
  );
  if (result.state === "selected")
    Object.assign(h.cart.metadata, result.metadata);
  return result;
}
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(now);
  jest.clearAllMocks();
  process.env.GRILLERS_CALENDAR_SIGNING_KEY = key;
  process.env.GP_CALENDAR_ENFORCEMENT = "required";
  (loadCalendarSource as jest.Mock).mockResolvedValue(source());
  (getPackagingConfig as jest.Mock).mockResolvedValue(packingConfig());
  (createWwexSpeedshipClientFromEnv as jest.Mock).mockReturnValue(null);
});
afterEach(() => {
  jest.useRealTimers();
  if (savedKey === undefined) delete process.env.GRILLERS_CALENDAR_SIGNING_KEY;
  else process.env.GRILLERS_CALENDAR_SIGNING_KEY = savedKey;
  if (savedEnforcement === undefined)
    delete process.env.GP_CALENDAR_ENFORCEMENT;
  else process.env.GP_CALENDAR_ENFORCEMENT = savedEnforcement;
});

test.each(["GROUND", "PICKUP", "ATLANTA_DELIVERY", "SCHEDULED_DELIVERY"])(
  "%s legacy checkout passes preparation and completion with enforcement unset and no calendar infrastructure",
  async (service) => {
    delete process.env.GP_CALENDAR_ENFORCEMENT;
    delete process.env.GRILLERS_CALENDAR_SIGNING_KEY;
    (loadCalendarSource as jest.Mock).mockRejectedValue(
      new Error("calendar is not deployed")
    );
    const h = harness(service);
    const warn = jest.fn();
    const scope = {
      resolve: (name: string) =>
        name === "logger" ? { warn } : h.scope.resolve(name),
    };
    if (service === "GROUND") {
      h.cart.shipping_methods[0].data = {
        [SHIPPING_PACKING_PLAN_KEY]: createShippingPackingPlan(
          h.cart.items,
          { service, postalCode: h.cart.shipping_address.postal_code },
          packingConfig()
        ),
      };
    }
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await prepareNativeShippingAcceptance(
      { scope, params: { id: h.cart.id } } as any,
      res as any,
      next
    );
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    await validateCalendarAcceptance(scope, clone(h.cart));
    await validateShippingAcceptance(scope, clone(h.cart));
    expect(loadCalendarSource).not.toHaveBeenCalled();
    expect(h.cart.metadata[CALENDAR_ACCEPTED_KEY]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("calendar_enforcement_off")
    );
    const result = await fulfillmentCalendarAction(
      scope,
      { action: "validate", cart_id: h.cart.id },
      process.env,
      () => now
    );
    expect(result).toEqual({ state: "legacy", summary: null });
    await expect(
      fulfillmentCalendarAction(
        scope,
        { action: "list", cart_id: h.cart.id },
        process.env,
        () => now
      )
    ).rejects.toMatchObject({ code: "calendar_not_enabled", status: 503 });
  }
);

test.each([
  [undefined, "off"],
  ["off", "off"],
  ["required", "required"],
  ["typo", "required"],
])(
  "calendar capability advertises %s without depending on CMS or a signing key",
  async (configured, expected) => {
    if (configured === undefined) delete process.env.GP_CALENDAR_ENFORCEMENT;
    else process.env.GP_CALENDAR_ENFORCEMENT = configured;
    expect(calendarEnforcementMode()).toBe(expected);
    const res = { setHeader: jest.fn(), json: jest.fn() };
    await calendarCapability({} as any, res as any);
    expect(res.json).toHaveBeenCalledWith({ enforcement: expected });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(loadCalendarSource).not.toHaveBeenCalled();
  }
);

test("turning enforcement off preserves a previously signed choice and still rejects a changed cart", async () => {
  const h = harness();
  await select(h);
  process.env.GP_CALENDAR_ENFORCEMENT = "off";
  await prepareCalendarAcceptance(h.scope, h.cart.id);
  await validateCalendarAcceptance(h.scope, clone(h.cart));
  expect(h.cart.metadata[CALENDAR_ACCEPTED_KEY]).toBeDefined();
  h.cart.items[0].quantity += 1;
  await expect(
    prepareCalendarAcceptance(h.scope, h.cart.id)
  ).rejects.toMatchObject({ code: "calendar_context_changed" });
});

test.each([
  "fulfillment_calendar_selection_v1",
  "fulfillment_calendar_accepted_v1",
  "fulfillmentCalendarQuoteId",
])(
  "off mode cannot discard an incomplete or invalid existing %s promise",
  async (marker) => {
    process.env.GP_CALENDAR_ENFORCEMENT = "off";
    delete process.env.GRILLERS_CALENDAR_SIGNING_KEY;
    const h = harness();
    h.cart.metadata[marker] = "invalid-existing-promise";
    await expect(
      prepareCalendarAcceptance(h.scope, h.cart.id)
    ).rejects.toMatchObject({ code: "calendar_signer_unconfigured" });
    expect(h.module.updateCarts).not.toHaveBeenCalled();
  }
);

test("off mode rejects a workflow cart whose promise disappeared from current storage", async () => {
  process.env.GP_CALENDAR_ENFORCEMENT = "off";
  const h = harness();
  const loaded = clone(h.cart);
  loaded.metadata.fulfillmentCalendarQuoteId = "prior-promise";
  await expect(
    validateCalendarAcceptance(h.scope, loaded)
  ).rejects.toMatchObject({ code: "calendar_acceptance_changed" });
  h.cart.completed_at = now.toISOString();
  await expect(
    validateCalendarAcceptance(h.scope, loaded)
  ).resolves.toBeUndefined();
});
test("real calendar, packing and acceptance functions preserve one signed choice through native cart preparation", async () => {
  const h = harness();
  const selected = await select(h);
  expect(selected.state).toBe("selected");
  const c = await currentCalendarSelection(h.scope, h.cart.id, env, () => now);
  const plan = createShippingPackingPlan(
    h.cart.items,
    packingContextFromCalendar(c!.selection),
    packingConfig()
  );
  h.cart.shipping_methods[0].data[SHIPPING_PACKING_PLAN_KEY] = plan;
  await prepareCalendarAcceptance(h.scope, h.cart.id);
  await prepareShippingAcceptance(h.scope, h.cart.id);
  const loaded = clone(h.cart);
  await validateCalendarAcceptance(h.scope, loaded);
  await validateShippingAcceptance(h.scope, loaded);
  expect(plan).toMatchObject({
    dispatchDate: "2026-10-05",
    arrivalDate: "2026-10-06",
    transitDays: 1,
    packingDays: 2,
    elapsedPackingHours: 26,
  });
  expect(loaded.metadata[CALENDAR_ACCEPTED_KEY].choice.arrivalDate).toBe(
    plan.arrivalDate
  );
  expect(
    publicShippingProjection(loaded).metadata[CALENDAR_ACCEPTED_KEY]
  ).toBeUndefined();
  loaded.items[0].quantity = 2;
  await expect(
    validateCalendarAcceptance(h.scope, loaded)
  ).rejects.toMatchObject({ code: "calendar_acceptance_changed" });
});
test.each(["PICKUP", "ATLANTA_DELIVERY", "SCHEDULED_DELIVERY"])(
  "%s uses the same acceptance guard without UPS transit",
  async (service) => {
    const h = harness(service);
    if (service === "ATLANTA_DELIVERY")
      h.cart.shipping_address.postal_code = "30340";
    if (service === "SCHEDULED_DELIVERY")
      h.cart.shipping_address.province = "SC";
    const r = await select(
      h,
      service === "SCHEDULED_DELIVERY" ? { route_id: "approved-route" } : {}
    );
    expect(r.summary.transit).toBeNull();
    await prepareCalendarAcceptance(h.scope, h.cart.id);
    await validateCalendarAcceptance(h.scope, clone(h.cart));
  }
);
test.each([
  {
    country_code: "us",
    province: "NY",
    code: "calendar_destination_unavailable",
  },
  {
    country_code: "ca",
    province: "SC",
    code: "calendar_destination_unavailable",
  },
  { country_code: "us", province: "", code: "calendar_address_required" },
])(
  "regional requests reject an ineligible actual cart address: %j",
  async ({ code, ...address }) => {
    const h = harness("SCHEDULED_DELIVERY");
    Object.assign(h.cart.shipping_address, address);
    for (const action of ["list", "select"])
      await expect(
        fulfillmentCalendarAction(
          h.scope,
          {
            action,
            cart_id: h.cart.id,
            route_id: "approved-route",
            shipping_option_id: "so_fixture",
            arrival_date: "2026-10-08",
          },
          env,
          () => now
        )
      ).rejects.toMatchObject({ code });
    expect(h.module.updateCarts).not.toHaveBeenCalled();
  }
);
test.each(["SC", "sc", "South Carolina", "us-sc"])(
  "regional routes use the actual normalized state %s",
  async (province) => {
    const h = harness("SCHEDULED_DELIVERY");
    h.cart.shipping_address.province = province;
    const page: any = await fulfillmentCalendarAction(
      h.scope,
      {
        action: "list",
        cart_id: h.cart.id,
        shipping_option_id: "so_fixture",
      },
      env,
      () => now
    );
    expect(page.regionalLocations).toEqual([
      { id: "approved-route", city: "Synthetic future route", state: "SC" },
    ]);
    expect(page.calendar.choices).toEqual([]); // A route still requires an explicit choice.
    await select(h, { route_id: "approved-route" });
    h.cart.shipping_address.province = "NY";
    await expect(
      prepareCalendarAcceptance(h.scope, h.cart.id)
    ).rejects.toBeInstanceOf(FulfillmentCalendarError);
    expect(h.module.updateCarts).not.toHaveBeenCalled();
  }
);
test("native completion rejects direct date metadata before preparation or payment can continue", async () => {
  const h = harness();
  h.cart.metadata = {
    requestedDeliveryDate: "2026-10-06",
    scheduledDate: "2026-10-06",
  };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() },
    next = jest.fn();
  await prepareNativeShippingAcceptance(
    { scope: h.scope, params: { id: h.cart.id } } as any,
    res,
    next
  );
  expect(res.status).toHaveBeenCalledWith(409);
  expect(next).not.toHaveBeenCalled();
  expect(h.module.updateCarts).not.toHaveBeenCalled();
});
test("restored/changed carts and changed published closures require a new selection", async () => {
  const h = harness();
  await select(h);
  h.cart.shipping_address.postal_code = "10002";
  await expect(
    currentCalendarSelection(h.scope, h.cart.id, env, () => now)
  ).rejects.toBeInstanceOf(FulfillmentCalendarError);
  h.cart.shipping_address.postal_code = "10001";
  const changed = source();
  changed.policy.operationsBlackouts = ["2026-10-05"];
  (loadCalendarSource as jest.Mock).mockResolvedValue(changed);
  await expect(
    currentCalendarSelection(h.scope, h.cart.id, env, () => now)
  ).rejects.toMatchObject({ code: "calendar_context_changed" });
});
test("completed cart replay does not read or rewrite the old accepted promise", async () => {
  const h = harness();
  h.cart.completed_at = now.toISOString();
  h.cart.metadata[CALENDAR_ACCEPTED_KEY] = { old: "retained" };
  await prepareCalendarAcceptance(h.scope, h.cart.id);
  expect(loadCalendarSource).not.toHaveBeenCalled();
  expect(h.module.updateCarts).not.toHaveBeenCalled();
});
test("a revised transit fallback invalidates a displayed context even when its arrival date still exists", async () => {
  const h = harness();
  const displayed: any = await fulfillmentCalendarAction(
    h.scope,
    {
      action: "list",
      cart_id: h.cart.id,
      shipping_option_id: "so_fixture",
    },
    env,
    () => now
  );
  const changed = source();
  changed.transitRules[0].BusinessDays = 2;
  changed.transitRules[0].Revision = "updated-transit";
  (loadCalendarSource as jest.Mock).mockResolvedValue(changed);
  await expect(
    fulfillmentCalendarAction(
      h.scope,
      {
        action: "select",
        cart_id: h.cart.id,
        shipping_option_id: "so_fixture",
        arrival_date: "2026-10-08",
        context_revision: displayed.contextRevision,
      },
      env,
      () => now
    )
  ).rejects.toMatchObject({ code: "calendar_context_changed" });
});
test("carrier date change returns an explicit replacement requiring another customer choice", async () => {
  const h = harness();
  const client = {
    quoteSmallpack: jest.fn(async () => ({
      offer: {
        offerId: "new",
        productTransactionId: "new",
        upsServiceCode: "GND",
        transitDays: 2,
        estimatedDeliveryDate: "2026-10-07",
      },
      offers: [],
    })),
  };
  (createWwexSpeedshipClientFromEnv as jest.Mock).mockReturnValue(client);
  const result = await select(h);
  expect(result.state).toBe("changed");
  expect(h.cart.metadata).toEqual({});
  const accepted: any = await fulfillmentCalendarAction(
    h.scope,
    {
      action: "select",
      cart_id: h.cart.id,
      shipping_option_id: "so_fixture",
      context_revision: result.contextRevision,
      arrival_date: "2026-10-07",
      replacement_quote: result.replacementQuote,
    },
    env,
    () => now
  );
  expect(accepted.state).toBe("selected");
  expect(client.quoteSmallpack).toHaveBeenCalledTimes(1);
  Object.assign(h.cart.metadata, accepted.metadata);
  expect(
    (await currentCalendarSelection(h.scope, h.cart.id, env, () => now))!
      .selection.choice.transitBusinessDays
  ).toBe(2);
});
test("rate preview is server-derived and never makes an unsigned cart acceptable", async () => {
  const h = harness();
  const context = await calendarPackingContextForRate(
    h.query,
    h.cart.id,
    "GROUND",
    env,
    () => now
  );
  expect(context).toMatchObject({
    dispatchDate: "2026-10-05",
    arrivalDate: "2026-10-06",
  });
  await expect(
    currentCalendarSelection(h.scope, h.cart.id, env, () => now)
  ).rejects.toMatchObject({ code: "calendar_selection_required" });
});

test.each([
  ["fulfillmentDispatchDate", "2026-10-09"],
  ["fulfillmentWindowLabel", "Invented window"],
  ["fulfillmentCalendarTimezone", "Pacific/Honolulu"],
])(
  "native completion rejects a changed %s projection",
  async (field, value) => {
    const h = harness();
    await select(h);
    await prepareCalendarAcceptance(h.scope, h.cart.id);
    const loaded = clone(h.cart);
    loaded.metadata[field] = value;
    await expect(
      validateCalendarAcceptance(h.scope, loaded)
    ).rejects.toMatchObject({ code: "calendar_acceptance_changed" });
  }
);
