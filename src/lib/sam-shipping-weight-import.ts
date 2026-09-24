import { createHash } from "node:crypto";
import {
  SHIPPING_WEIGHT_KEY,
  shippingListId,
  shippingMetadata,
  validateShippingWeightRecord,
  type ShippingWeightRecord,
} from "./shipping-weights";

export type SamWeightRow = {
  ID: string | number;
  LISTID: string;
  SHIPWEIGHT: string | null;
  TIMEMODIFIED: string | null;
};
export type WeightImportVariant = {
  id: string;
  sku?: string;
  metadata?: unknown;
  product?: { metadata?: unknown };
};
export type WeightReview = {
  record: ShippingWeightRecord;
  replaces_record_sha256?: string;
};
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const weightImportHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const samWeightRevision = (row: SamWeightRow) =>
  weightImportHash([
    String(row.ID),
    row.LISTID,
    row.SHIPWEIGHT,
    row.TIMEMODIFIED,
  ]);

export type WeightImportEntry = {
  variantId: string;
  listId: string | null;
  status:
    | "changed"
    | "unchanged"
    | "unmatched"
    | "ambiguous"
    | "excluded_internal"
    | "pending_review"
    | "preserved_override"
    | "invalid_review";
  reason?: string;
  before: Record<string, any>;
  after?: Record<string, any>;
  rawSamValue?: string | null;
  sourceRevision?: string;
};
export type WeightImportPlan = {
  version: 1;
  id: string;
  sourceSha256: string;
  entries: WeightImportEntry[];
  counts: Record<string, number>;
};

/** No SKU/name joins and no assumption that a pound-labelled SAM value is mass.
 * Only an explicit, source-revision-matched review can produce a write. */
export function planSamWeightImport(
  rows: SamWeightRow[],
  variants: WeightImportVariant[],
  reviews: WeightReview[],
): WeightImportPlan {
  const byList = new Map<string, SamWeightRow[]>(),
    byReview = new Map<string, WeightReview[]>();
  for (const row of rows)
    if (row.LISTID?.trim())
      byList.set(row.LISTID.trim(), [
        ...(byList.get(row.LISTID.trim()) ?? []),
        row,
      ]);
  for (const review of reviews)
    byReview.set(review.record.qbd_list_id, [
      ...(byReview.get(review.record.qbd_list_id) ?? []),
      review,
    ]);
  const targetCounts = new Map<string, number>();
  for (const v of variants) {
    const id =
      shippingListId(v.metadata) ?? shippingListId(v.product?.metadata);
    if (id) targetCounts.set(id, (targetCounts.get(id) ?? 0) + 1);
  }
  const entries = variants.map((variant): WeightImportEntry => {
    const before = shippingMetadata(variant.metadata),
      product = shippingMetadata(variant.product?.metadata);
    const listId = shippingListId(before) ?? shippingListId(product),
      base = { variantId: variant.id, listId, before };
    if (
      /^RM-/i.test(variant.sku ?? "") ||
      [before.availability_lifecycle, product.availability_lifecycle].includes(
        "internal_only",
      )
    )
      return { ...base, status: "excluded_internal" };
    const matches = listId ? (byList.get(listId) ?? []) : [];
    if (!matches.length) return { ...base, status: "unmatched" };
    if (
      matches.length !== 1 ||
      targetCounts.get(listId!) !== 1 ||
      (byReview.get(listId!)?.length ?? 0) > 1
    )
      return { ...base, status: "ambiguous" };
    const row = matches[0],
      sourceRevision = samWeightRevision(row),
      rawSamValue = row.SHIPWEIGHT;
    const details = { ...base, rawSamValue, sourceRevision },
      review = byReview.get(listId!)?.[0];
    const current = before[SHIPPING_WEIGHT_KEY];
    if (!review)
      return {
        ...details,
        status:
          current?.review_status === "approved"
            ? "preserved_override"
            : "pending_review",
      };
    try {
      const record = validateShippingWeightRecord(review.record, listId!);
      if (record.kind === "internal")
        return { ...details, status: "excluded_internal" };
      if (
        record.source_revision !== sourceRevision ||
        record.source_item_id !== String(row.ID) ||
        record.raw_sam_value !== row.SHIPWEIGHT
      )
        return {
          ...details,
          status: "invalid_review",
          reason: "source_changed_since_review",
        };
      if (weightImportHash(current ?? null) === weightImportHash(record))
        return { ...details, status: "unchanged" };
      if (
        current?.review_status === "approved" &&
        review.replaces_record_sha256 !== weightImportHash(current)
      )
        return {
          ...details,
          status: "preserved_override",
          reason: "explicit_replacement_review_required",
        };
      return {
        ...details,
        status: "changed",
        after: { ...before, [SHIPPING_WEIGHT_KEY]: record },
      };
    } catch (error) {
      return {
        ...details,
        status: "invalid_review",
        reason: (error as any)?.code ?? "invalid_record",
      };
    }
  });
  const counts = entries.reduce<Record<string, number>>((out, entry) => {
    out[entry.status] = (out[entry.status] ?? 0) + 1;
    return out;
  }, {});
  const sourceSha256 = weightImportHash(rows);
  return {
    version: 1,
    id: weightImportHash({ sourceSha256, entries }),
    sourceSha256,
    entries,
    counts,
  };
}

