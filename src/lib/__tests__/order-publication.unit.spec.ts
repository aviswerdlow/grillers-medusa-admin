import {
  originalPublicationProperties,
  publicationEligibility,
  publicationIdentity,
} from "../order-publication";
import { orderPromiseHash } from "../order-promise";
import { promiseFixture, promiseNow } from "./fixtures/order-promise";

function row(value = 91.25) {
  const promise = { ...promiseFixture(), placement_total: value };
  return {
    order_id: "order_1",
    customer_id: promise.customer_id,
    promise,
    content_hash: orderPromiseHash(promise),
    revision: 1,
    accepted_at: promiseNow,
    placed_at: promiseNow,
  };
}
it.each([0, 91.25])(
  "uses original value %s and a privacy allowlist",
  (value) => {
    const p = originalPublicationProperties({
      ...row(value),
      total: 999,
      metadata: { final_total: 888 },
    });
    expect(p.value).toBe(value);
    expect(p.amount_unit).toBe("major");
    expect(p.amount_basis).toBe("accepted_placement_estimate_v1");
    expect(p.payment_evidence).toBe("not_implied_by_placement");
    expect(p.experiment_context.synthetic_experiment.variant_key).toBe(
      "control"
    );
    expect(JSON.stringify(p)).not.toMatch(
      /example.invalid|qbd_list_id|8000-FIXTURE|Fixture Road|receipt_email|payment_consent_text|shipping_address/
    );
  }
);
it("refuses a corrupted immutable record", () =>
  expect(() =>
    originalPublicationProperties({ ...row(), content_hash: "wrong" })
  ).toThrow("order_promise_evidence_invalid"));
it("uses separate fixed placement and finalization identities", () =>
  expect(publicationIdentity("placed", "o1")).not.toBe(
    publicationIdentity("finalized", "o1")
  ));
const eligible = {
  test_order: false,
  analytics_consent: true,
  experiment_context_status: "complete",
  experiment_assignments: [],
};
it.each([
  [{ test_order: true }, "excluded", "test_order"],
  [{ test_order: null }, "held", "test_classification_unknown"],
  [{ analytics_consent: false }, "excluded", "analytics_opt_out"],
  [{ analytics_consent: null }, "held", "analytics_consent_unknown"],
  [
    { experiment_context_status: "unverified" },
    "held",
    "experiment_context_unknown",
  ],
  [
    { experiment_assignments: [{ version: null }] },
    "held",
    "experiment_context_unknown",
  ],
])("preserves test/consent/context exclusion %j", (patch, status, reason) =>
  expect(publicationEligibility("jitsu", { ...eligible, ...patch })).toEqual({
    status,
    reason,
  })
);
it("records operational truth without granting analytics or marketing consent", () => {
  expect(
    publicationEligibility("communications", {
      test_order: null,
      analytics_consent: false,
    })
  ).toBeNull();
  expect(
    publicationEligibility("communications_automation", { test_order: true })
  ).toEqual({ status: "excluded", reason: "test_order" });
  expect(publicationEligibility("jitsu", eligible)).toBeNull();
});
