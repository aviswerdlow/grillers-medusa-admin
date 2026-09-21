import { completeCartWorkflow } from "@medusajs/core-flows";
import { bindOrderPromise } from "../order-promise";
import { ensureFinalizationForOrder } from "../catch-weight-finalization";
import { completeReviewedCart } from "../order-review-completion";
import { completedPromiseCart } from "./fixtures/order-promise";
jest.mock("@medusajs/core-flows", () => ({ completeCartWorkflow: jest.fn() }));
jest.mock("../order-promise", () => ({
  ...jest.requireActual("../order-promise"),
  bindOrderPromise: jest.fn(),
}));
jest.mock("../catch-weight-finalization", () => ({
  ensureFinalizationForOrder: jest.fn(),
}));
const scope: any = {
  resolve: (key: string) =>
    key === "query"
      ? { graph: async () => ({ data: [{ id: "order_promise" }] }) }
      : "isolated-db",
};
beforeEach(() => {
  jest.clearAllMocks();
  (bindOrderPromise as jest.Mock).mockResolvedValue({});
  (ensureFinalizationForOrder as jest.Mock).mockResolvedValue({});
});
test("uses the actual native return and binds before initializing packing", async () => {
  const native = completedPromiseCart(),
    run = jest.fn(async () => native);
  (completeCartWorkflow as unknown as jest.Mock).mockReturnValue({ run });
  expect(await completeReviewedCart(scope, "cart_promise")).toBe(native);
  expect(bindOrderPromise).toHaveBeenCalledWith(
    "isolated-db",
    "cart_promise",
    native
  );
  expect(
    (bindOrderPromise as jest.Mock).mock.invocationCallOrder[0]
  ).toBeLessThan(
    (ensureFinalizationForOrder as jest.Mock).mock.invocationCallOrder[0]
  );
  expect(run).toHaveBeenCalledWith({
    input: { id: "cart_promise" },
    context: { transactionId: "cart_promise" },
    throwOnError: false,
  });
});
test("native failure never becomes a binding or packing record", async () => {
  (completeCartWorkflow as unknown as jest.Mock).mockReturnValue({
    run: async () => ({ errors: [{ error: new Error("synthetic failure") }] }),
  });
  await completeReviewedCart(scope, "cart_promise");
  expect(bindOrderPromise).not.toHaveBeenCalled();
  expect(ensureFinalizationForOrder).not.toHaveBeenCalled();
});
test("an uncertain binding leaves recovery explicit without another native call", async () => {
  const run = jest.fn(async () => completedPromiseCart());
  (completeCartWorkflow as unknown as jest.Mock).mockReturnValue({ run });
  (bindOrderPromise as jest.Mock).mockRejectedValue(
    new Error("database interruption")
  );
  await expect(
    completeReviewedCart(scope, "cart_promise")
  ).rejects.toMatchObject({
    code: "order_review_completion_recovery_required",
    status: 503,
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(ensureFinalizationForOrder).not.toHaveBeenCalled();
});

test("legacy completion needs no review binding but still initializes finalization", async () => {
  (completeCartWorkflow as unknown as jest.Mock).mockReturnValue({
    run: async () => completedPromiseCart(),
  });
  await completeReviewedCart(scope, "cart_promise", { requireReview: false });
  expect(bindOrderPromise).not.toHaveBeenCalled();
  expect(ensureFinalizationForOrder).toHaveBeenCalled();
});
test("a promise copied by native completion cannot be dropped by a legacy request", async () => {
  (completeCartWorkflow as unknown as jest.Mock).mockReturnValue({
    run: async () => completedPromiseCart(),
  });
  const concurrentScope = {
    resolve: (key: string) =>
      key === "query"
        ? {
            graph: async () => ({
              data: [
                {
                  id: "order_promise",
                  metadata: {
                    gp_order_promise_snapshot_id: "accepted_fixture",
                  },
                },
              ],
            }),
          }
        : "isolated-db",
  };
  await completeReviewedCart(concurrentScope, "cart_promise", {
    requireReview: false,
  });
  expect(bindOrderPromise).toHaveBeenCalled();
  expect(ensureFinalizationForOrder).toHaveBeenCalled();
});
