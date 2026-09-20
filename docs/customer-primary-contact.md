# Primary-contact candidate for launch issue #365

Status: work in progress, not release-ready. This branch is based on backend main `d944c5e`. It implements the C1 contact/provenance interface; #337 still owns full delta/password/history reconciliation, #366 verified receipt-email activation, and #341 operational consent reconciliation. No live customer, migration or provider writes have occurred.

## Contract

`POST /store/customers/me/contact` uses authenticated customer ownership, not a caller-supplied customer ID. Input is a syntactically valid US `phone`, `expected_revision`, `request_id`, optional boolean `sms_marketing_opt_in`, and optional confirmation `{version,address_id,preferred_email}`. A confirmation requires explicit legacy provenance and an address belonging to that customer. The preferred email creates only a `pending_verification` request; it cannot change login or active receipt identity.

The transaction locks the customer, reconciles the exact customer-ID/unbound-email communications profile, and writes primary mobile, versioned attestation, destination-specific consent and an audit event together. It never joins accounts by phone. The last request hash makes immediate replay idempotent; stale revisions cannot reverse a newer edit. A changed number resets SMS permissions unless fresh marketing consent is explicitly supplied. Order-text consent remains separately collected per order. The record says `customer_attested`; possession/line-type verification remain null.

`migration_provenance_v1` records source identity and first/last observation. The existing legacy-source/customer-ID pair remains compatible; creation date is not provenance. The importer holds email-only/conflicting mappings before auth/history mutation. Its contact patch does not copy a phone over a confirmed target or overwrite target receipt/consent metadata. Source watermark and run ID stay null until #337 supplies a real manifest. This does not complete #337's full migration acceptance.

Marketing and order-text senders re-read the owning customer's primary destination before queue processing and again before provider I/O. Historical orders are not redirected; retired destinations and consent predating replacement are held. Already accepted/in-flight provider requests cannot be recalled. Delayed profile upserts evaluate protected phone/consent state against the current SQL row. Native Store profile writes cannot manufacture provenance or bypass the contact endpoint.

## Evidence and stop

Eight isolated PostgreSQL tests passed using installed native customer table SQL and the actual communications table migration. They cover all-or-nothing rollback, competing revisions, replay, source identity conflicts, shared-phone isolation, stale profile updates and recipient retirement. These are contact persistence tests, not a full running Medusa/customer/provider rehearsal. No production credentials are used.

Initial four-suite unit run: 114 passed, one failed because an older concurrent-profile fixture lacked `whereRaw`. The targeted retry added that query method; both SMS transport suites including new after-claim replacement checks passed, but the same older fixture now expects a literal phone instead of the intentionally guarded SQL expression (`communications.unit.spec.ts`, concurrent first profile insert). Retry limit reached: no further equivalent run this session. Preserve the guard; reconcile the fixture's raw-SQL expectation and realistic readback at a later authorized recovery step. Do not represent this branch as CI-green.

Initial TypeScript found the newly needed order `customer_id` type and a storefront null/undefined mismatch. Both source corrections are present; final TypeScript has not been rerun. `ORDER_FIELDS` now fetches customer ID so real transactional notices have an owner for the destination guard.

## Required completion before review/release

- Reconcile the stopped legacy test fixture without weakening protected SQL semantics; finish focused action/route coverage, then obtain authoritative TypeScript and exact-head CI once the recovery is permitted. Preserve the existing PostgreSQL receipt unless changed inputs invalidate it.
- Finish the mutation-boundary review: staff/Admin phone updates and concurrent generic customer metadata writes must not leave the UI's phone and primary authority inconsistent or erase a new confirmation. Preserve A2 staff permissions when integrating middleware. An ORM metadata merge is not itself proof against concurrent stale writes.
- Verify the existing form and profile editor in desktop/mobile browsers, including keyboard, saving/error/conflict recovery and permission states. Eight focused storefront tests pass; browser and deployed behavior remain unproved.
- Rehearse a controlled legacy delta with source manifest, target-confirmed contact/opt-out preservation, legitimate old confirmations and explicit conflicts. Do not rerun production imports from this document.
- Prove native customer/profile/identity readback, delayed/retried sends and program-specific STOP/START behavior using approved controlled recipients. Keep #366 receipt activation and #368 historical order corrections separate; no production SMS/email is authorized by these tests.
- Obtain coordinated release/rollback and runtime acceptance. Do not close #365 or its downstream issues on source evidence alone.
