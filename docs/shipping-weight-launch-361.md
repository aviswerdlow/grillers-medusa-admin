# Reviewed shipping inputs — issue 361

Tracks [strategy #361](https://github.com/aviswerdlow/grillers-pride-strategy/issues/361). This is a source candidate, not a production migration or release approval. Deploying before reviewed catalog data and packing rules exist makes UPS quotes unavailable by design.

## Contract and code ownership

`shipping_weight_v1` in Medusa variant metadata owns operating weight data; product metadata is a fallback only when the variant key is absent. A malformed variant override fails rather than falling through. Its approved, versioned record retains the raw SAM string, the source item/revision/capture time, review attribution, physical value/unit/basis, units per sellable pack, and separate calibrated fit units. No raw SAM scalar is automatically physical weight. Pack-size conversion happens once: ounces / 16 × inner-unit count × sellable quantity. A per-sellable-unit weight requires an inner-unit count of one. Pricing metadata and product copy are not inputs to this mass calculation.

`shipping-catalog-inputs.ts` loads variant and product metadata by stable Medusa variant ID. The native Medusa rate query does not load these metadata columns. Fulfillment explicitly depends on `query` and resolves it lazily through its injected container. Request-body catalog, service identity, measured packages and cart weight snapshots cannot override reviewed catalog records during checkout.

`shipping-packing-plan.ts` packs indivisible sellable units with both fit and physical capacity constraints. Each package contains external dimensions, contents, physical food mass, dry ice, tare and gross mass. The plan records policy and fit-rule versions plus transit provenance and optional dispatch/arrival dates. Among eligible uniform-box plans it deterministically selects the lowest box-plus-ice cost, then the fewest boxes. **Peter must approve this selection rule and the calibration; a policy name alone is not business approval.** This is a capacity heuristic, not a three-dimensional packing solver. More boxes may require more real ice and tare; fit units themselves never add physical mass.

The existing ZIP3 transit adapter is labelled `legacy_zip3_v1`; it does not prove the selected arrival date or seasonal adequacy. #362 supplies a server-validated dispatch/arrival/transit revision; #363 supplies the seasonal rules and reviewed carrier gross limits. Until those are integrated, null dates remain null and existing transit assumptions remain visible.

At shipping-method selection, the provider replaces caller packing data with the server plan. The native completion middleware and custom card/invoice routes prepare line and cart snapshots before `completeCartWorkflow` loads its cart. Its validate hook compares the exact loaded cart with the trusted selection/catalog so stale quantities or records stop completion. Completed-cart replays do not refresh old orders. The installed Medusa 2.10.3 `prepareLineItemData` copies item metadata, and complete-cart copies cart and shipping-method metadata. **A deployed native-workflow rehearsal is still required**, including concurrent cart changes, retry/compensation, provider container injection and registered hook loading. Unit mocks do not prove database serialization. Coordinate this boundary with #312/#318/#322/#368; do not overwrite their middleware or checkout guards when integrating branches.

Store JSON responses remove the three new operating namespaces (`shipping_weight_v1`, `shipping_weight_snapshot_v1`, `shipping_packing_plan_v1`), including nested variant metadata. Staff/backend queries retain them. This is not a substitute for #322's existing catalog eligibility controls.

Final staff carrier requests use actual package rows ahead of estimates. Gross weight and dimensions must be positive and configured; the one-pound fallback is removed. No carrier booking, label purchase or final-charge change is performed by this candidate.

## Import procedure

Use a fresh, read-only SAM ITEMS extract with `ID`, `LISTID`, raw string/null `SHIPWEIGHT` and `TIMEMODIFIED`. Keep exports and review files in a protected directory outside the repositories. `samWeightRevision` hashes precisely those source fields. Join only by QBD ListID; duplicate source/target IDs and unknown mappings are explicit errors. RM/internal lifecycle records are excluded. Packaging and nonphysical classification requires review and null mass/fit fields. An approved existing override survives unless its exact record hash is named in `replaces_record_sha256`.

The review file is an array of `{ record: ShippingWeightRecord, replaces_record_sha256?: string }`. An empty array produces a review-only report. Reviewers must approve actual physical mass/basis and fit calibration; the roughly 5 lb/1.5 lb conversation examples are not defaults. Existing SAM values can support a bulk review plus an exception list; nobody needs to re-enter the entire catalog manually.

Run in the reviewed target environment using `medusa exec src/scripts/import-sam-shipping-weights.ts --` followed by:

1. Dry run: `--source /protected/sam-items.json --reviews /protected/reviews.json --output /protected/run-01`. The report includes changed, unchanged, unmatched, ambiguous, excluded, pending review and preserved override counts. It enumerates backend variants, including historical/admin-only records; resolve the report's identity errors before writes. The local read-only launch report separately covers the Store-visible 767-variant snapshot.
2. After action-time authorization, one canary: `--write --plan /protected/run-01/plan.json --expected-plan <plan-id> --canary-id <variant-id> --operator-approval-ref <issue-comment-url> --output /protected/canary-01`.
3. Inspect the protected before/after manifest and verified receipt; read the chosen record through the staff path and verify customer copy, price, lifecycle and public shipping behavior. A write/readback receipt alone does not authorize a batch.
4. After authorized batch approval: use the same original plan and expected ID, replace `--canary-id` with `--canary-receipt /protected/canary-01/receipt.json`, and use a new output directory. Batch verifies the canary is unchanged and skips it.

Each write locks the variant row, compares the full dry-run metadata, merges only the shipping namespace, and reads back inside that transaction. A concurrent edit aborts, with no automatic retry. This deliberately updates operating metadata directly; it does not emit a product editorial-sync event or write Strapi product content. There is no blanket rollback command: a failed batch may have committed earlier verified rows. Keep the per-row prepared manifests, stop, inspect readback, and obtain a fresh dry run. Do not overwrite later changes with an old backup.

## Forecast and reporting boundary

Historical GBM feature/parity vectors and its model artifact remain unchanged. The historical training weight was derived from QBD order/pricing/description facts; this candidate does not assert that it was raw SAM physical weight. New runtime inputs are labelled `shipping_weight_v1.physical_lb`. `forecastShippingCost` rejects models without that exact contract, using the existing carrier/tier fallback only after reviewed physical/packing inputs pass. Adding that label to a model without validation is prohibited. Owner #361/#363 must supply a reviewed model-validation receipt or explicitly use approved non-model rating for launch.

The shipping subscriber reads the accepted packing snapshot, not today's Strapi costs or catalog weights. Legacy orders without a snapshot report unavailable values. It reports `estimated_packaging_cost` separately from observed `charged_shipping`; `freight`, `packaging_cost` and `packaging_included_in_charge` are null until #331/#368 establish the versioned charged-price composition. #369 must consume these availability states without treating null as zero and join later measured packages/bills. Reconcile consumers before release. No analytics record includes the private item-weight provenance or ListIDs.

## Required handoffs and remaining acceptance

- **#358 Peter:** identify which SAM entries are physical per sellable unit versus space proxies; approve measured pie mass, pack basis, exception list, fit calibration and packing selection rule. Approve excluded packaging/gift identities and actual operating dates through their existing issues.
- **#363 / #362:** calibrated capacities, dimensions, ice/tare/season rules, provider gross cap, dispatch/arrival/transit contract. The Strapi companion adds optional policy/fit fields without publishing values.
- **#329 / #331:** signed customer charge policy and common composition across forecast, carrier/tier fallbacks and final charge. This candidate does not change WWEX freight into an all-in customer charge.
- **#368:** full immutable accepted-order promise and price snapshot, refresh/race handling and signed policy revision; preserve these weight/plan snapshots rather than recalculating them at packing.
- **#369 / #335:** nullable-estimate consumer behavior, accepted-plan correlation and separate later actual/billed costs.
- **A3 / #312 / #322 / #318:** shared metadata namespaces, native completion and Store projection integration with stock/public/staff guards.
- **Release owner:** exact-head CI, authorized one-record import/readback, native custom-card + invoice + normal-completion rehearsal, customer projection checks, missing-weight failure UX, actual-package rating, rollback readiness and approved deployment. No live import or release has occurred.
