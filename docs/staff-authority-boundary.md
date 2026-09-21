# Staff gateway, capabilities and revocation — launch #318 / #319

Candidate implementation in backend PR 32, paired with storefront PR 50; stacked on #314 backend PR 29 / storefront PR 47. Neither issue is closed. Owner policy approval, current-grant provenance review, configured isolated identities, integration, deployment and runtime recovery/role proofs remain gates. No live access or provider setting was changed for this patch.

## Verified identity and capabilities

Medusa authenticates every `/admin/*` transport first. The configured gateway API-key ID also requires the original customer's signed, unexpired Medusa JWT in `x-gp-staff-authorization`. The backend checks signature, actor type, identity, issuance/expiry and fresh customer authority for each request. Body names/emails never establish identity. In enforce mode, lookup failures, unknown credentials and routes outside the capability map are denied, including for storefront owners. In default log mode, Medusa transport authentication still applies and the proposed capability denial is logged/alerted without blocking the existing handler. No unclassified credential becomes a verified person.

The three storefront admin consumers share `staff/admin.ts`: staff actions, phone-order/customer entry and inventory checks. It forwards the original cookie token, prevents auth-header substitution, restricts paths to the backend admin origin and refuses redirects. Store `/customers/me` returns response-only `staff_access`, computed from a fresh authority read. The storefront retains its capability checks and removes the admin-profile fallback for stale customer sessions.

This candidate retains existing console policy. Avi/account administrator must approve it before activation; the optional Office refund/cancellation policy question remains unanswered.

| Role | Customer / order support / communications / accounting | Pick | Pack | Preview / approve / fulfill | Final card charge | Team access |
| --- | --- | --- | --- | --- | --- | --- |
| Customer / revoked / unknown | No | No | No | No | No | No |
| Office | Yes | No | No | No | No | No |
| Picker | No | Yes | No | Yes | Explicit grant | No |
| Packer | No | Yes | Yes | Yes | Explicit grant | No |
| General staff / Manager | Yes | Yes | Yes | Yes | Explicit grant | No |
| Merchandising reviewer | No; merchandising catalog read only | No | No | No | No | No |
| Super admin | Yes | Yes | Yes | Yes | Yes | Yes |

Warehouse roles can read needed orders/inventory. Office retains capture/cancellation, the custom idempotent refund route and accounting support. Final-charge permission never grants saved-card/customer access. Generic order metadata writes and native refund bypasses are denied to the gateway; dedicated workflows own payment/release state. Accounting handoffs cannot overwrite final-charge, release or actor authority. Approval emits the optional auto-charge signal only for a verified charge-capable person or separate privileged operator; #313's business/provider guards still apply.

Invoice terms use the dedicated audited endpoint, the existing approver email allowlist and, for customer gateway identities, an approved immutable customer ID. Ordinary profiles cannot grant invoice eligibility/credit terms. This authority protection does not complete #370's accounting/business reconciliation.

## Grants, revocation and recovery

Enforced bootstrap privileges use `GP_STAFF_BOOTSTRAP_CUSTOMER_IDS`. During log-only staging, the existing Avi/Peter bootstrap allowlist remains available to authenticated customer records; storefront bootstrap survives only until response-owned `staff_access` is served. Log mode does not publish that field. Server authority always wins once present, and the legacy fallback honors revocation and explicit bootstrap override. Revocation wins. A role change sets `staff_bootstrap_override=true`, so demotion/regrant cannot silently restore the initial owner role.

POST `/admin/grillers/staff-access/customers/:id` requires Team access or a separately configured privileged native operator, current `expected_version`, a reason, typed confirmation and valid role. Self-demotion is refused. Recovery configuration must exist before grants change. A transaction locks actor and target in stable order, rechecks the owner's current grant/session, compares the version and atomically writes canonical permissions, revocation, the monotonically nondecreasing `staff_access_valid_after` cutoff, an incremented version, and a named before/after audit. The dedicated `staff_access_audit_log` is not trimmed by ordinary profile notes; recent staff history also gets the event.

No table migration is needed. Generic admin profile edits strip unchanged grant snapshots and reject permission changes/clearing. Office cannot edit a staff account or its addresses. Public account writes reject role, charge, session, audit, customer-credit and invoice-authority fields. These protections do not authenticate historical grants; a protected provenance review is still required.

