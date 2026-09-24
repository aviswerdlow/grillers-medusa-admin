# Primary-contact candidate for launch issue #365

Status: staged review candidate, not activated. This branch has been actually rebased onto receipt-email PR37 (`92b49ec9`), which contains backend main `369fe762`. It implements the C1 contact/provenance interface; #337 still owns full delta/password/history reconciliation, #366 verified receipt-email activation, and #341 operational consent reconciliation. No live customer, migration or provider writes have occurred.

## Contract

`POST /store/customers/me/contact` uses authenticated customer ownership, not a caller-supplied customer ID. Input is a syntactically valid US `phone`, `expected_revision`, `request_id`, optional boolean `sms_marketing_opt_in`, and optional confirmation `{version,address_id,preferred_email}`. A confirmation requires explicit legacy provenance and an address belonging to that customer. The preferred email creates only a `pending_verification` request; it cannot change login or active receipt identity.

The transaction locks the customer, reconciles the exact customer-ID/unbound-email communications profile, and writes primary mobile, versioned attestation, destination-specific consent and an audit event together. It never joins accounts by phone. The last request hash makes immediate replay idempotent; stale revisions cannot reverse a newer edit. A changed number resets SMS permissions unless fresh marketing consent is explicitly supplied. Order-text consent remains separately collected per order. The record says `customer_attested`; possession/line-type verification remain null.

`migration_provenance_v1` records source identity and first/last observation. The existing legacy-source/customer-ID pair remains compatible; creation date is not provenance. The importer holds email-only/conflicting mappings before auth/history mutation. Its contact patch does not copy a phone over a confirmed target or overwrite target receipt/consent metadata. Source watermark and run ID stay null until #337 supplies a real manifest. This does not complete #337's full migration acceptance.

Marketing and order-text senders re-read the owning customer's primary destination before queue processing and again before provider I/O. Historical orders are not redirected; retired destinations and consent predating replacement are held. Already accepted/in-flight provider requests cannot be recalled. Delayed profile upserts evaluate protected phone/consent state against the current SQL row. Native Store profile writes cannot manufacture provenance or bypass the contact endpoint.

## Standalone deployment and defaults (#372)

`GP_PRIMARY_CONTACT_ENABLED=true` enables the new attestation endpoint; unset, false and other values leave it disabled. The default is off. An authenticated request to the disabled endpoint returns 404, allowing the paired frontend's phone-edit fallback and independent session deferral. Native Store phone/profile edits retain current-main behavior for accounts without the new attestation state while off. A legacy write cannot manufacture new primary-contact/confirmation/provenance records; confirmed records stay protected during rollback. The native customer check still fails closed on missing identity or database errors. No production flag was changed.

The flag is needed because the earlier candidate's unconditional native-write guard would reject current storefront main's phone edits. This source change stages the new contract safely; it does not claim the native Admin/staff and concurrent metadata mutation boundary is complete. Keep activation off until those gates below are resolved. The paired frontend never stamps a confirmation or grants SMS permission merely because a fallback succeeded; its checkbox supplies the actual choice, and account deferral is session-scoped.

Receipt-email behavior is inherited from PR37. Changing the primary mobile does not verify a receipt destination, change sign-in identity or rewrite an accepted order. Calendar enforcement inherited from PR34 defaults off; shipping/data and original launch prerequisites still apply. This candidate adds no schema migration, but the inherited migrating stack still requires a fresh protected database backup, recorded recovery target/procedure, previous/candidate SHAs and migration journal before release. Keep accepted contact, receipt, consent and accounting evidence on rollback.

## Evidence and previous stop

The original eight isolated PostgreSQL checks cover all-or-nothing rollback, competing revisions, replay, source identity conflicts, shared-phone isolation, stale profile updates and recipient retirement against native customer SQL and the actual communications schema. The rebased CI retains those checks alongside public-catalog, accounting and receipt suites in one isolated PostgreSQL service; no production database is used.

The earlier run stopped on an old concurrent-profile fixture that expected a literal phone where protected SQL is now intentional. The September 21 review explicitly resumed this integration on a new base. The fixture now asserts the guarded SQL and supplies realistic persisted readback; the protection was not removed. All 121 focused contact/communications/SMS checks and TypeScript pass. Exact-head CI must verify the rebased PR before any source-ready claim. The preserved #345 consumer-form fixture stop and other native/provider gates are not cleared by these checks.

## Required completion before review/release

- Obtain exact-head CI for this integrated branch, including native-schema PostgreSQL contact persistence. Focused checks/type validation do not establish production or provider acceptance.
- Finish the mutation-boundary review: staff/Admin phone updates and concurrent generic customer metadata writes must not leave the UI's phone and primary authority inconsistent or erase a new confirmation. Preserve A2 staff permissions when integrating middleware. An ORM metadata merge is not itself proof against concurrent stale writes.
- Verify the existing form and profile editor in desktop/mobile browsers, including keyboard, saving/error/conflict recovery and permission states. Eight focused storefront tests pass; browser and deployed behavior remain unproved.
- Rehearse a controlled legacy delta with source manifest, target-confirmed contact/opt-out preservation, legitimate old confirmations and explicit conflicts. Do not rerun production imports from this document.
- Prove native customer/profile/identity readback, delayed/retried sends and program-specific STOP/START behavior using approved controlled recipients. Keep #366 receipt activation and #368 historical order corrections separate; no production SMS/email is authorized by these tests.
- Obtain coordinated release/rollback and runtime acceptance. Do not close #365 or its downstream issues on source evidence alone.
