# Original order publication — launch candidate

Migration retry and per-release backup requirements are documented in
[launch migration recovery](launch-migration-recovery-372.md). No live migration,
backup, publisher activation or rollback is implied by the source checks.

This replaces the final-charge purchase producers in analytics and communications. It is a source candidate for strategy #336/#335/#368, not deployment or warehouse/GA4 acceptance. Required base: backend PR42 `9045e8b437a097964cc3f110e0926d3609cf7a2f` and its original-evidence, checkout, contact, stock, calendar, shipping and final-charge dependencies. Do not merge directly around that stack.

## Event contract

| Event | Authority and amount | Time and identity |
|---|---|---|
| `order_completed` | Successful native completion binding plus verified immutable accepted original; USD major-unit placement estimate, including zero. This does not mean paid. | Original native `placed_at`; `order.placed:<order_id>:order_completed`. |
| `order_finalized` | Same original plus matching successful final-charge attempt, finalization, currency, amount and payment identity. Final amount and delta from original; never another purchase. | First persisted attempt `succeeded_at`; `order.final_charge_succeeded:<order_id>:order_finalized`. |
| `order_canceled` | Native canceled status and `canceled_at`, bound to the immutable original. No revenue value or implied refund. | Native cancellation time; order + lifecycle kind. |
| `fulfillment_created`, `order_shipped`, `order_delivered` | Native order/fulfillment link and the corresponding persisted creation/shipping/delivery time. A fulfillment is one package/action, not proof that every order line arrived. | Fulfillment ID + distinct lifecycle kind; never `order.completed` as fulfillment proof. |
| `return_created` | Confirmed native return request (`requested_at`) and its order link. A request is not received stock or a refund. | Return ID + request time. |
| `order_refund_updated` | Verified GET observations from the pinned Stripe account/mode, joined through the exact PaymentIntent and original order. Separate from native recording. | Provider refund + immutable observation revision/time; later states append. |
| `order_refunded` | A native refund plus matching negative order transaction, or a completed direct-final-charge refund receipt plus matching transaction. Positive major-unit refund amount only; original gross purchase is unchanged. | Individual native/Stripe refund ID + order transaction time; equal-value partial refunds remain distinct. |

Lifecycle contract recorded before subscriber changes: all these events inherit the **original** customer, currency, analytics consent, test classification and verified experiment context. Do not resolve them from a current profile or from event-supplied amounts. Non-money milestones omit `value`, `total`, tax/shipping/discount and item counts rather than copying the original purchase into another monetary event. Refunds carry `refund_status=recorded`, the explicit native/provider-recorded amount basis and provider status where evidenced; they do not claim bank settlement, successful QBD posting, restocking or a new purchase. A pending provider refund remains visibly pending. Missing/conflicting source evidence is retained for reconciliation, never guessed.

Source recovery uses durable native facts after the same activation epoch. A bounded anti-join scan discovers each action independently of transient notifications. The source journal freezes per-action facts and all delivery targets reuse its ID/time/context. Event-before-link/binding waits. The old lifecycle analytics/communications writers must be removed together; transactional email/payment/accounting subscribers remain independent. Actual provider/reporting and rollback acceptance remains in #332, and cart/customer/shipping-forecast producer classification remains a separate open #336 prerequisite.

The transport UUID is derived from the same logical identity for Jitsu and GP ingestion. Payloads are frozen after evidence resolution and retry with identical event time/value/context. The analytics allowlist excludes addresses, contacts, QBD IDs, receipt snapshot IDs and payment instruments. The original experiment assignment/version array and completeness survive; a map supplies existing communications consumers. No current profile, order total or final metadata is substituted for a missing original. Original reader dimensions and browser/session continuity still have their #336 acceptance gates; do not infer historical classifications.

## Durability and ownership

`analytics/order-placed.ts` persists source intent only. A native event may arrive before binding: it remains waiting. Failed/unbound completion cannot create a purchase. A bounded scan of native bindings repairs a missed subscriber; a scan of final-charge records repairs a missed finalization event. Neither scan invents a successful workflow or invokes checkout, Stripe or QBD.

`gp_order_publication` freezes the resolved event. `gp_order_publication_delivery` records the four production/operational targets: Jitsu, GP analytics, communications record and communications automation. Workers claim rows using PostgreSQL locks, 90-second leases and tokens; stale acknowledgments cannot overwrite a new owner. Transport timeout is 10 seconds. Failed/unknown delivery retries with exponential delay capped at an hour; successful destinations are not resent. Payloads and receipts are retained on disable/rollback.

The one-minute Medusa job processes bounded evidence and delivery batches without requiring Redis. Network calls are outside checkout. HTTP acceptance is **transport acceptance only**: a lost response remains ambiguous and retries use the same UUID. Exactly one warehouse/GA4 purchase still requires deployed receiver deduplication and reporting evidence. ReplacingMergeTree alone does not prevent duplicate insert-triggered aggregates.

The journal is the only new order publication owner, including cancellation, per-fulfillment creation/shipping/delivery, requested returns and recorded refunds. The third migration adds per-action source identities while retaining the one-placement/one-finalization uniqueness rules and every existing immutable payload/receipt. The old lifecycle analytics subscribers are removed, and communications-commerce-events accepts customer events only. `order.completed` marks administrative completion and is not fulfillment evidence.

The original purchase/finalization producers remain replaced. The old communications subscriber neither subscribes to nor processes these source events. Its durable record-only call skips the communications direct ClickHouse/GA4 delivery and BullMQ paths for these events, avoiding an additional purchase route. Jitsu remains first-party measurement; GP ingestion owns its existing warehouse/GA4 path. Before activation, verify that legacy Jitsu/GTM destinations do not independently forward the same purchase to the same GA4 property; this source change does not configure those external routes.

