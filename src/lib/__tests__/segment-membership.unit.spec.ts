import {
  segmentDefinitionHash,
  segmentMembershipState,
} from "../communications/segment-membership";
import { clickHouseSegmentProfileIds } from "../communications/segments";

jest.mock("../communications/destinations", () => ({
  clickHouseClient: jest.fn(() => null),
}));

const at = new Date("2026-09-21T12:00:00Z");
function segment() {
  return {
    status: "active",
    query_definition: { source: "clickhouse", query_key: "engaged_recent" },
    cached_count: 0,
    last_computed_at: at,
    metadata: {
      membership_refresh_v1: {
        status: "available",
        completed_at: at.toISOString(),
        refresh_id: "fixture",
        member_set_hash: "fixture-hash",
        member_count: 0,
        definition_hash: segmentDefinitionHash({
          source: "clickhouse",
          query_key: "engaged_recent",
        }),
      },
    },
  };
}

describe("materialized audience availability", () => {
  it("distinguishes a successful empty audience from an unavailable warehouse", async () => {
    expect(segmentMembershipState(segment(), at).available).toBe(true);
    const db = jest.fn();
    await expect(
      clickHouseSegmentProfileIds(db, segment().query_definition)
    ).rejects.toThrow("warehouse_not_configured");
    expect(db).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no receipt",
      (s: any) => {
        s.metadata = {};
      },
      "latest_refresh_unavailable",
    ],
    [
      "failed latest attempt",
      (s: any) => {
        s.metadata.membership_refresh_v1.status = "unavailable";
      },
      "latest_refresh_unavailable",
    ],
    [
      "definition edited",
      (s: any) => {
        s.query_definition.params = { days: 14 };
      },
      "definition_changed",
    ],
    [
      "stale result",
      (s: any) => {
        s.metadata.membership_refresh_v1.completed_at = "2026-09-20T11:59:59Z";
      },
      "refresh_expired",
    ],
    [
      "future result",
      (s: any) => {
        s.metadata.membership_refresh_v1.completed_at = "2026-09-21T12:00:01Z";
      },
      "refresh_expired",
    ],
    [
      "inactive segment",
      (s: any) => {
        s.status = "paused";
      },
      "inactive",
    ],
    [
      "removed segment",
      (s: any) => {
        s.deleted_at = at;
      },
      "inactive",
    ],
    [
      "changed count",
      (s: any) => {
        s.cached_count = 1;
      },
      "receipt_incomplete",
    ],
    [
      "partial receipt",
      (s: any) => {
        delete s.metadata.membership_refresh_v1.member_set_hash;
      },
      "receipt_incomplete",
    ],
  ])("holds %s", (_name, mutate, reason) => {
    const s = segment();
    (mutate as (value: any) => void)(s);
    expect(segmentMembershipState(s, at)).toMatchObject({
      available: false,
      reason,
    });
  });

  it("keeps harmless definition key reordering while detecting changed nested parameters", () => {
    const a = { source: "clickhouse", params: { days: 7, years: 2 } };
    expect(segmentDefinitionHash(a)).toBe(
      segmentDefinitionHash({
        params: { years: 2, days: 7 },
        source: "clickhouse",
      })
    );
    expect(segmentDefinitionHash(a)).not.toBe(
      segmentDefinitionHash({ ...a, params: { days: 8, years: 2 } })
    );
  });
});
