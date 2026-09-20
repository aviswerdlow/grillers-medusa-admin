# Immutable placement evidence for analytics

Source handoff for strategy #335/#336/#368, based on backend PR40 `1292cd9`. Canonical target is `mintpixels/grillers-medusa-admin`, confirmed by repository instructions, remote and the active checkout PR. This is a restricted reader candidate, not a new purchase publisher or a deployed parity result.

## Endpoint and authority

`GET /admin/grillers/analytics/order-promises?start=<UTC ISO>&end=<exclusive UTC ISO>&limit=100&offset=0`

The existing native Medusa Basic API-key authenticator must verify the credential. Its immutable API-key ID must be separately approved in `GP_PARITY_READ_API_KEY_IDS`, empty by default. The parity scope wins over accidental dual-listing in `GP_ADMIN_READ_ONLY_API_KEY_IDS`. It permits only this GET; it cannot read general orders/customers/catalog, mutate data, or act through the staff gateway. The handler also requires the verified parity principal, denying broad discovery keys, staff sessions and native admin fallbacks. No key or operator grant is created by this change.

Responses are `Cache-Control: no-store`. Only the existing `orderPromiseAnalytics` allowlist leaves the backend: order ID, accepted revision/time, native placed time, original amount/basis/unit/currency, calendar/review versions and accepted experiment/consent/test context. Contacts, addresses, lines, supplier/QBD identities, private sale terms, payment details and stored snapshot IDs are not returned. Null measurement fields stay null.

## Complete and consistent reads

- UTC bounds must be increasing, at most 31 elapsed days, ending no later than now. The caller supplies completed property-local days converted to UTC, including DST. Page size is 1–100; at most 10,000 native placements may be scanned.
- Each request uses a PostgreSQL repeatable-read, read-only transaction. Native orders are the coverage source; querying only bound snapshots would silently omit missing originals. Bound originals whose native order was removed/deleted remain in the manifest and fail verification. Original placement dates cannot move to another window with later mutable order changes.
- The response is `{contract_version:1,start,end,revision,count,offset,limit,orders}`. `revision` fingerprints the whole window's identities and binding evidence. Every later page must supply that revision. A newly bound, reassigned, deleted or replaced row changes it even if the count stays the same, returning 409. The client must reject an incomplete scan; it cannot combine pages from different manifests.
- Every returned record passes the original snapshot hash/schema and native owner/order-cart checks. A missing binding, legacy order without an original, tampered snapshot or broken native link is unavailable (503), never a zero or a fallback to current `total`, finalization metadata or QBD money. A truly empty verified window has count zero and a stable revision.
- No refunds, cancellations, settlement state or current profile values redefine historical gross placement. This reader is evidence of an accepted order, **not proof of payment**.

## Measurement contract and remaining work

The paired analytics candidate consumes accepted placement estimates for records explicitly classified as production and analytics-consented. Known test/opt-out rows are excluded from that comparison but all source rows must be read. Unknown test/consent state or an accepted experiment with unknown version makes the source unavailable. This is the intended source for the existing no-test/consent/experiment launch requirements, not permission to guess missing context or backfill it from a current profile.

| Event | Required origin and amount/time basis | Remaining verification |
|---|---|---|
| `page_viewed`, `product_viewed`, `product_added_to_cart`, `cart_viewed` | Browser; actual action time; consent and stable anonymous/session context; experiment assignment/version where applicable | Browser → Jitsu/warehouse → GA4 IDs, opt-out and mobile cases in #332/#336 |
| `checkout_started`, `shipping_info_submitted`, `payment_info_submitted` | Browser action, same cart and accepted assignment; never a completed purchase | Failure/retry/identity/holdout continuity in the same rehearsal |
| `order_completed` | Server `order.placed`, backed by successful native completion and immutable original amount/date; one stable order/event identity | Publisher still incorrectly waits for final charge. Implement durable handoff across event-before-binding timing, replay and destination failure without blocking checkout. |
| `order_finalized` | Successful final settlement, separate actual amount/time; same order ID, distinct finalization identity | Remove duplicate purchase emission; preserve zero final values and immutable estimate/delta. |
| Refund/cancellation | Actual server lifecycle, distinct refund/cancellation identity and actual time; original placement retained | Separate Stripe/Medusa/accounting/communications facts and destination receipts. |

The current subscriber and communications code still recognize purchases on final charge; this change intentionally exposes that mismatch rather than relabeling final money or loosening parity. The trusted checkout currently leaves test classification and some experiment versions unknown; source reads will remain unavailable until their trustworthy capture is implemented. Do not rewrite append-only originals or mark historical unknowns false/consented. Paid-media and revenue experiments remain held under #336.

## Verification and rollout

Focused tests use installed Medusa authentication to deny reader writes, broad reads, staff-header misuse, accidental key-list overlap and revoked classification. Direct route tests verify query bounds, no-cache and sanitized errors. The existing isolated order-promise PostgreSQL suite verifies real joins/transactions, missing originals, zero value, privacy, deleted/retimed native evidence and changing same-count pagination. It does not run native checkout/providers or revive the stopped #312 fixture.

Release the paired backend reader and analytics client only after operator authorization and the upstream A2/PR40 evidence migrations. Run the existing GET-only parity probe with a dedicated approved identity and known controlled orders; retain exact backend/client revisions and a completed report. A green source test is not a provider receipt. Rollback retains immutable evidence and the unavailable state; never restore broad-key fallback or claim the prior mutable baseline was equivalent.
