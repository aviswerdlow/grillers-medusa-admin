# Staff gateway, capabilities and revocation — launch #318 / #319

Candidate implementation in backend PR 32, paired with storefront PR 50; stacked on #314 backend PR 29 / storefront PR 47. Neither issue is closed. Owner policy approval, current-grant provenance review, configured isolated identities, integration, deployment and runtime recovery/role proofs remain gates. No live access or provider setting was changed for this patch.

## Verified identity and capabilities

Medusa authenticates every `/admin/*` transport first. The configured gateway API-key ID also requires the original customer's signed, unexpired Medusa JWT in `x-gp-staff-authorization`. The backend checks signature, actor type, identity, issuance/expiry and fresh customer authority for each request. Body names/emails never establish identity. Lookup failures, unknown credentials and routes outside the capability map are denied, including for storefront owners.

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

Invoice terms use the dedicated audited endpoint, the existing approver email allowlist and, for customer gateway identities, an approved immutable customer ID. Ordinary profiles cannot grant invoice eligibility/credit terms. This authority protection does not complete #367's accounting/business reconciliation.

## Grants, revocation and recovery

Bootstrap privileges use `GP_STAFF_BOOTSTRAP_CUSTOMER_IDS`, never hard-coded emails. Revocation wins. A role change sets `staff_bootstrap_override=true`, so demotion/regrant cannot silently restore the initial owner role.

POST `/admin/grillers/staff-access/customers/:id` requires Team access or a separately configured privileged native operator, current `expected_version`, a reason, typed confirmation and valid role. Self-demotion is refused. Recovery configuration must exist before grants change. A transaction locks actor and target in stable order, rechecks the owner's current grant/session, compares the version and atomically writes canonical permissions, revocation, the monotonically nondecreasing `staff_access_valid_after` cutoff, an incremented version, and a named before/after audit. The dedicated `staff_access_audit_log` is not trimmed by ordinary profile notes; recent staff history also gets the event.

No table migration is needed. Generic admin profile edits strip unchanged grant snapshots and reject permission changes/clearing. Office cannot edit a staff account or its addresses. Public account writes reject role, charge, session, audit, customer-credit and invoice-authority fields. These protections do not authenticate historical grants; a protected provenance review is still required.

Old JWTs cannot perform privileged gateway or saved-card actions after an access change, including regrant. Native refresh and session creation enforce the cutoff, including pre-registration tokens whose customer identity is hydrated during refresh. A fresh password sign-in issued after the cutoff is required; same-second tokens are conservatively refused. Ordinary customer self-service remains available. Requests admitted before revocation may finish; role transactions additionally recheck the actor under lock.

Recovery uses a separately authenticated native Medusa user in `GP_PRIVILEGED_ADMIN_USER_IDS`, read fresh each request, and the same audited grant endpoint. Removing the configured ID or deleting the account denies later requests. This is an explicitly privileged operations identity, not a picker or perpetual storefront bypass. Real recovery configuration and rehearsal are prerequisites, not implied by synthetic fixtures.

## Audit attribution and remaining interface

Custom finalization, refunds, accounting handoffs/retries, legacy mappings/reorders and communications use the verified person. Native order/payment workflows receive that person's actor ID only after transport authentication and capabilities pass, so `captured_by`/`canceled_by` do not name the shared key. The original transport ID remains on the request principal. Fulfillment and customer profile/address metadata receive server attribution. Caller audit history must retain its stored prefix; only appended entries get the current actor. Generic profiles cannot overwrite the dedicated grant audit.

**Remaining #318/#312 interface:** staff phone-order Store-cart metadata is separate from the admin gateway. `src/lib/inventory-allocation.ts` still consumes order metadata for staff allocation attribution, and frontend `staff/order-entry.ts` constructs it through Store requests. Review that signed staff-cart handoff before closing #318; these admin fixtures do not prove it. Do not resume #312's twice-failed native fixture setup as part of this handoff.

## Coordinated release configuration

| Backend setting | Reviewed value |
| --- | --- |
| `GP_STAFF_GATEWAY_API_KEY_ID` | ID of the dedicated key used by storefront `MEDUSA_ADMIN_API_TOKEN`, never its secret token |
| `GP_ADMIN_READ_ONLY_API_KEY_IDS` | IDs of approved GET-only integrations, including #316's reader and storefront background reader |
| `GP_PRIVILEGED_ADMIN_USER_IDS` | Existing native user IDs for separate privileged operations/recovery |
| `GP_STAFF_BOOTSTRAP_CUSTOMER_IDS` | Approved existing customer IDs for initial owners after identity/grant review |
| `GP_INVOICE_APPROVER_CUSTOMER_IDS` | Approved invoice approver customer IDs, alongside the existing email allowlist |

The gateway key cannot fall back to read-only service access without a staff JWT. Back-in-stock/review-acquisition jobs now use separate storefront `MEDUSA_READ_ONLY_API_TOKEN`; its backend ID must be on the read-only list. There is no fallback to the gateway credential. Coordinate with #316/communications owners. This patch neither configures nor runs scheduled sends.

Before activation:

1. Approve the matrix and immutable identities, review existing grant provenance privately, and verify the independent recovery login. Do not derive IDs from email or revoke/provision real accounts automatically.
2. Integrate #314 and #313 financial protections and #322's parallel middleware changes without replacing other guards. Classify service consumers; keep the deliberately absent legacy writer credential absent.
3. Review paired revisions, guide and exact-head CI. Configure backend identities and the separate reader before enabling the paired frontend. Missing configuration deliberately denies admin access; do not deploy this boundary alone.
4. Rehearse isolated roles against the deployed endpoints, proving denial before provider/data effects, named audits, bootstrap revocation, refresh, regrant and separate recovery. Preserve distinct Medusa/Stripe/sync/QBD receipts and complete the remaining Store-cart interface review.
5. Keep a written rollback/recovery path. Reverting code can restore unsafe metadata/email authority. Do not erase newer grant cutoffs to make rollback appear successful; keep affected tools unavailable until the safe boundary returns.

## Verification limits

HTTP fixtures use installed Medusa authentication, route sorting, native capture/refresh/session handlers, registered guards and actual audit helpers. Customer/module/provider boundaries are synthetic. PostgreSQL tests use an isolated temporary schema for real concurrency, rollback and recovery writes. Frontend fixtures check protected headers, no-cookie denial, redirect/path restrictions, server authority and existing actions. Exact-head CI supplies full suites, TypeScript and the frontend build. These are candidate-code receipts, not deployed acceptance or real provider transactions.
