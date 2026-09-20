# Unverified reservation candidate for strategy #312

This branch is work in progress on top of baseline-review PR 31. Do not merge or deploy it on the strength of the focused unit checks. Production has 420 untracked retail candidates, so enabling the new refusal paths before the separately approved baseline would stop those checkouts.

## Implemented candidate

- `inventory-stock.ts` requires tracked native inventory, backorders off, complete component mappings and stock-location levels. Cached QBD/direct quantities and unmanaged inventory no longer imply unlimited stock. Decimal component quantities use Medusa's decimal arithmetic.
- Availability compares advisory commitments to native reservations by order-line, item and location. Mirrored demand is not subtracted twice. Unmatched or unmapped demand blocks affected availability until reconciliation; a read-time subtraction cannot protect that demand atomically. Shared component demand is included across variants.
- A date beyond the replenishment lead time does not establish incoming supply. No speculative `future_allowed` or estimated restock date is returned; #364 must add its confirmed, quantity-limited supply contract.
- Trusted placement calls can recognize their own native reservation without giving that credit to another shopper. Creation and whole-order advisory release use a database order-row lock. Existing allocation rows, including released rows, prevent late placement replay. Canceled orders are ignored.
- Native cart completion and payment endpoints have a stock guard as well as #322's eligibility guard. The custom place-order route already invokes the shared availability check.

The existing `Migration20260525170000` **already contains** `UQ_gp_inventory_allocation_active_line`. Preserve it. The DML model index list alone is not the schema source of truth. The candidate adds serialization/idempotent handling, not the first unique constraint.

## Verification and stop point

38 focused tests passed across stock arithmetic/policy, existing allocation behavior, the baseline report and subscriber alerts. TypeScript passed at that point. The new native database fixture was added afterward and is not verified.

The native fixture intentionally uses the installed Medusa inventory module and reservation-step handlers, PostgreSQL, and two independent native Redis locking providers. It does not substitute a fake stock service or claim a complete payment/order HTTP rehearsal. It currently **fails before assertions** during DML schema creation: an unqualified `CREATE INDEX ... ON inventory_item` cannot find the table created in the disposable schema. Adding a connection search-path option did not resolve the same failure. Two attempts occurred; the repository retry limit stops another equivalent run in this task.

Last failed fixture log: `/tmp/gp-launch-312-native-retry.log` in the authoring environment. No passing native concurrency, cancellation or endpoint result exists. `test:inventory` has not been added to CI yet; normal CI alone would therefore be incomplete evidence. No full CI run or deployment has been requested for this candidate.

## Next action and remaining gates

Correct the native fixture's schema initialization and prove which schema its index statements use before a new full fixture attempt. Keep it in a disposable local/test database; do not repair production schemas. Preserve and report the existing failed gate instead of removing or mocking it away.

Then verify the real QueryGraph stock read (including whether the old `+inventory_quantity` field/fallback is still appropriate), order-row locking, concurrent native last-unit reservation, placement replay, cancellation and direct native endpoint refusal. Add the required PostgreSQL/Redis gate to CI and record the exact head. The fixture's graph adapter is still a test adapter; complete HTTP checkout and provider receipts remain separate acceptance.

Explicit pre-fulfillment quantity refunds remain unfinished. Integrate backend PR 29's durable refund-request/cross-order contract before changing those callers; this branch does not contain PR 29. Verify native reservation release as well as the advisory ledger, with replay and concurrent/refund limits. Do not infer inventory release from a Stripe refund alone.

Customer/staff stock-error copy and the operations guide need a coordinated frontend candidate before release, particularly to avoid offering a speculative later date for a baseline/reconciliation block. #364 owns confirmed future supply. The approved inventory-only baseline operation, Peter's data/location/commitment disposition and original runtime acceptance remain open in #312.
