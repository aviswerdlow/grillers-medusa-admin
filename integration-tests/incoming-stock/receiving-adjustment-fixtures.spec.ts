import { receivingAdjustmentFixtures } from "./receiving-adjustment.fixtures";

it("keeps the native adjustment contract complete and internally balanced", () => {
  expect(receivingAdjustmentFixtures.map((row) => row.name)).toEqual([
    "unknown_result_retry", "two_consumers", "short_final", "zero_final",
    "rolling_partial", "baseline_overlap", "baseline_unresolved",
  ]);

  for (const row of receivingAdjustmentFixtures) {
    expect(Object.values(row.identity).every((value) => Boolean(value))).toBe(true);
    const unique = new Map<string, (typeof row.attempts)[number]>();
    for (const attempt of row.attempts) {
      expect(attempt.source_system).toBe("fixture_receiving");
      expect(attempt.source_ref).toMatch(/\S/);
      expect(Number.isSafeInteger(attempt.quantity)).toBe(true);
      expect(attempt.quantity).toBeGreaterThanOrEqual(0);
      const key = `${attempt.source_system}:${attempt.source_ref}`;
      const old = unique.get(key);
      if (old) {
        expect({ quantity: attempt.quantity, final: attempt.final, baseline: attempt.baseline }).toEqual({
          quantity: old.quantity, final: old.final, baseline: old.baseline,
        });
      } else unique.set(key, attempt);
    }

    const accepted = [...unique.values()].filter(
      (attempt) => attempt.baseline !== "unresolved"
    );
    const nativeIncrease = accepted
      .filter((attempt) => attempt.baseline === "excluded")
      .reduce((sum, attempt) => sum + attempt.quantity, 0);
    const transferred = row.opening.future_committed - row.expected.future_untransferred;
    expect(row.expected.adjustment_records).toBe(accepted.length);
    expect(row.expected.native_increase).toBe(nativeIncrease);
    expect(row.expected.stocked).toBe(row.opening.stocked + nativeIncrease);
    expect(row.expected.reserved).toBe(row.opening.reserved + transferred);
    expect(transferred).toBeGreaterThanOrEqual(0);
    expect(transferred).toBeLessThanOrEqual(row.opening.future_committed);
    expect(row.expected.reserved).toBeLessThanOrEqual(row.expected.stocked);
    expect(row.expected.eligible_restock_events).toBeGreaterThanOrEqual(0);
    expect(row.expected.eligible_restock_events).toBeLessThanOrEqual(
      accepted.filter((attempt) => attempt.baseline === "excluded" && attempt.quantity > 0).length
    );
  }
});