Old JWTs cannot perform privileged gateway or saved-card actions after an access change, including regrant. Native refresh and session creation enforce the cutoff, including pre-registration tokens whose customer identity is hydrated during refresh. A fresh password sign-in issued after the cutoff is required; same-second tokens are conservatively refused. Ordinary customer self-service remains available. Requests admitted before revocation may finish; role transactions additionally recheck the actor under lock.

Recovery uses a separately authenticated native Medusa user in `GP_PRIVILEGED_ADMIN_USER_IDS`, read fresh each request, and the same audited grant endpoint. Removing the configured ID or deleting the account denies later requests. This is an explicitly privileged operations identity, not a picker or perpetual storefront bypass. Real recovery configuration and rehearsal are prerequisites, not implied by synthetic fixtures.

## Audit attribution and remaining interface

Custom finalization, refunds, accounting handoffs/retries, legacy mappings/reorders and communications use the verified person. Native order/payment workflows receive that person's actor ID only after transport authentication and capabilities pass, so `captured_by`/`canceled_by` do not name the shared key. The original transport ID remains on the request principal. Fulfillment and customer profile/address metadata receive server attribution. Caller audit history must retain its stored prefix; only appended entries get the current actor. Generic profiles cannot overwrite the dedicated grant audit.

### Staff carts and customer checkout links

`POST /admin/grillers/staff-carts` creates phone-order and customer-context carts through the native workflow, then stores a backend-signed receipt bound to the actual cart, buyer, staff identity, grant version, original session issuance and seven-day expiry. The workflow may resolve a guest account by email; the receipt records the resulting customer ID. An unsuccessful receipt write leaves an unused cart whose staff effects are denied. It never prepares payment. The existing storefront link signature still controls opening the link; it does not replace this backend authority.

Every public cart mutation/read, payment-collection entry and checkout completion validates marked staff carts against the current creator's Office capability, grant version and revocation cutoff. Card-by-phone and customer-context carts additionally require the original signed staff JWT. Customer checkout links allow the intended buyer to proceed while the creator's grant remains current; access changes, expiry, a different signed-in buyer, changed recipient or an old unsigned staff cart require re-preparation. Regrant does not revive an old receipt. Staff tokens travel separately from native buyer authentication. Native card-session creation receives the receipt's customer ID, never the Office account. A supplied body cart ID cannot override the cart linked to the payment collection. Public system-provider selection is denied for staff carts; approved invoice completion continues through its dedicated backend workflow.

Public metadata cannot create staff attribution, stock overrides or payment/release authority. Authorized staff mutations receive canonical backend actor fields; caller-supplied actors and audit history cannot win. Each stock override has its own signature bound to the cart receipt, variant, quantity, requested date, reason and note. Changed details require a fresh staff review. Actual ATP is checked before staff payment preparation and completion; inactive items are denied even with an override. Successful native completion retries remain idempotent after the order reserves its stock. This boundary does not replace #312's native reservation/cutover work.

The allocation subscriber verifies the receipt and override signatures before recording staff source, actor or override reason. Historical accepted-order attribution does not depend on the person's current role or the checkout link still being unexpired. Unsigned historical metadata does not become a staff grant or override; it follows system/customer attribution. Keep the configured backend signing key available for pending carts and allocation processing. The signing key uses a separate HMAC context derived from the backend's configured JWT secret; the development default or a missing/short secret cannot issue staff receipts. No secret is copied to the frontend.

Source: `src/lib/staff-cart-authority.ts`, `src/api/middlewares/staff-cart-authority.ts`, `src/api/admin/grillers/staff-carts/route.ts`, the allocation subscriber and paired frontend `staff/cart-authority.ts`, `staff/order-entry.ts`, `cart.ts` and `payment.ts`. The native-handler HTTP fixture proves protected public writes, creator revocation/regrant, recipient/provider binding, signed overrides and attribution through native completion into actual allocation logic. Persistence/payment workflows are controlled fixtures, not deployed provider or stock receipts. Preserve #312's stopped native fixture gate; it was not rerun for this handoff.

## Coordinated release configuration

