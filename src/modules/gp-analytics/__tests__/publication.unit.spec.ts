import Service from "../service";
const logger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const options = {
  jitsuHost: "https://jitsu.example.invalid",
  jitsuServerSecret: "fixture",
  gpAnalyticsEndpoint: "https://gp.example.invalid",
  gpAnalyticsServerKey: "fixture",
};
const event = {
  event: "order_completed",
  actor_id: "cus_fixture",
  properties: {
    idempotency_key: "order.placed:order_fixture:order_completed",
    event_timestamp_ms: 1789927200000,
    order_id: "order_fixture",
    cart_id: "cart_fixture",
    value: 0,
    test_order: false,
    analytics_consent: true,
    experiment_context_status: "complete",
    experiment_assignments: [],
  },
};
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
});
afterAll(() => {
  global.fetch = originalFetch;
});
it("sends byte-identical retries with the same UUID and time to both transports", async () => {
  const service = new Service({ logger } as any, options);
  for (const target of [
    "jitsu",
    "gp_analytics",
    "jitsu",
    "gp_analytics",
  ] as const)
    await service.deliverOrderPublication(target, event);
  const calls = (global.fetch as jest.Mock).mock.calls;
  expect(calls[0][1].body).toBe(calls[2][1].body);
  expect(calls[1][1].body).toBe(calls[3][1].body);
  const j = JSON.parse(calls[0][1].body).eventn_ctx,
    g = JSON.parse(calls[1][1].body);
  expect(j.event_id).toBe(g.event_id);
  expect(j.event_timestamp_ms).toBe(g.event_timestamp_ms);
  expect(j.value).toBe(0);
  expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it("awaits the actual transport response", async () => {
  let accept!: (x: any) => void,
    finished = false;
  global.fetch = jest.fn(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      })
  ) as any;
  const pending = new Service({ logger } as any, options)
    .deliverOrderPublication("jitsu", event)
    .then(() => {
      finished = true;
    });
  await Promise.resolve();
  expect(finished).toBe(false);
  accept({ ok: true });
  await pending;
  expect(finished).toBe(true);
});
it.each(["jitsu", "gp_analytics"] as const)(
  "rejects failure from %s without persisting response data",
  async (target) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      text: () => "secret@example.invalid",
    }) as any;
    await expect(
      new Service({ logger } as any, options).deliverOrderPublication(
        target,
        event
      )
    ).rejects.toThrow("publication_transport_not_acknowledged");
  }
);
it("does not mark missing or disabled configuration delivered", async () => {
  expect(
    await new Service({ logger } as any, {
      jitsuHost: "",
      jitsuServerSecret: "",
    }).deliverOrderPublication("jitsu", event)
  ).toMatchObject({ status: "held" });
  expect(
    await new Service({ logger } as any, {
      ...options,
      gpAnalyticsDualRun: false,
    }).deliverOrderPublication("gp_analytics", event)
  ).toMatchObject({ status: "held" });
  expect(global.fetch).not.toHaveBeenCalled();
});
it("forwards finalization distinctly to Jitsu as well as the mirror", async () => {
  await new Service({ logger } as any, options).deliverOrderPublication(
    "jitsu",
    { ...event, event: "order_finalized" }
  );
  expect(
    JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).event_type
  ).toBe("order_finalized");
});

