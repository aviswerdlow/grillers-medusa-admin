# Prepare the launch stock baseline

Tracking: [strategy #312](https://github.com/aviswerdlow/grillers-pride-strategy/issues/312).

This command prepares a protected **read-only review**, not an approved baseline or a cutover. It does not enable tracking, create inventory links or levels, alter reservations, start the sync queue, or connect QuickBooks. The remaining allocator, inventory-only cutover and concurrency/release acceptance work stays open in #312.

## Run

Use the backend repository with its locked dependencies and supported Node version. Load these existing values through an approved local secret mechanism; do not paste credentials into terminal history, issue bodies or reports:

- `MEDUSA_BACKEND_URL`: the exact intended HTTPS Medusa origin, with no path or query.
- `MEDUSA_PUBLISHABLE_KEY`: the storefront's existing publishable key, which determines the launch catalog's sales-channel visibility.
- `MEDUSA_ADMIN_READ_TOKEN`: the existing Basic-auth value used by the GET-only bridge reader. It is already encoded. This variable name does not grant new permissions; the collector only makes GET requests and refuses redirects.

Run against a **new absolute directory** outside the repository:

```sh
yarn inventory:baseline:review /absolute/protected/path/stock-review
```

The directory is created with mode `0700`; `snapshot.json`, `review.json` and `review.csv` use `0600` and exclusive creation. An existing directory is refused, preserving previous reviews. Console output contains aggregate counts and exception categories only. Keep files in the protected operating record; they include internal catalog, order-line and stock identities. Do not upload them to a public issue. Provider error bodies and transport diagnostics are not printed.

All catalog, inventory-item, stock-location, reservation and active-allocation pages are read. Collections with totals must keep a consistent total; incomplete, duplicate or mismatched pages fail the review. The allocation API has no total, so the collector continues to a short final page. A failure produces no completed review. Correct the cause before one targeted retry with a new output directory.

This is a sequential observation, **not an atomic or quiesced snapshot**. No report is approved for writes. Re-read under the eventual approved cutover procedure; unchanged counts alone do not prove unchanged stock or commitments.

## Review with Peter and the stock operator

The table starts from Store API visibility and joins admin variants by stable identity. It uses #322's shared product/variant internal-item predicate; a mixed product containing an internal variant is excluded as a whole. Inactive and out-of-stock retail products are not silently conflated with raw materials. The report is a candidate set, not approval to sell every row.

For each candidate, resolve every mapping exception and provide:

1. The source company/export or physical count, its time, the stable QuickBooks ListID, and the operator who reviewed it. A mutable SKU is context only.
2. The sellable-unit definition and approved usable quantity. Keep pack counts, catch-weight measures and `required_quantity` conversion explicit. Missing quantities stay unknown; the tool does not substitute zero, floor a physical weight into packs, or treat an untracked variant as unlimited stock.
3. The approved Medusa stock location and item/component mapping. Resolve missing links/levels, shared items and duplicate ListIDs before enabling tracking. Existing stock-location names do not establish operating approval.
4. The treatment of committed/in-flight orders. Native reservations and advisory allocations are displayed separately; matching order-line/item identities are available for reconciliation. Never subtract both ledgers merely because both have nonzero totals. An advisory row without a matching native reservation is an exception to investigate, not permission to delete the row or reserve it twice.
5. Reviewer, approval time and disposition of each exception. Leave unresolved rows blocked. The blank approval columns are preparation fields, not an executable write manifest.

The current-state fingerprint covers inventory configuration and the observed native/advisory state for the row. It helps compare reviews; it is not an authorization signature or a concurrency lock.

## Remaining release gates

- #322 must pass its catalog runtime checks before #312 closes.
- #359 supplies usable-stock/receiving policy; #321 supplies the ongoing receiving interface. A production QBD company switch (#317) is not a prerequisite for preparing this baseline.
- Preserve the native Medusa reservation/locking path. Reconcile advisory overlap and prove concurrent last-unit checkout, cancellation and explicit pre-fulfillment line-quantity refunds. Coordinate refund changes with backend PR 29's durable financial-action contract.
- The legacy bridge cutover currently calls the broader product-sync path. Do not run it, restore the deliberately absent broad writer, or start dormant jobs as a shortcut. Prepare and review the separate inventory-only operation, its recovery record and exact authority before any baseline mutation.
- Approval, baseline execution, native allocation readback, operator sign-off and runtime acceptance are separate evidence. A completed report closes none of those gates.
