# Confirmed incoming stock: independent ledger candidate

Tracks strategy [#364](https://github.com/aviswerdlow/grillers-pride-strategy/issues/364), packet A3. Based on staff authority PR 32, `92717bd353b5ce6307fd21157fd9b864d24eaae7`. This is **phase 1 source**, not a complete future-order feature or permission to deploy/enable it. No customer checkout path uses the ledger yet. The stopped #312 native fixture was not changed or rerun.

## Implemented boundary

- SQL-owned tables in the existing allocation module, with actual versioned migration. Keeping mutations out of generated CRUD avoids bypassing the locking/audit contract. Do not regenerate a migration that drops these ledger tables.
- Draft forecast → explicitly confirmed batch → revision/cancellation or final receipt staging. Stable variant, QBD ListID, sellable unit, source identity, expected quantity, confirmed quantity, usable UTC instant, revision, accountable operator and confirmation timestamp remain distinct.
- Confirmed supply is consumed across compatible batches under a variant advisory transaction lock. Competing requests cannot overcommit. Each request has a payload-bound durable result; changing the payload under the same key fails. An active cart/order line cannot be committed under a second demand id.
- Each demand retains its original customer date, preparation deadline and accepted calendar revision. A batch delay, shortage or cancellation marks affected demands without changing the promise. Exceptions continue to block new commitments against that batch until the affected demand has an authorized resolution. Moving a batch date back does not silently clear an exception.
- Partial quantity release is replay-safe and audited; original quantities remain. Old placement replay does not resurrect released stock. **The internal caller still has to verify actual cancellation or eligible pre-fulfillment refund state.** No generic refund webhook was wired here.
- A final receipt, including a short/zero receipt, is staged once by source identity. It freezes future capacity and remains `pending_adapter`. It does not adjust on-hand stock, emit a restock event or claim native reservation transfer. Rolling partial deliveries are not yet implemented; do not enter a first partial delivery as final.

## Staff API and authority

`GET /admin/grillers/inventory/incoming?variant_id=...` returns batches with committed/available quantities, demands and exceptions, commitments and staged receipts. It is staff-only and includes internal identities. There is **no public projection or Store reservation endpoint** in this candidate. List results are advisory; mutations recheck state under locks.

`POST` supports `create`, `confirm`, `revise`, `cancel`, `stage_receipt`. Each command requires `request_id` and `reason`; edits require `expected_revision`. Reuse the same request id and identical payload after an uncertain response. The route obtains actor identity from A2's verified principal. Create resolves the QBD ListID from the backend variant rather than trusting the body. Stock unit and usable time require the approved receiving source; no unit conversions or lead-time guesses are applied.

The gateway permits reads via `inventory.read`; writes require `inventory.manage` (currently super admin only). The command additionally requires immutable actor id in **`GP_INCOMING_STOCK_OPERATOR_IDS`**, empty by default. Customer authority and session epoch are rechecked under a row lock. The separate configured native operator must also appear in this receiving allowlist. Background reader credentials cannot access this route. Do not configure an operator or grant a broader role until #359's named owner and #318's role review are approved.

The paired storefront candidate supplies `/account/staff/incoming-stock`: authenticated product/batch review, a paged affected-order queue, approved-operator commands, explicit timezone conversion and recovery of a saved request after an uncertain response. `GET ?view=exceptions&after=...` returns the next 50 active exceptions with customer-safe product titles; `can_manage` is a response-only capability hint. The backend always rechecks the actual mutation. `stage_receipt` additionally requires `receipt_final_confirmed: true`, preventing an ordinary partial-delivery form from silently closing a batch. Native checkout and receipt application remain unimplemented; this screen does not activate them. Production identity/operating approval and a real staff walkthrough remain required.

## Consumer contracts and next implementation

### #312 / #362: checkout and dates

1. Merge/integrate verified stock truth and the calendar candidate. Existing `requestedFulfillmentDateFromMetadata` means customer date; never silently relabel it as preparation.
2. Derive `needed_by` as a UTC instant from the **verified** calendar preparation boundary, its IANA timezone and #359's approved usable-stock rules. `fulfillmentPickDate` is date-only; neither UTC midnight nor customer arrival is an approved substitute. A trusted explicit staff boundary is possible only with an audited operator decision.
3. Combine native on-hand reservations with incoming commitments before Stripe/cart completion, atomically for all cart lines in stable variant order. An enclosing SQL transaction is supported, but an actual native Medusa reservation/checkout adapter is still needed. Include cart-expiry cleanup, order attachment, failure compensation and retry semantics; a ledger result alone does not prove the cart completed.
4. Consume the single existing `completeCartWorkflow.validate` hook in the receipt/calendar/shipping stack; Medusa does not support another competing validate handler. Cover custom, native/direct API and authorized staff paths. Gate customer `future_allowed` on an actual supported commitment; never activate this source by leaving the current lead-time heuristic in place.
5. Enforce public catalog lifecycle/RM exclusions and expose only a safe availability result. Use existing cart-resolution actions and reconfirm the calendar after a changed basket/date. No supplier reference or ListID may enter a customer response.

### #321: receiving adapter

The staged receipt carries `id`, `batch_id`, stable source system/reference, confirmed variant/ListID/unit, actual quantity/usable time and named operator. `pending_adapter` means **no stock was applied**. The receiving owner must choose the source and unit rule before integration.

Build an idempotent source-to-native adjustment with a durable source-to-adjustment receipt. Verify whether the source is already included in the approved QBD/native baseline before adding any quantity. Preserve/transfer each existing demand reservation exactly once and record the applied native item/location/adjustment identifiers. Apply the native change and ledger state in one proven transaction, or use a durable recoverable state machine where native operations cannot share it. A callback that merely reports success is insufficient. Test receipt replay, short/late receipt, active reservations, baseline overlap, external sales/shrink drift and recovery after an uncertain result. Emit one real eligible restock event only after actual usable stock increases.

This candidate intentionally has no `received`/`applied` state or completion endpoint: no current adapter can prove those facts. Do not manually change `pending_adapter` in SQL to bypass the gate. Add support for rolling partial deliveries once source receipt identities and remaining-batch behavior are agreed.

### #368: amendments and exceptions

`previewIncomingStock` is internal/advisory; `reserveIncomingStock` rechecks quantity under the variant lock. `releaseIncomingStock` accepts a proven quantity plus cancellation, eligible pre-fulfillment refund or amendment reason. The consumer must enforce order ownership, expected revision, pre-pick cutoff and approved customer changes. Do not mutate the original demand's dates. A replacement proposal needs fresh calendar/stock validation, a new demand identity and an atomic release/reserve transaction. Exception resolution, order binding and native allocation synchronization are still integration work.

## Evidence and release gates

Run `npm run test:incoming-stock` with a dedicated `INCOMING_TEST_DATABASE_URL`, or `INCOMING_TEST_PG_SOCKET` on port 55464 / user `gp_incoming_test` / database `gp_incoming`. Tests execute the actual migration in a disposable schema; never use application `DATABASE_URL`. CI runs this gate on PostgreSQL 16 alongside existing unit, TypeScript and accounting gates.

These tests prove ledger transactions, locking, replay and rollback. They do not reproduce the native Medusa stock module, HTTP checkout, Stripe, QBD, a published calendar, real staff browser operation or customer messages. All original #364 acceptance, dependency closures, staff screen, receiving adapter and production rehearsal remain open. #359 supplies owner/unit/usable-time decisions; #312, #318, #362 supply required source/runtime interfaces. No existing fixture stop condition is lifted by this independent test suite.

## Migration recovery and release backup (#372)

Before merging a change that runs this migration, the release operator must record a fresh database backup, its restore target/procedure and the exact candidate SHA. No backup is claimed by source tests. `Migration20260920150000` can resume after a completed DDL statement and can be reapplied with existing batches, commitments, receipts and event history. Existing tables/indexes and their data are retained; a divergent schema must be investigated, not dropped or replaced. Rollback still preserves this ledger and uses the reviewed recovery procedure.

The `migration-replay.spec.ts` PostgreSQL tests exercise partial creation, populated replay and retained uniqueness/quantity guards. They do not prove a Railway backup, live migration or native stock rehearsal.
