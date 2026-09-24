import { createHmac } from "node:crypto";
import { acceptedExperimentContext } from "../analytics/accepted-experiment-context";
import { orderPromiseHash, orderPromiseAnalytics, normalizedOrderPromise } from "../order-promise";
import { promiseFixture } from "./fixtures/order-promise";
import fixture from "./fixtures/experiment-evidence.json";

const oldKeys = process.env.GP_EXPERIMENT_EVIDENCE_KEYS;
beforeEach(() => { process.env.GP_EXPERIMENT_EVIDENCE_KEYS = JSON.stringify({ "fixture-key": fixture.secret }); });
afterEach(() => { if (oldKeys === undefined) delete process.env.GP_EXPERIMENT_EVIDENCE_KEYS; else process.env.GP_EXPERIMENT_EVIDENCE_KEYS = oldKeys; });
const line = () => ({ metadata: JSON.parse(JSON.stringify(fixture.metadata)) });
const assignment = () => line().metadata.experiment_context.synthetic_launch;

test("accepts the exact frontend-issued fixture and exports no identity or signature", () => {
  const value = acceptedExperimentContext([line()]);
  expect(value).toEqual({ experiment_context_status: "complete", experiment_assignments: [{
    experiment_id: "synthetic_launch", variant: "test", assignment_id: fixture.issued.assignmentId,
    version: fixture.issued.version, evaluation_version: fixture.issued.evaluationVersion,
  }] });
  expect(JSON.stringify(value)).not.toMatch(/version_signature|version_key_id|release_id|synthetic-only/);
});
test.each(["variant_key", "assignment_id", "version", "evaluation_version", "release_id", "version_signature", "version_key_id"])("a changed %s cannot create verified context", field => {
  const input = line(); input.metadata.experiment_context.synthetic_launch[field] = "tampered";
  const result = acceptedExperimentContext([input]);
  expect(result.experiment_context_status).toBe("unverified");
  expect(result.experiment_assignments).toHaveLength(1);
  expect(result.experiment_assignments[0].version).toBeNull();
});
test.each([undefined, "not-json", "{}", '{"fixture-key":"short"}'])("unavailable key configuration stays unknown (%s)", value => {
  if (value === undefined) delete process.env.GP_EXPERIMENT_EVIDENCE_KEYS; else process.env.GP_EXPERIMENT_EVIDENCE_KEYS = value;
  expect(acceptedExperimentContext([line()])).toMatchObject({ experiment_context_status: "unverified", experiment_assignments: [{ version: null }] });
});
test("a repeated identical assignment is one assignment", () => {
  expect(acceptedExperimentContext([line(), line()]).experiment_assignments).toHaveLength(1);
  expect(acceptedExperimentContext([line(), line()]).experiment_context_status).toBe("complete");
});
test("two valid conflicting assignments cannot disappear into an empty experiment set", () => {
  const other = line(); const v = other.metadata.experiment_context.synthetic_launch;
  v.variant_key = "control"; v.assignment_id = "other-assignment";
  v.version_signature = createHmac("sha256", fixture.secret).update(JSON.stringify(["gp-experiment-evidence-v1", "synthetic_launch", v.variant_key, v.assignment_id, v.version, v.evaluation_version, v.release_id])).digest("hex");
  const result = acceptedExperimentContext([line(), other, line()]);
  expect(result.experiment_context_status).toBe("unverified");
  expect(result.experiment_assignments).toHaveLength(1);
  expect(result.experiment_assignments[0]).toMatchObject({ version: null, evaluation_version: null });
});
test.each([undefined, null, "not-json", [], { bad: { variant_key: "b" } }])("missing/malformed context remains unverified (%s)", context => {
  expect(acceptedExperimentContext([{ metadata: { experiment_context_status: "complete", experiment_context: context } }]).experiment_context_status).toBe("unverified");
});
test("a missing line marker, truncated context or old unsigned record stays unknown", () => {
  const missing = line(); delete missing.metadata.experiment_context_status;
  expect(acceptedExperimentContext([missing]).experiment_context_status).toBe("unverified");
  const truncated = line(); truncated.metadata.experiment_context_status = "unverified";
  expect(acceptedExperimentContext([truncated]).experiment_context_status).toBe("unverified");
  const unsigned = line(); delete unsigned.metadata.experiment_context.synthetic_launch.version_signature;
  expect(acceptedExperimentContext([unsigned]).experiment_assignments[0].version).toBeNull();
});
test("an explicitly observed empty context is distinct from absent historical evidence", () => {
  expect(acceptedExperimentContext([{ metadata: { experiment_context_status: "complete", experiment_context: {} } }])).toEqual({ experiment_context_status: "complete", experiment_assignments: [] });
  expect(acceptedExperimentContext([{ metadata: {} }])).toEqual({ experiment_context_status: "unverified", experiment_assignments: [] });
});
test("oversized input remains bounded and explicitly incomplete", () => {
  const context = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`exp_${i}`, assignment()]));
  const value = acceptedExperimentContext([{ metadata: { experiment_context_status: "complete", experiment_context: context } }]);
  expect(value.experiment_assignments.length).toBeLessThanOrEqual(100);
  expect(value.experiment_context_status).toBe("unverified");
});
test("new attribution changes the immutable hash; old records remain valid and unknown", () => {
  const legacy = promiseFixture();
  const before = orderPromiseHash(legacy);
  // Captured from PR41 before adding the optional context-status field.
  expect(before).toBe("a54cb7b54cc6bad6bd570f38595551ff68b0778bfcc6d9a87097b72564c44510");
  expect(normalizedOrderPromise(legacy).attribution).not.toHaveProperty("experiment_context_status");
  const original = { promise: legacy, content_hash: before, order_id: "order_fixture", revision: 1, accepted_at: "2026-09-20T00:00:00Z", placed_at: "2026-09-20T00:01:00Z" };
  expect(orderPromiseAnalytics(original).experiment_context_status).toBeNull();
  const current = { ...legacy, attribution: { ...legacy.attribution, ...acceptedExperimentContext([line()]) } };
  expect(orderPromiseHash(current)).not.toBe(before);
  expect(orderPromiseHash(legacy)).toBe(before);
});
