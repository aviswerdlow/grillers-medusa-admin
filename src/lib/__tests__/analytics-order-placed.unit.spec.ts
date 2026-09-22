const request = jest.fn();
const alert = jest.fn().mockResolvedValue({ ok: true });
jest.mock("../order-publication", () => ({
  requestOrderPublication: (...args: any[]) => request(...args),
}));
jest.mock("../ops-alert", () => ({
  emitOpsAlert: (...args: any[]) => alert(...args),
}));
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import handler from "../../subscribers/analytics/order-placed";
import communicationsHandler, {
  config as commsConfig,
} from "../../subscribers/communications-commerce-events";

const db = {},
  logger = { error: jest.fn() };
const resolve = jest.fn((key: string) => {
  if (key === "logger") return logger;
  if (key === ContainerRegistrationKeys.PG_CONNECTION) return db;
  throw new Error(`Unexpected mutable query or transport: ${key}`);
});
beforeEach(() => {
  jest.clearAllMocks();
  request.mockResolvedValue(undefined);
});
it("records source intent before binding without querying mutable totals or contacting analytics", async () => {
  await handler({
    event: { name: "order.placed", data: { id: "order_1" } },
    container: { resolve },
  } as any);
  expect(request).toHaveBeenCalledWith(db, "placed", "order_1", undefined);
  expect(resolve.mock.calls.flat()).not.toContain("analytics");
  expect(resolve.mock.calls.flat()).not.toContain("query");
});
it("routes a final charge only to a distinct finalization intent", async () => {
  await handler({
    event: {
      name: "order.final_charge_succeeded",
      data: {
        id: "order_1",
        order_id: "order_1",
        finalization_id: "final_1",
        amount: 130,
      },
    },
    container: { resolve },
  } as any);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(db, "finalized", "order_1", "final_1");
});
it("retains subscriber retry on database failure without exposing raw errors", async () => {
  request.mockRejectedValue(new Error("secret@example.invalid"));
  await expect(
    handler({
      event: { name: "order.placed", data: { id: "order_1" } },
      container: { resolve },
    } as any)
  ).rejects.toThrow("order_publication_intent_not_recorded");
  expect(alert).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(alert.mock.calls)).not.toContain(
    "secret@example.invalid"
  );
});
it.each([
  "order.placed",
  "order.final_charge_succeeded",
  "order.canceled",
  "order.fulfilled",
  "shipment.created",
  "delivery.created",
  "payment.refunded",
])("disables the old communications order producer for %s", async (name) => {
  expect(commsConfig.event).not.toContain(name);
  await communicationsHandler({
    event: { name, data: { id: "order_1" } },
    container: { resolve },
  } as any);
  expect(resolve).not.toHaveBeenCalled();
});