export type WeightImportReceipt = {
  version: 1;
  planId: string;
  verified: true;
  variantIds: string[];
  beforeAfter: Array<{ variantId: string; before: unknown; after: unknown }>;
};
export function selectWeightImportWrites(
  plan: WeightImportPlan,
  options: {
    expectedPlanId: string;
    canaryVariantId?: string;
    canaryReceipt?: WeightImportReceipt;
  },
): WeightImportEntry[] {
  if (options.expectedPlanId !== plan.id)
    throw new Error("Dry-run plan changed; review a fresh plan before writing");
  const changes = plan.entries.filter((e) => e.status === "changed");
  if (
    plan.entries.some((e) =>
      ["ambiguous", "unmatched", "invalid_review"].includes(e.status),
    )
  )
    throw new Error(
      "Resolve invalid or ambiguous identities/reviews before writing",
    );
  if (options.canaryVariantId) {
    const entry = changes.find((e) => e.variantId === options.canaryVariantId);
    if (!entry)
      throw new Error("Canary must be exactly one changed, approved variant");
    return [entry];
  }
  const receipt = options.canaryReceipt;
  if (
    !receipt ||
    receipt.version !== 1 ||
    !receipt.verified ||
    receipt.planId !== plan.id ||
    receipt.variantIds.length !== 1 ||
    !receipt.beforeAfter.some(
      (row) =>
        row.variantId === receipt.variantIds[0] &&
        changes.some(
          (e) =>
            e.variantId === row.variantId &&
            weightImportHash(row.after) === weightImportHash(e.after),
        ),
    )
  )
    throw new Error(
      "Batch requires a verified canary receipt for this exact plan",
    );
  return changes.filter((e) => !receipt.variantIds.includes(e.variantId));
}

/** Atomic compare-and-swap of this namespace only. A concurrent editor or A3
 * metadata update makes the write fail; it is never overwritten or retried. */
export async function applyWeightImportEntries(
  db: any,
  plan: WeightImportPlan,
  entries: WeightImportEntry[],
  onBeforeWrite: (receipt: unknown) => Promise<void>,
): Promise<WeightImportReceipt> {
  const beforeAfter: WeightImportReceipt["beforeAfter"] = [];
  for (const entry of entries) {
    if (entry.status !== "changed" || !entry.after)
      throw new Error("Only approved changed entries may be written");
    await onBeforeWrite({
      version: 1,
      planId: plan.id,
      variantId: entry.variantId,
      before: entry.before,
      after: entry.after,
      status: "prepared",
    });
    await db.transaction(async (trx: any) => {
      const current = await trx("product_variant")
        .select("metadata")
        .where({ id: entry.variantId })
        .whereNull("deleted_at")
        .forUpdate()
        .first();
      if (
        !current ||
        weightImportHash(shippingMetadata(current.metadata)) !==
          weightImportHash(entry.before)
      )
        throw new Error(
          "Variant metadata changed after dry run; no write performed",
        );
      // JSON serialization keys may arrive in a different order from PostgreSQL;
      // the locked row prevents intervening writes while preserving other keys.
      const after = {
        ...shippingMetadata(current.metadata),
        [SHIPPING_WEIGHT_KEY]: entry.after![SHIPPING_WEIGHT_KEY],
      };
      await trx("product_variant")
        .where({ id: entry.variantId })
        .update({ metadata: JSON.stringify(after), updated_at: new Date() });
      const readback = await trx("product_variant")
        .select("metadata")
        .where({ id: entry.variantId })
        .first();
      if (
        weightImportHash(shippingMetadata(readback?.metadata)) !==
        weightImportHash(after)
      )
        throw new Error(
          "Weight write readback failed; transaction rolled back",
        );
      beforeAfter.push({
        variantId: entry.variantId,
        before: entry.before,
        after,
      });
    });
  }
  return {
    version: 1,
    planId: plan.id,
    verified: true,
    variantIds: entries.map((e) => e.variantId),
    beforeAfter,
  };
}
