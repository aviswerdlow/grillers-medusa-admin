# Receipt email verification and accepted-order recipients

Candidate implementation for [strategy #366](https://github.com/aviswerdlow/grillers-pride-strategy/issues/366), September 20, 2026. Source and isolated checks are not deployment or provider acceptance. Keep the strategy issue open until its original acceptance and the gates below are met.

## Customer contract

`GET /store/customers/me/receipt-email` returns uncached public state. Authenticated `POST` supports:

| Action | Required fields | Effect |
| --- | --- | --- |
| `request` | `email`, `expected_revision`, unique `request_id` | Leaves the active destination unchanged; persists a challenge then requests a service email. |
| `verify` | `challenge_id`, `code` | Activates only an unexpired, unused challenge belonging to the authenticated customer. |
| `revoke` | `expected_revision`, unique `request_id` | Cancels pending changes and returns future order receipts to the established login email. |

The actor comes from customer authentication, never a submitted customer ID. The storefront denies receipt changes while staff impersonation is present. Integrating backend staff authority is a separate #318 gate; an impersonation UI check does not establish backend denial.

Challenges use a random 16-hex-character code, a purpose/customer/address-bound SHA-256 hash, 15-minute expiry, five failed attempts, at least 60 seconds between requests and at most five requests per hour per account. Replays never return another delivery code. Tokens are not placed in URLs. Notification delivery receives the code; the challenge table and audit event do not store its plaintext. Verification consumes the hash in the same transaction as activation and audit. Collision information is withheld until mailbox possession is proved; conflicts offer support without merging accounts. Database row/advisory locks and unique indexes arbitrate concurrent requests and claims.

`gp_receipt_contact` is the authority. Old `preferred_contact_email` or #365 `preferred_contact_email_request` metadata is only an unverified form suggestion. Neither legacy metadata nor a customer import activates or overrides the authority. A newer first-login suggestion can be retried after partial delivery failure. Login/password reset and marketing consent are unchanged. Global/hard-bounce/complaint suppression is visible; challenge failure leaves the prior receipt address active. Marketing to an alternate receipt address is suppressed unless a separate mailbox consent path supplies the matching identity.

## Order and communications handoff

`prepareReceiptSnapshot` locks the cart and owning customer, selects the current verified preference or established checkout/login destination, and creates an immutable `gp_receipt_snapshot`. Cart metadata contains only `receipt_contact_snapshot_id`; client-supplied pointers must match the cart, owner and current revision. Existing metadata is merged, not replaced.

The native Store cart-complete middleware and both branches of custom `/store/grillers/checkout/place-order` prepare the snapshot. The existing single `completeCartWorkflow.hooks.validate` handler validates it while preserving calendar and shipping acceptance. Do not register a second handler: the installed Medusa workflow SDK permits only one.

The order's copied pointer must match its actual `order_cart` link. `fetchOrderForEmail` resolves that immutable row for confirmation, shipment, final charge, cancellation and refund subscribers. Historical orders without a pointer retain stored `order.email`. Profile edits and revocation never redirect an already accepted order. #368 owns any audited recipient amendment; it must retain previous evidence and must not rewrite snapshot rows.

Communications messages keep the actual destination while customer profile/identity mapping retains the established account email. Historical service notices can still use a soft-deleted customer's retained identity. A physically missing customer identity fails closed; it does not recreate ownership from a receipt mailbox. Existing message logs/recipients are never rewritten.

## Integration and activation gates

1. **Stack:** this backend candidate is based on #331 PR36 (`8002d4660afbf099ef4072d9bbdbd49428dcff05`) to preserve the shared B1/B2 checkout hook. #365 backend WIP is not included because its stopped legacy fixture remains unresolved. Its contact/migration changes must be reconciled with `core.ts`, middleware and `order-fetch.ts` before release. The storefront candidate is stacked on the #365 contact-confirmation branch.
2. **Native checkout:** isolated tests use native customer table SQL and actual communications migrations, but narrow cart/link fixtures. Rehearse both supported entry paths in a running Medusa test lane, including guest, customer, repeat completion and concurrent receipt changes; verify cart-to-order metadata copying and all five actual subscriber destinations. #332 owns the coordinated rehearsal.
3. **Other order entry:** the launch staff flow uses the custom cart checkout above. Native Admin draft-order creation/confirmation and any import-created orders have not been certified for this snapshot contract. #318/#368 must deny unsupported entry or integrate the same immutable contract before enabling it. Do not represent native draft creation as covered by cart tests.
4. **Staff authority and amendments:** #318 combines the signed staff gateway and backend deny rules. #368 implements separately authorized, audited corrections to unfulfilled orders; no correction endpoint is added here.
5. **Migration:** #337 must demonstrate repeatable deltas preserving this authority, newer passwords/preferences/opt-outs and account isolation. Metadata-only tests do not prove a live delta.
6. **Communications:** approved controlled mailboxes/provider access are required for challenge, bounce and actual new-order delivery receipts. #340 certifies final-domain templates and provider receipt; #341 preserves mailbox-specific marketing consent and suppressions; #367 uses the same order recipient contract for new local-delivery milestones. No real message is sent by the tests.
7. **Customer UX:** #345 verifies desktop/mobile keyboard, save/conflict/recovery behavior and visual fit with the combined #365 form. Component tests are not browser proof.

## Deployment and recovery

`Migration20260920121500` adds three tables and indexes; it does not backfill customer records or rewrite historical orders. Apply it only in the reviewed deployment sequence, before activating the new route/checkout code, with a verified database backup and compatible backend/frontend pair. No production migration has run for this change.

Retain these tables and the recipient resolver during application rollback once any order references a snapshot. Reverting to an old resolver can redirect future notices for those accepted orders back to `order.email`; stop the affected worker/checkout path and deploy a compatibility fix or reviewed forward recovery. The migration's `down` deliberately refuses destructive removal. Restoring a database snapshot requires explicit accounting/order reconciliation, not automatic rollback.

## Verification

The PostgreSQL suite `integration-tests/receipt-email/receipt-email.spec.ts` covers transactional requests, expiry/replay/collisions, failed-attempt persistence, concurrency, audit rollback, suppression, immutable/stale/forged pointers, metadata isolation, and real communications core with a fake notification provider. Use only an explicitly isolated `RECEIPT_TEST_DATABASE_URL` with `TEST_TYPE=integration:receipt-email yarn jest --runInBand`; it creates and removes an isolated schema.

Focused route/template tests cover customer authentication, safe error delivery and existing place-order behavior. Exact-head CI adds the full unit stack, TypeScript, accounting PostgreSQL regression suite and receipt PostgreSQL suite. The storefront CI owns its full tests/TypeScript/build and operations-guide gate. Evidence and any outstanding failures belong on #366; green source checks alone do not close it.
