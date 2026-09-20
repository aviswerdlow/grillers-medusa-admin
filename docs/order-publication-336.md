# Original order publication — launch candidate

This replaces the final-charge purchase producers in analytics and communications. It is a source candidate for strategy #336/#335/#368, not deployment or warehouse/GA4 acceptance. Required base: backend PR42 `9045e8b437a097964cc3f110e0926d3609cf7a2f` and its original-evidence, checkout, contact, stock, calendar, shipping and final-charge dependencies. Do not merge directly around that stack.

## Event contract

| Event | Authority and amount | Time and identity |
|---|---|---|
| `order_completed` | Successful native completion binding plus verified immutable accepted original; USD major-unit placement estimate, including zero. This does not mean paid. | Original native `placed_at`; `order.placed:<order_id>:order_completed`. |
| `order_finalized` | Same original plus matching successful final-charge attempt, finalization, currency, amount and payment identity. Final amount and delta from original; never another purchase. | First persisted attempt `succeeded_at`; `order.final_charge_succeeded:<order_id>:order_finalized`. |
| Refund/cancellation | Existing separate lifecycle producers; never rewrite the original or increment placement counters. | Existing lifecycle identity. Their full retry/provider certification remains required by #336/#332. |

The transport UUID is derived from the same logical identity for Jitsu and GP ingestion. Payloads are frozen after evidence resolution and retry with identical event time/value/context. The analytics allowlist excludes addresses, contacts, QBD IDs, receipt snapshot IDs and payment instruments. The original experiment assignment/version array and completeness survive; a map supplies existing communications consumers. No current profile, order total or final metadata is substituted for a missing original. Original reader dimensions and browser/session continuity still have their #336 acceptance gates; do not infer historical classifications.

## Durability and ownership

`analytics/order-placed.ts` persists source intent only. A native event may arrive before binding: it remains waiting. Failed/unbound completion cannot create a purchase. A bounded scan of native bindings repairs a missed subscriber; a scan of final-charge records repairs a missed finalization event. Neither scan invents a successful workflow or invokes checkout, Stripe or QBD.

`gp_order_publication` freezes the resolved event. `gp_order_publication_delivery` records four independent targets: Jitsu, GP analytics, communications record and communications automation. Workers claim rows using PostgreSQL locks, 90-second leases and tokens; stale acknowledgments cannot overwrite a new owner. Transport timeout is 10 seconds. Failed/unknown delivery retries with exponential delay capped at an hour; successful destinations are not resent. Payloads and receipts are retained on disable/rollback.

The one-minute Medusa job processes bounded evidence and delivery batches without requiring Redis. Network calls are outside checkout. HTTP acceptance is **transport acceptance only**: a lost response remains ambiguous and retries use the same UUID. Exactly one warehouse/GA4 purchase still requires deployed receiver deduplication and reporting evidence. ReplacingMergeTree alone does not prevent duplicate insert-triggered aggregates.

The journal is the only new purchase/finalization owner. The old communications subscriber neither subscribes to nor processes these source events. Its durable record-only call skips the communications direct ClickHouse/GA4 delivery and BullMQ paths for these events, avoiding an additional purchase route. Jitsu remains first-party measurement; GP ingestion owns its existing warehouse/GA4 path. Before activation, verify that legacy Jitsu/GTM destinations do not independently forward the same purchase to the same GA4 property; this source change does not configure those external routes.

Communications stores operational order truth regardless of analytics choice. Only known non-test placements increment original gross order counters; the event, per-order counting receipt and counters commit together, using atomic increments. Later finalization and refund do not increase them. Existing historical counters are not rebuilt or relabeled: reporting must identify the cutover between their old and new basis. Receipt email is never copied into login/marketing identity. Purchase tracking does not grant email/SMS consent. The separate automation target preserves existing purpose consent, suppressions and deterministic flow holdouts; it is withheld for test or unknown-test orders. The scheduled flow runner, required email path and provider receipts remain separate systems.

Attribution now rejects clicks/messages after the original order time. Both last-touch and last-click receipts stop replay; a conflicting insert cannot increment campaign metrics again. Flow enrollment and attribution are retried against the same original trigger after a worker crash. No email is sent by this publication worker.

## Activation and recovery

1. Integrate the required source stack and review database recovery/snapshot readiness. Apply migration `Migration20260920214500` before enabling the candidate subscribers. Do not roll back by dropping evidence tables.
2. Analytics/operator explicitly supplies an RFC3339 UTC `GP_ORDER_PUBLICATION_START_AT` for the coordinated cutover. The worker pins it in `gp_order_publication_epoch`; a changed value fails closed. Older native placements are excluded even if their events replay or final charge happens later. Inventory and reconcile those older orders separately; do not silently backfill final-charge purchases into placement purchases.
3. Provision and read back existing Jitsu and GP analytics endpoint/credential settings, the separately approved experiment-evidence keys, source reader access and test segregation. Missing/disabled Jitsu or GP configuration remains **held**, never delivered. Known test/opt-out analytics is excluded; unknown test/consent/experiment context is held without relabeling the original. Review the separate campaign/flow enablement before release.
4. Release the candidate subscribers and job together with `GP_ORDER_PUBLICATION_ENABLED=true` only for the authorized candidate. Default is disabled; while disabled, source intents remain pending. Verify the scheduler and durable queue in the actual deployment (#338). No production configuration was changed during implementation.
5. In the one #332 rehearsal, compare native placement, immutable original, journal, both transport IDs, ClickHouse rows/aggregates and GA4 reporting. Include event-before-binding, failed completion, zero, placement/final charge on different days, opt-out/test/unknown, crash after send, each destination failure, communications counter/attribution replay, holdout and refund/cancellation. Do not claim these receipts from the isolated SQL tests.
6. On incident, disable only the worker, preserve all rows and reconcile receiver outcomes by stable ID. Do not delete accepted delivery receipts to force resends, change the epoch or restore the old purchase subscriber alongside the new one. Restore the same pinned publisher after recovery; a mixed producer rollback requires a reviewed event disposition.

Read-only operator queries (protected database access; no customer payload exports):

```sql
select state, reason, count(*), min(created_at) as oldest
from gp_order_publication group by state, reason;
select target, status, reason, count(*), min(updated_at) as oldest
from gp_order_publication_delivery group by target, status, reason;
```

The job logs aggregate progress and emits existing ops alerts for waiting evidence, held/retry delivery or worker failure. #338 must verify actual routing and operator receipt; log emission is not alert delivery. Pending originals require source recovery, not a mutable-total fallback. Integration tests use local isolated PostgreSQL and actual migrations with narrow native-boundary tables; they do not run Medusa HTTP checkout or real providers.
