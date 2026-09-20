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
    global.fetch = jest
      .fn()
      .mockResolvedValue({
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
