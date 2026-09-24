/**
 * #321 acceptance vectors for a future source-agnostic native adjustment.
 * Identities and quantities here are synthetic. No receiving source, unit
 * conversion, baseline decision, or customer send is approved by this file.
 */
export type ReceiptAttempt = {
  source_system: "fixture_receiving";
  source_ref: string;
  quantity: number;
  final: boolean;
  baseline: "excluded" | "included" | "unresolved";
  consumer: "worker_a" | "worker_b";
  parallel_group?: string;
  response_lost?: boolean;
};

export type ReceivingAdjustmentFixture = {
  name: "unknown_result_retry" | "two_consumers" | "short_final" | "zero_final" | "rolling_partial" | "baseline_overlap" | "baseline_unresolved";
  identity: {
    variant_id: "variant_fixture";
    qbd_list_id: "list_fixture";
    stock_unit: "sellable_pack";
    inventory_item_id: "iitem_fixture";
    stock_location_id: "location_fixture";
  };
  opening: { stocked: number; reserved: number; future_committed: number };
  attempts: ReceiptAttempt[];
  expected: {
    stocked: number;
    reserved: number;
    future_untransferred: number;
    short_exception: number;
    adjustment_records: number;
    native_increase: number;
    eligible_restock_events: number;
  };
};

const receipt = (
  source_ref: string,
  quantity: number,
  baseline: ReceiptAttempt["baseline"] = "excluded",
  overrides: Partial<ReceiptAttempt> = {}
): ReceiptAttempt => ({
  source_system: "fixture_receiving",
  source_ref,
  quantity,
  final: true,
  baseline,
  consumer: "worker_a",
  ...overrides,
});

const identity: ReceivingAdjustmentFixture["identity"] = {
  variant_id: "variant_fixture",
  qbd_list_id: "list_fixture",
  stock_unit: "sellable_pack",
  inventory_item_id: "iitem_fixture",
  stock_location_id: "location_fixture",
};

export const receivingAdjustmentFixtures: ReceivingAdjustmentFixture[] = [
  {
    name: "unknown_result_retry",
    identity,
    opening: { stocked: 2, reserved: 1, future_committed: 3 },
    attempts: [
      receipt("retry-1", 5, "excluded", { response_lost: true }),
      receipt("retry-1", 5),
    ],
    expected: {
      stocked: 7, reserved: 4, future_untransferred: 0,
      short_exception: 0, adjustment_records: 1, native_increase: 5,
      eligible_restock_events: 1,
    },
  },
  {
    name: "two_consumers",
    identity,
    opening: { stocked: 0, reserved: 0, future_committed: 2 },
    attempts: [
      receipt("parallel-1", 3, "excluded", { parallel_group: "same-source" }),
      receipt("parallel-1", 3, "excluded", {
        consumer: "worker_b", parallel_group: "same-source",
      }),
    ],
    expected: {
      stocked: 3, reserved: 2, future_untransferred: 0,
      short_exception: 0, adjustment_records: 1, native_increase: 3,
      eligible_restock_events: 1,
    },
  },
  {
    name: "short_final",
    identity,
    opening: { stocked: 0, reserved: 0, future_committed: 8 },
    attempts: [receipt("short-1", 5)],
    expected: {
      stocked: 5, reserved: 5, future_untransferred: 3,
      short_exception: 3, adjustment_records: 1, native_increase: 5,
      eligible_restock_events: 0,
    },
  },
  {
    name: "zero_final",
    identity,
    opening: { stocked: 0, reserved: 0, future_committed: 8 },
    attempts: [receipt("zero-1", 0)],
    expected: {
      stocked: 0, reserved: 0, future_untransferred: 8,
      short_exception: 8, adjustment_records: 1, native_increase: 0,
      eligible_restock_events: 0,
    },
  },
  {
    name: "rolling_partial",
    identity,
    opening: { stocked: 0, reserved: 0, future_committed: 4 },
    attempts: [
      receipt("partial-1", 3, "excluded", { final: false }),
      receipt("partial-2", 2),
    ],
    expected: {
      stocked: 5, reserved: 4, future_untransferred: 0,
      short_exception: 0, adjustment_records: 2, native_increase: 5,
      eligible_restock_events: 1,
    },
  },
  {
    name: "baseline_overlap",
    identity,
    opening: { stocked: 5, reserved: 0, future_committed: 3 },
    attempts: [receipt("already-in-baseline-1", 5, "included")],
    expected: {
      stocked: 5, reserved: 3, future_untransferred: 0,
      short_exception: 0, adjustment_records: 1, native_increase: 0,
      eligible_restock_events: 0,
    },
  },
  {
    name: "baseline_unresolved",
    identity,
    opening: { stocked: 5, reserved: 0, future_committed: 3 },
    attempts: [receipt("unknown-overlap-1", 5, "unresolved")],
    expected: {
      stocked: 5, reserved: 0, future_untransferred: 3,
      short_exception: 0, adjustment_records: 0, native_increase: 0,
      eligible_restock_events: 0,
    },
  },
];