const rehearsalOptions = {
  ...options,
  rehearsal: {
    id: "launch-test",
    jitsuHost: "https://jitsu-rehearsal.example.invalid",
    jitsuServerSecret: "jitsu-rehearsal-key",
    gpAnalyticsEndpoint: "https://gp-rehearsal.example.invalid",
    gpAnalyticsServerKey: "gp-rehearsal-key",
  },
};
const testEvent = {
  ...event,
  properties: { ...event.properties, test_order: true },
};
it.each([
  "order_canceled",
  "fulfillment_created",
  "order_shipped",
  "order_delivered",
  "return_created",
  "order_refunded",
])(
  "delivers %s through the same classified durable transport",
  async (name) => {
    const service = new Service({ logger } as any, options);
    await service.deliverOrderPublication("gp_analytics", {
      ...event,
      event: name,
    });
    const payload = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body
    );
    expect(payload.event).toBe(name);
    expect(payload.properties.test_order).toBe(false);
    expect(
      await service.deliverOrderPublication("jitsu", {
        ...testEvent,
        event: name,
      })
    ).toEqual({ status: "excluded", reason: "test_order" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  }
);
it.each(["jitsu_rehearsal", "gp_analytics_rehearsal"] as const)(
  "keeps test flags and stable identity through %s with no production fallback",
  async (target) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        "x-gp-analytics-environment": "rehearsal",
        "x-gp-rehearsal-id": "launch-test",
      }),
    }) as any;
    const service = new Service({ logger } as any, rehearsalOptions);
    expect(await service.deliverOrderPublication(target, testEvent)).toEqual({
      status: "accepted",
    });
    await service.deliverOrderPublication(target, testEvent);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toContain("-rehearsal.example.invalid/");
    expect(calls[0][1].redirect).toBe("error");
    expect(calls[0][1].body).toBe(calls[1][1].body);
    const envelope = JSON.parse(calls[0][1].body);
    expect(envelope.eventn_ctx || envelope.properties).toMatchObject({
      test_order: true,
      analytics_environment: "rehearsal",
      rehearsal_id: "launch-test",
      value: 0,
    });
    expect(testEvent.properties).not.toHaveProperty("analytics_environment");
  }
);
it.each(["jitsu", "gp_analytics"] as const)(
  "refuses test orders on production %s even when called directly",
  async (target) => {
    expect(
      await new Service(
        { logger } as any,
        rehearsalOptions
      ).deliverOrderPublication(target, testEvent)
    ).toEqual({ status: "excluded", reason: "test_order" });
    expect(global.fetch).not.toHaveBeenCalled();
  }
);
it.each(["jitsu_rehearsal", "gp_analytics_rehearsal"] as const)(
  "refuses production orders on %s",
  async (target) => {
    expect(
      await new Service(
        { logger } as any,
        rehearsalOptions
      ).deliverOrderPublication(target, event)
    ).toEqual({ status: "excluded", reason: "production_order" });
    expect(global.fetch).not.toHaveBeenCalled();
  }
);
it("holds absent, same-origin, same-key and malformed rehearsal routes without sending", async () => {
  for (const rehearsal of [
    undefined,
    {
      ...rehearsalOptions.rehearsal,
      gpAnalyticsEndpoint: options.gpAnalyticsEndpoint + "/test",
    },
    {
      ...rehearsalOptions.rehearsal,
      gpAnalyticsServerKey: options.gpAnalyticsServerKey,
    },
    { ...rehearsalOptions.rehearsal, id: "../production" },
  ]) {
    expect(
      await new Service({ logger } as any, {
        ...options,
        rehearsal,
      }).deliverOrderPublication("gp_analytics_rehearsal", testEvent)
    ).toMatchObject({ status: "held" });
  }
  expect(global.fetch).not.toHaveBeenCalled();
});
it("does not accept a 2xx from a receiver with the wrong rehearsal identity", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ "x-gp-analytics-environment": "production" }),
  }) as any;
  await expect(
    new Service({ logger } as any, rehearsalOptions).deliverOrderPublication(
      "gp_analytics_rehearsal",
      testEvent
    )
  ).rejects.toThrow("rehearsal_receiver_not_acknowledged");
});
it.each([
  { analytics_consent: false },
  { analytics_consent: null },
  { experiment_context_status: "unverified" },
  { test_order: null },
])("preserves measurement eligibility for rehearsal %j", async (patch) => {
  expect(
    await new Service(
      { logger } as any,
      rehearsalOptions
    ).deliverOrderPublication("gp_analytics_rehearsal", {
      ...testEvent,
      properties: { ...testEvent.properties, ...patch },
    })
  ).not.toMatchObject({ status: "accepted" });
  expect(global.fetch).not.toHaveBeenCalled();
});