| Backend setting | Reviewed value |
| --- | --- |
| `GP_STAFF_GATEWAY_API_KEY_ID` | ID of the dedicated key used by storefront `MEDUSA_ADMIN_API_TOKEN`, never its secret token |
| `GP_ADMIN_READ_ONLY_API_KEY_IDS` | IDs of approved GET-only integrations, including #316's reader and storefront background reader |
| `GP_PRIVILEGED_ADMIN_USER_IDS` | Existing native user IDs for separate privileged operations/recovery |
| `GP_STAFF_BOOTSTRAP_CUSTOMER_IDS` | Approved existing customer IDs for initial owners after identity/grant review |
| `GP_INVOICE_APPROVER_CUSTOMER_IDS` | Approved invoice approver customer IDs, alongside the existing email allowlist |

In enforce mode the gateway key cannot fall back to any service class without its staff JWT. The storefront temporarily accepts both `MEDUSA_READ_ONLY_API_TOKEN` and the deployed `MEDUSA_ADMIN_API_TOKEN` for background jobs. Review acquisition also writes send markers: its preferred `MEDUSA_COMMUNICATIONS_API_TOKEN` must map to the communications class, not read-only. The legacy alias is compatibility only while log mode remains active; separate the credential before enforcement. This patch neither configures nor runs scheduled sends.

Before activation:

1. Approve the matrix and immutable identities, review existing grant provenance privately, and verify the independent recovery login. Do not derive IDs from email or revoke/provision real accounts automatically.
2. Integrate #314 and #313 financial protections and #322's parallel middleware changes without replacing other guards. Classify service consumers; keep the deliberately absent legacy writer credential absent.
3. Review paired revisions, guide and exact-head CI. Configure backend identities and the separate reader before enabling the paired frontend. Leave `GP_STAFF_BOUNDARY_MODE=log` (the default) while credential and recovery inventory is incomplete. Switch to enforce only after every consumer is classified and recovery is rehearsed. Invalid nonempty mode settings enforce rather than silently disable the boundary.
4. Rehearse isolated roles against the deployed endpoints, proving denial before provider/data effects, named audits, bootstrap revocation, refresh, regrant and separate recovery. Include phone orders, customer-context shopping, checkout-link expiry/revocation, changed override quantities/dates, the actual buyer on payment sessions and native completion retries. Preserve distinct Medusa/Stripe/sync/QBD receipts. Existing unsigned staff carts must be re-prepared; do not bypass the receipt checks to revive them.
5. Keep a written rollback/recovery path. Reverting code can restore unsafe metadata/email authority. Do not erase newer grant cutoffs to make rollback appear successful; keep affected tools unavailable until the safe boundary returns.

## Verification limits

HTTP fixtures use installed Medusa authentication, route sorting, native capture/refresh/session handlers, registered guards and actual audit helpers. Customer/module/provider boundaries are synthetic. PostgreSQL tests use an isolated temporary schema for real concurrency, rollback and recovery writes. Frontend fixtures check protected headers, no-cookie denial, redirect/path restrictions, server authority and existing actions. Exact-head CI supplies full suites, TypeScript and the frontend build. These are candidate-code receipts, not deployed acceptance or real provider transactions.

## September 21 independent rollout correction (#372)

`GP_STAFF_BOUNDARY_MODE=log|enforce` defaults **log**; invalid configured values enforce. A backend-first log deployment retains existing authenticated Medusa dashboard/API-key access, reports would-be capability denials, does not advertise `staff_access`, and does not issue new staff-cart receipts. Existing unsigned staff carts remain available. A signed cart never downgrades on rollback, including revoked actors and invalid proof. Store customer privilege-field protections and persisted revocation cutoffs remain enforced; logging is not a permission to grant oneself access.

Frontend-first deployment preserves the original owner fallback only when the backend omits `staff_access`; an explicit server customer/denial/stale state wins. Staff cart POST404 can use current native creation only after fresh Office authority without activated server state and a capability GET returning log or 404. Authorization, unknown, conflict, 503 and network failures do not fall back. Ordinary old staff cart creation does not manufacture a server receipt. Team-access changes still require the audited backend and configured independent recovery identity.

### Admin API-key consumer classification

