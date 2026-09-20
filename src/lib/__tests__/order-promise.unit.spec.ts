import {
  completedCartEvidence,
  normalizedOrderPromise,
  orderPromiseAnalytics,
  orderPromiseHash,
} from "../order-promise";
import {
  promiseFixture,
  completedPromiseCart,
  promiseNow,
} from "./fixtures/order-promise";

describe("accepted-order promise contract", () => {
  it("detaches the complete promise and normalizes map and line ordering", () => {
    const first = promiseFixture();
    first.lines.push({ ...first.lines[0], cart_line_id: "a_second" });
    const other = JSON.parse(JSON.stringify(first));
    other.lines.reverse();
    other.fulfillment.packing_plan = {
      revision: "synthetic-packing-1",
      id: "synthetic-packing-plan",
    };
    const frozen = normalizedOrderPromise(first);
    expect(orderPromiseHash(first)).toBe(orderPromiseHash(other));
    first.contact.receipt_email = "later@example.invalid";
    first.fulfillment.packing_plan!.revision = "changed";
    expect(frozen.contact.receipt_email).toBe("receipt@example.invalid");
    expect(frozen.fulfillment.packing_plan!.revision).toBe(
      "synthetic-packing-1"
    );
    expect(orderPromiseHash(first)).not.toBe(orderPromiseHash(frozen));
  });
  it.each([NaN, Infinity, -1, 1.001, 1e20, "91.25", null])(
    "rejects ambiguous/invalid money %s",
    (value) => {
      expect(() =>
        normalizedOrderPromise({ ...promiseFixture(), placement_total: value })
      ).toThrow("order_review_incomplete");
    }
  );
  it("preserves zero totals and rejects absent totals instead of guessing", () => {
    expect(
      normalizedOrderPromise({ ...promiseFixture(), placement_total: 0 })
        .placement_total
    ).toBe(0);
    expect(() =>
      normalizedOrderPromise({
        ...promiseFixture(),
        placement_total: undefined,
      })
    ).toThrow("order_review_incomplete");
  });
  it("requires real calendar dates, a unique line identity and explicit catch-weight basis", () => {
    const p = promiseFixture();
    p.fulfillment.arrival_date = "2026-02-30";
    expect(() => normalizedOrderPromise(p)).toThrow("order_review_incomplete");
    const duplicate = promiseFixture();
    duplicate.lines.push({ ...duplicate.lines[0] });
    expect(() => normalizedOrderPromise(duplicate)).toThrow(
      "order_review_incomplete"
    );
    const weight = promiseFixture();
    weight.lines[0].estimated_weight_lb = null;
    expect(() => normalizedOrderPromise(weight)).toThrow(
      "order_review_incomplete"
    );
  });
  it("requires payment terms and rejects private values that JSON would silently discard", () => {
    const invoice = promiseFixture();
    invoice.terms.payment_mode = "invoice";
    expect(() => normalizedOrderPromise(invoice)).toThrow(
      "order_review_incomplete"
    );
    invoice.terms.invoice_terms = "Synthetic approved terms";
    expect(normalizedOrderPromise(invoice).terms.payment_mode).toBe("invoice");
    const p = promiseFixture();
    (p.fulfillment.packing_plan as any).ambiguous = undefined;
    expect(() => normalizedOrderPromise(p)).toThrow("order_review_incomplete");
  });
  it("never exports private evidence or payment claims in the analytics allowlist", () => {
    const promise = promiseFixture();
    const row = {
      promise,
      content_hash: orderPromiseHash(promise),
      order_id: "order_promise",
      revision: 1,
      accepted_at: promiseNow,
      placed_at: promiseNow,
    };
    const analytics = orderPromiseAnalytics(row);
    expect(Object.keys(analytics).sort()).toEqual(
      [
        "order_id",
        "accepted_revision",
        "accepted_at",
        "placed_at",
        "amount_basis",
        "amount_unit",
        "currency",
        "placement_total",
        "calendar_revision",
        "review_version",
        "experiment_assignments",
        "experiment_context_status",
        "analytics_consent",
        "test_order",
      ].sort()
    );
    expect(analytics.placement_total).toBe(91.25);
    expect(analytics.analytics_consent).toBe(false);
    expect(JSON.stringify(analytics)).not.toMatch(
      /example.invalid|2025550123|Fixture Road|8000-FIXTURE|gprs_fixture|Synthetic roast/
    );
    expect(() =>
      orderPromiseAnalytics({ ...row, order_id: undefined })
    ).toThrow("order_promise_original_unavailable");
    expect(() =>
      orderPromiseAnalytics({
        ...row,
        promise: { ...promise, placement_total: 0 },
      })
    ).toThrow("order_promise_evidence_invalid");
  });
  it.each(["invoking", "failed", "reverted", "waiting_to_compensate"])(
    "does not bind native completion state %s",
    (state) => {
      const completion = completedPromiseCart();
      completion.transaction.getState = () => state;
      expect(() => completedCartEvidence("cart_promise", completion)).toThrow(
        "order_promise_completion_unconfirmed"
      );
    }
  );
  it.each([
    "missing",
    "event",
    "wrong cart",
    "wrong workflow",
    "errors",
    "unfinished",
    "wrong payload",
    "missing run",
  ])("rejects %s completion evidence", (kind) => {
    let completion: any = completedPromiseCart();
    if (kind === "missing") completion = null;
    if (kind === "event") completion = { id: "order_promise" };
    if (kind === "wrong cart")
      completion.transaction.transactionId = "cart_other";
    if (kind === "wrong workflow")
      completion.transaction.modelId = "create-order";
    if (kind === "errors")
      completion.errors = [{ error: new Error("synthetic failure") }];
    if (kind === "unfinished") completion.transaction.hasFinished = () => false;
    if (kind === "wrong payload")
      completion.transaction.payload.id = "cart_other";
    if (kind === "missing run") completion.transaction.runId = "";
    expect(() => completedCartEvidence("cart_promise", completion)).toThrow(
      "order_promise_completion_unconfirmed"
    );
  });
  it("retains the successful native order and run IDs", () => {
    expect(
      completedCartEvidence("cart_promise", completedPromiseCart())
    ).toEqual({ orderId: "order_promise", runId: "run_fixture" });
  });
  it("accepts the persisted input of a recovered native transaction", () => {
    const completion: any = completedPromiseCart();
    completion.transaction.payload = undefined;
    completion.transaction.getContext = () => ({
      payload: { id: "cart_promise" },
    });
    expect(completedCartEvidence("cart_promise", completion).orderId).toBe(
      "order_promise"
    );
  });
});
