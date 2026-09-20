import { createHmac, timingSafeEqual } from "node:crypto";

const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 500;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
type Assignment = { experiment_id: string; variant: string; assignment_id: string; version: string | null; evaluation_version: string | null };

function verified(experimentId: string, value: Record<string, any>): boolean {
  try {
    const secret = JSON.parse(process.env.GP_EXPERIMENT_EVIDENCE_KEYS || "{}")[value.version_key_id];
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32
      || !/^[a-f0-9]{64}$/.test(value.version || "") || !/^[a-f0-9]{64}$/.test(value.evaluation_version || "")
      || !/^[a-f0-9]{40}$/.test(value.release_id || "") || !/^[a-f0-9]{64}$/.test(value.version_signature || "")) return false;
    const payload = JSON.stringify(["gp-experiment-evidence-v1", experimentId, value.variant_key, value.assignment_id, value.version, value.evaluation_version, value.release_id]);
    const expected = createHmac("sha256", secret).update(payload).digest();
    return timingSafeEqual(expected, Buffer.from(value.version_signature, "hex"));
  } catch { return false; }
}

/** Preserve uncertainty without stopping commerce. Missing/invalid/conflicting
 * line evidence must never collapse to a verified empty assignment set. */
export function acceptedExperimentContext(items: any[]) {
  let status: "complete" | "unverified" = items.length ? "complete" : "unverified";
  const assignments = new Map<string, Assignment>();
  const conflicts = new Set<string>();
  for (const item of items) {
    if (item?.metadata?.experiment_context_status !== "complete") status = "unverified";
    let context = item?.metadata?.experiment_context;
    try { if (typeof context === "string") context = JSON.parse(context); }
    catch { status = "unverified"; continue; }
    if (!record(context)) { status = "unverified"; continue; }
    const entries = Object.entries(context);
    if (entries.length > 100) status = "unverified";
    for (const [experiment_id, v] of entries.slice(0, 100)) {
      if (!text(experiment_id) || !record(v) || !text(v.variant_key) || !text(v.assignment_id)) {
        status = "unverified"; continue;
      }
      const valid = verified(experiment_id, v);
      if (!valid) status = "unverified";
      const candidate: Assignment = { experiment_id, variant: v.variant_key, assignment_id: v.assignment_id,
        version: valid ? v.version : null, evaluation_version: valid ? v.evaluation_version : null };
      const previous = assignments.get(experiment_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) conflicts.add(experiment_id);
      if (!previous && assignments.size < 100) assignments.set(experiment_id, candidate);
      else if (!previous) status = "unverified";
    }
  }
  for (const id of conflicts) {
    const row = assignments.get(id)!;
    row.version = null; row.evaluation_version = null;
    status = "unverified";
  }
  return { experiment_assignments: [...assignments.values()].sort((a, b) => a.experiment_id.localeCompare(b.experiment_id)), experiment_context_status: status };
}