| Consumer / observed source | Backend ID class for enforcement | Allowed operation / activation constraint |
|---|---|---|
| Storefront staff admin helper, order entry and inventory checks (`staff/admin.ts`) | `GP_STAFF_GATEWAY_API_KEY_ID` + signed customer JWT | Explicit role capability map; no service fallback |
| Back-in-stock discovery; strategy snapshot/customer-phone audit; backend inventory-baseline review; bridge `MEDUSA_ADMIN_READ_TOKEN` live-order read | `GP_ADMIN_READ_ONLY_API_KEY_IDS` | Enumerated GET/HEAD catalog, customers, orders, inventory and allocation reads |
| Review acquisition cron (`api/cron/review-acquisition`) | `GP_COMMUNICATIONS_ADMIN_API_KEY_IDS`; frontend prefers `MEDUSA_COMMUNICATIONS_API_TOKEN` | Read discovery plus POST order/customer metadata containing only the three send timestamps. Frontend no longer replays entire profile/order metadata snapshots. No other customer, money, grant or release fields |
| QBD bridge `MedusaApi` product/inventory writer using `MEDUSA_TOKEN` | `GP_QBD_CATALOG_API_KEY_IDS` | Enumerated product POST create/update, inventory-item POST, product-variant inventory attachment and location-level POST. Read discovery as above. No delete, payment, customer or draft-order writes |
| Dormant bridge customer/draft-order/pay/delete, sales-channel product membership, order-edit lifecycle and generic order update methods | Unclassified, denied under enforce | Keep writer absent/paths disabled pending their separate reviewed cutover; do not label the whole writer read-only or grant operator access |
| QBD accounting metadata handoff `/api/qb-sync/...` | Existing dedicated signed sync token; outside admin API-key classification | Preserve accounting allowlist/idempotency. This staff rollout does not authorize production QBD connection or dormant writers |
| Native Medusa dashboard/recovery user | `GP_PRIVILEGED_ADMIN_USER_IDS` in enforce | Current native authenticated user; separately verified recovery. Log mode retains existing dashboard login |
| Unknown plugin, manual script or service key | Observe in log; denied in enforce | Reconcile live key IDs, owner, exact method/path and schedule before activation |

A key cannot belong to multiple service classes; gateway precedence is absolute. No service receives native user/operator privileges. This inventory covers the canonical source repositories; live key-ID/secret custody, historical scripts outside those sources and a real recovery login are still activation prerequisites. No credential was printed, provisioned, rotated or changed and no scheduled message ran.

Log mode observations are sent through the existing operations-alert path with method, boundary, reason and authenticated transport ID/type only. Bodies, query strings, tokens, email addresses and raw exception text are excluded. Alert failure cannot block an authenticated request.

No schema migration is added. Inherited accounting migrations still require a protected database backup, recovery access, restore procedure and before/after journal. Exact-head CI is source evidence; actual standalone previews and recovery-login/provider receipts remain #372 gates.


## September 21 self-service metadata and alert correction

Current storefront SMS opt-in resubmits existing customer metadata. The Store
customer guard now authenticates `/store/customers/me` first, reads that exact
customer when protected fields are present, and accepts only unchanged echoes.
It removes those fields from both raw and validated patches before the native
handler runs. The installed Medusa customer service merges metadata keys, so a
later staff role, credit or note update cannot be overwritten by the old echo.
Creation and actual additions/changes/removals of authority still fail; an
unverifiable current record holds the protected update. This works in both log
and enforce modes without changing either default. Ordinary preference/contact
patches without protected fields need no additional authority read.

Would-deny observations now coalesce by server-defined boundary, reason and mode
for five minutes per process. The first observation logs and posts normally;
the first observation after the window reports the suppressed count. Actor IDs
and request URLs never create new throttle keys. Different failure reasons and
mode transitions remain visible. The small cache is bounded; it resets on
process restart, so this is not a distributed exactly-once alert claim. Alert
failure never blocks the request and cannot trigger a per-request retry storm.
No alert destination, credential, flag or migration is added.

Backend alone against current storefront main preserves its full-metadata SMS
form while rejecting privilege changes. The staff guide's customer preference
and authority instructions remain accurate; no new staff step or storefront
build is needed. #44's separate primary-contact/SMS-form activation requirements
remain open. Native provider/consent acceptance, protected backup/recovery for
inherited migrations and actual shared stack integration are still launch gates.