Communications stores operational order truth regardless of analytics choice. Only known non-test placements increment original gross order counters; the event, per-order counting receipt and counters commit together, using atomic increments. Later finalization and refund do not increase them. Existing historical counters are not rebuilt or relabeled: reporting must identify the cutover between their old and new basis. Receipt email is never copied into login/marketing identity. Purchase tracking does not grant email/SMS consent. Communications preserves its existing `shipment_created` and `delivery_created` trigger names for the same journal IDs; analytics names those facts `order_shipped` and `order_delivered`. No duplicate event is created for an alias. The separate automation target preserves existing purpose consent, suppressions and deterministic flow holdouts; it is withheld for test or unknown-test orders. The scheduled flow runner, required email path and provider receipts remain separate systems.

Attribution now rejects clicks/messages after the original order time. Both last-touch and last-click receipts stop replay; a conflicting insert cannot increment campaign metrics again. Flow enrollment and attribution are retried against the same original trigger after a worker crash. No email is sent by this publication worker.

## Activation and recovery

1. Integrate the required source stack and review database recovery/snapshot readiness. Apply migrations `Migration20260920214500`, `Migration20260920223000` and `Migration20260920235000` before enabling the candidate subscribers. Do not roll back by dropping evidence tables.
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

The job logs aggregate progress and emits existing ops alerts for waiting evidence, held/retry delivery or worker failure. #338 must verify actual routing and operator receipt; log emission is not alert delivery. Missing native lifecycle rows, conflicting refund transactions or uncertain staff-refund receipts remain waiting with a lifecycle-specific reason. A native-recorded refund row without the matching order transaction is never published as `order_refunded`. The separate provider-observation lane can retain actual processor evidence without inventing a native transaction. Direct final-charge refunds require a completed staff request with the original provider receipt, amount/currency and PaymentIntent relation. Native Medusa refund records do not persist provider settlement status, so that status remains unverified.

GA4 receives `order_refund_recorded` for new pending/unverified records, and standard `refund` only when the recorded provider status is succeeded. This avoids silently reducing reported net revenue on uncertain evidence. The opt-in [refund reconciliation adapter](refund-reconciliation-336.md) now preserves Stripe identity and journals later read-only observations, including provider-only findings. A durable measurement owner coordinates old direct-success and new outcome events. Apply migration `20260921001500` before either updated publisher runs. Native/provider/report/alert acceptance remains an explicit #336/#332 gate. Do not rewrite the immutable recorded event or replay money to repair analytics.

Pending originals require source recovery, not a mutable-total fallback. Integration tests use local isolated PostgreSQL and actual migrations with narrow native-boundary tables; they do not run Medusa HTTP checkout or real providers.

## Isolated rehearsal destinations

Known test originals also get independent `jitsu_rehearsal` and `gp_analytics_rehearsal` receipts. Production Jitsu/GP and communications automation remain excluded for those orders. The second migration backfills only these two targets on already-ready known test publications; it neither reopens production receipts nor changes the immutable original. Non-test/unknown originals never become rehearsal purchases. Consent, completeness and experiment-version gates still apply. A separate GA4 `order_finalized` event is not another purchase.

Rehearsal transport is disabled unless `GP_ORDER_REHEARSAL_ENABLED=true`. Explicit configuration, in addition to the publisher's existing epoch/enablement:

- `GP_REHEARSAL_ID`: lowercase letter followed by 2–47 lowercase letters, digits or hyphens, shared with receiver services.
- `GP_REHEARSAL_JITSU_HOST` / `GP_REHEARSAL_JITSU_SERVER_SECRET`.
- `GP_REHEARSAL_ANALYTICS_ENDPOINT` / `GP_REHEARSAL_ANALYTICS_SERVER_KEY` (key scope `rehearsal:medusa-server`).

Each test endpoint must have a different HTTPS origin and credential from its corresponding configured production destination. Missing, same-origin, same-key or malformed settings hold delivery; there is no fallback. Redirects are refused. The target URL/rehearsal identity hash is pinned in `gp_order_publication_route` before the first send; changed destinations hold instead of redirecting an ambiguous retry. Credential rotation at the same destination is possible. Do not delete the pin to retarget receipts; a new rehearsal dataset requires an explicit reviewed disposition or a separate isolated publisher database.

Payloads retain `test_order=true`, original UUID/time/value and add `analytics_environment=rehearsal` plus `rehearsal_id`. GP acceptance also requires matching environment/id response headers. This identifies the configured receiver, not its downstream delivery. Jitsu does not provide that GP acknowledgment contract; verify its separate project, no production destination connections, isolated warehouse and actual receipt in #332. A different URL alone is not proof of Jitsu destination configuration.

The paired analytics candidate documents namespaced Redis/dedup/GA4 receipts, scoped ingestion keys, a dedicated ClickHouse database and distinct GA4 **property and stream**. Analytics/infra must provision and verify these destinations and least-privilege credentials before authorized activation. Rehearsal credentials, property mapping, deployed services and Jitsu routing have not been changed or certified by source tests. Lifecycle events now inherit original classification through this journal. Cart/customer/shipping-forecast and actual browser exposure/identity producers still need end-to-end classification; this candidate does not complete those gates. Do not begin the live rehearsal while any producer can leak unclassified test events, or while production Jitsu/GTM and GP ownership of GA4 is unresolved.

To stop rehearsal delivery, disable `GP_ORDER_REHEARSAL_ENABLED`; retain receipts, source test flags, dataset and pinned route. Use aggregate queue health plus actual receiver/warehouse/GA4 readbacks. Never relabel a test order as production to make a report pass.
