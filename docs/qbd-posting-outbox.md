# Durable accounting cutover — strategy #314

Tracks https://github.com/aviswerdlow/grillers-pride-strategy/issues/314. This is a candidate implementation; it is not a deployment or a QuickBooks receipt.

## Contract

`gp_qbd_posting_outbox` stores one immutable full order snapshot per accounting request. The request key is unique; source amount/currency, order, action, predecessor and snapshot cannot be updated. Its row and the order's latest display metadata commit together under an order lock. Charges use `final_charge:<PaymentIntent>` and refunds use `refund:<provider/Medusa refund ID>`. A/R invoices retain the existing finalization key. Staff notes, captures, adjustments and cancellation handoffs use their stable action key after confirmation.

The minute worker uses the existing authenticated import endpoint and HMAC signing. Its timed lease recovers transport failures. HTTP 200 must acknowledge the exact outbox ID/key and bridge job ID; that means **delivered**, not posted. Invalid snapshots or HTTP 422 become blocked and do not monopolize subsequent deliveries. A lost HTTP response redelivers the same key. No network call is inside the Medusa posting transaction.

The bridge holds dependent jobs until their predecessor succeeds. A final card invoice is not complete until its generated applied-payment job succeeds. Refunds resolve that invoice from the bridge's successful jobs even when the original snapshot predates its TxnID. A narrow callback acknowledges the source key, generation and actual transaction IDs. Older receipts update their own row and cannot complete a newer metadata slot. An applied-payment retry never recreates its successful invoice. Unknown QBXML outcomes require reconciliation; only an explicit new retry generation can retry a confirmed rejection.

The authenticated staff accounting-history route lists up to 100 actions. Staff select the exact failed/blocked request for retry. Existing pending metadata is not automatically converted: the read-only reconciliation report lists it, and new money work on those orders fails closed. A managed note with no SalesOrder may be saved into a real pending SalesOrder snapshot with an explicit nonfinancial receipt; a missing SalesOrder identity never proves that a cancellation has posted.

## Refund retries and recovery

Both staff refund endpoints require `Idempotency-Key`. A durable request claim is made before the provider call. It retains the order/payment identity, original request details and fingerprint, known refund ID, and completed response. A confirmed retry returns the saved result without sending another refund, event, or allocation release. Different details under the same key are rejected. Any started or uncertain attempt blocks additional refunds on that order; there is no timeout that grants permission to move money again.

If provider/DB/follow-up work fails, use the report and private request record to compare the Stripe refund, Medusa payment/refund/transaction rows, allocation effects, and outbox request. Restore only missing local bookkeeping after the provider outcome is established. Never rerun the refund endpoint with a new key to repair bookkeeping. This change deliberately supplies no automatic historic replay or refund-unlock command. Recovery needs reviewed, provider-backed evidence; source IDs and accounting receipts are retained.

The staff frontend records preliminary and failure audit entries without replacing accounting or refund provider facts. A new intentional action gets a new request identity; a resubmission of the same form retains its identity. Backend refund producers own the canonical refund accounting key.

## Staged rollout and rollback

1. Keep staff money/adjustment actions quiescent for the cross-repository cutover. Preserve DB backups and the existing deployment revisions. Do not switch production QuickBooks or restore the absent broad writer credential.
2. Ship the bridge with #316's separated read capability first. It must recognize the immutable envelope, acknowledge via the narrow callback, and skip managed metadata polling. Keep the isolated test-company writer window controlled.
3. Apply the additive backend migration through the normal Medusa migration path. It registers under `gp-catch-weight` and creates both the posting ledger and refund-request guard. There is no backfill or provider action in the migration.
4. Deploy the backend producers/worker and then the staff frontend. Confirm the worker's exact revision, schema, authentication boundaries, and action-history readback. Native pre-cutover frontend metadata writes must not remain an operating path.
5. Run `npx medusa exec ./src/scripts/report-qbd-posting-outbox.ts`. It is read-only. Keep its identifiers in private evidence. It reports ledger status counts, up to 100 untracked legacy requests, and up to 100 unresolved refund attempts, with truncation indicators. Inspect private `request_details` only when reconciling the affected request.
6. Before reopening staff actions, resolve each legacy pending request against existing bridge jobs and QBD TxnIDs. Do not infer no effect from a timeout, missing local row, or a green Web Connector bar. Coordinate tax/mapping outcomes with #315 and the shared #332 rehearsal.
7. Retain the charge + two immediate refunds sequence, delayed ingestion, duplicate delivery, failure/retry and callback-outage evidence in the isolated test company. Verify invoice **and applied-payment** TxnIDs, both refund/credit TxnIDs, amounts, links, source keys, and no duplicate QBD effect. Fixtures alone cannot close #314.

Rollback must retain both tables and all provider receipts. The migration's `down` intentionally refuses to destroy financial history. Pause staff money actions and worker delivery before reverting producer code; do not reactivate a legacy metadata writer against managed orders. Preserve the bridge's receipt support until every delivered action is reconciled. Missing schema fails preflight before new refund/charge execution.

## Verification

`yarn test:accounting` runs real isolated PostgreSQL transactions using only `QBD_TEST_DATABASE_URL` or `QBD_TEST_PG_SOCKET` (never the application's DATABASE_URL). CI supplies an ephemeral PostgreSQL service and checks concurrency, immutable facts, rollback, retries, predecessor preservation, uncertain refund claims, stale callbacks and worker outage recovery. Focused route tests cover charge/refund producers, authenticated callbacks and staff audit handoff; bridge tests cover invoice/payment/refund order and explicit retry generations. Full suite/TypeScript results must be tied to the PR head.

Remaining launch proof: coordinated deployment, private legacy reconciliation, staff role matrix (#318), and isolated QBD/provider readback (#332). `update_sales_order_items` is retained but blocked if the bridge cannot execute it; #368 owns the amendment implementation. No production financial action or migration is authorized by this document.
