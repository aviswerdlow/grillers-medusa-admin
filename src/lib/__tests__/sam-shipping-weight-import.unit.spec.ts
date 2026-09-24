import {
  planSamWeightImport,
  samWeightRevision,
  weightImportHash,
  selectWeightImportWrites,
  applyWeightImportEntries,
} from "../sam-shipping-weight-import";
import { SHIPPING_WEIGHT_KEY } from "../shipping-weights";
import { weightRecord } from "./__fixtures__/shipping-inputs";

const row = {
  ID: "fixture-item",
  LISTID: "fixture-list-id",
  SHIPWEIGHT: "6.00",
  TIMEMODIFIED: "2026-09-19T00:00:00Z",
};
const variant = {
  id: "variant_fixture",
  sku: "renamed-sku",
  metadata: {
    qbd_list_id: row.LISTID,
    editorial: "Preserve",
    price_override: 12,
    availability_lifecycle: "active",
  },
};
const review = () => ({
  record: weightRecord({ source_revision: samWeightRevision(row) }),
});
describe("SAM shipping-weight dry run and controlled writes", () => {
  test("has no writes without review and matches renamed SKU only by ListID", () => {
    expect(planSamWeightImport([row], [variant], []).counts).toEqual({
      pending_review: 1,
    });
    const plan = planSamWeightImport([row], [variant], [review()]);
    expect(plan.counts).toEqual({ changed: 1 });
    expect(plan.entries[0].after).toMatchObject(variant.metadata);
    expect(plan.entries[0].after![SHIPPING_WEIGHT_KEY]).toMatchObject({
      physical_weight: 1.5,
      raw_sam_value: "6.00",
      raw_sam_meaning: "space_proxy",
    });
    expect(variant.metadata).not.toHaveProperty(SHIPPING_WEIGHT_KEY);
  });
  test("replay is unchanged and an approved override survives new source/review", () => {
    const plan = planSamWeightImport([row], [variant], [review()]);
    const applied = { ...variant, metadata: plan.entries[0].after };
    expect(planSamWeightImport([row], [applied], [review()]).counts).toEqual({
      unchanged: 1,
    });
    expect(
      planSamWeightImport(
        [row],
        [applied],
        [{ record: { ...review().record, physical_weight: 2 } }],
      ).counts,
    ).toEqual({ preserved_override: 1 });
    expect(
      planSamWeightImport(
        [row],
        [applied],
        [
          {
            record: { ...review().record, physical_weight: 2 },
            replaces_record_sha256: weightImportHash(review().record),
          },
        ],
      ).counts,
    ).toEqual({ changed: 1 });
  });
  test("rejects stale review and reports duplicate, unmatched and internal rows", () => {
    expect(
      planSamWeightImport(
        [{ ...row, SHIPWEIGHT: "7.00" }],
        [variant],
        [review()],
      ).counts,
    ).toEqual({ invalid_review: 1 });
    expect(
      planSamWeightImport([row, row], [variant], [review()]).counts,
    ).toEqual({ ambiguous: 1 });
    expect(
      planSamWeightImport(
        [row],
        [variant, { ...variant, id: "second" }],
        [review()],
      ).counts,
    ).toEqual({ ambiguous: 2 });
    expect(planSamWeightImport([], [variant], []).counts).toEqual({
      unmatched: 1,
    });
    expect(
      planSamWeightImport(
        [row],
        [{ ...variant, sku: "RM-ingredient" }],
        [review()],
      ).counts,
    ).toEqual({ excluded_internal: 1 });
  });
  test("requires exact plan, single canary and verified readback before batch", () => {
    const plan = planSamWeightImport([row], [variant], [review()]);
    expect(() =>
      selectWeightImportWrites(plan, {
        expectedPlanId: "stale",
        canaryVariantId: variant.id,
      }),
    ).toThrow();
    expect(() =>
      selectWeightImportWrites(plan, { expectedPlanId: plan.id }),
    ).toThrow("canary");
    expect(
      selectWeightImportWrites(plan, {
        expectedPlanId: plan.id,
        canaryVariantId: variant.id,
      }),
    ).toHaveLength(1);
    expect(
      selectWeightImportWrites(plan, {
        expectedPlanId: plan.id,
        canaryReceipt: {
          version: 1,
          planId: plan.id,
          verified: true,
          variantIds: [variant.id],
          beforeAfter: [
            {
              variantId: variant.id,
              before: variant.metadata,
              after: plan.entries[0].after,
            },
          ],
        },
      }),
    ).toHaveLength(0);
  });
  test("canonical hashing tolerates PostgreSQL JSON key order", () => {
    expect(weightImportHash({ b: 1, a: { c: 2, b: 3 } })).toBe(
      weightImportHash({ a: { b: 3, c: 2 }, b: 1 }),
    );
  });
  test("locks and preserves other metadata, then verifies readback", async () => {
    const plan = planSamWeightImport([row], [variant], [review()]);
    let saved: any = variant.metadata;
    const table: any = {
      select: jest.fn(() => table),
      where: jest.fn(() => table),
      whereNull: jest.fn(() => table),
      forUpdate: jest.fn(() => table),
      first: jest.fn(async () => ({ metadata: saved })),
      update: jest.fn(async (payload) => {
        saved = JSON.parse(payload.metadata);
      }),
    };
    const db = { transaction: async (cb) => cb(() => table) },
      journal = jest.fn(async () => {});
    const receipt = await applyWeightImportEntries(
      db,
      plan,
      plan.entries,
      journal,
    );
    expect(table.forUpdate).toHaveBeenCalled();
    expect(journal.mock.invocationCallOrder[0]).toBeLessThan(
      table.update.mock.invocationCallOrder[0],
    );
    expect(saved).toMatchObject(variant.metadata);
    expect(receipt.verified).toBe(true);
    expect(receipt.beforeAfter[0].after).toEqual(saved);
  });
  test("a concurrent metadata edit aborts without overwriting it", async () => {
    const plan = planSamWeightImport([row], [variant], [review()]);
    const table: any = {
      select: () => table,
      where: () => table,
      whereNull: () => table,
      forUpdate: () => table,
      first: async () => ({
        metadata: {
          ...variant.metadata,
          availability_lifecycle: "seasonal_inactive",
        },
      }),
      update: jest.fn(),
    };
    await expect(
      applyWeightImportEntries(
        { transaction: async (cb) => cb(() => table) },
        plan,
        plan.entries,
        async () => {},
      ),
    ).rejects.toThrow("changed after dry run");
    expect(table.update).not.toHaveBeenCalled();
  });
});
