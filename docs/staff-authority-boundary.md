# Staff authority prerequisite — launch #318

This candidate protects the source of staff metadata and the customer-context saved-card routes. It is **not the complete #318 capability/gateway implementation or #319 bootstrap/session recovery change**. Both issues remain open. It stacks on backend PR 29, preserving the durable accounting/refund work. No deployment or production role change is part of this patch.

## Source finding and behavior

Installed Medusa 2.10.3's `StoreCreateCustomer` and `StoreUpdateCustomer` schemas accept arbitrary metadata. Their native POST handlers pass that metadata into `createCustomerAccountWorkflow` and `updateCustomersWorkflow`. The storefront role helpers and backend saved-card helper currently trust multiple metadata aliases. Without a Store write boundary, customer-supplied metadata can become a staff authority input. This is a source/isolated-fixture finding, not a claim that a live account was exploited.

`protectCustomerStaffAuthority` runs on POST `/store/customers` and POST `/store/customers/me`. It rejects the existing role/final-charge aliases and reserves `staff_*` / `gp_staff_*` audit, access and future session fields. It checks raw and validated bodies. Protected-field writes, including null/empty/false values that could clear revocation, return 403. Wholesale null or non-object metadata returns 400. Contact edits and ordinary object metadata continue through the native handlers. Admin role management is unchanged and still needs the authoritative permission boundary in the next #318 packet.

`canManageCustomerPaymentMethods` limits a request with `x-gp-staff-target-customer-id` to the existing office/customer-context capability. It uses the current customer fetched by authenticated `auth_context.actor_id`, never a supplied actor ID/name/email. Picker, packer and merchandising roles do not gain access from stale broad flags or a final-charge flag. Revocation wins over all role flags and the existing bootstrap email compatibility. Denials return 403 before target lookup, card read, setup, detach or default-card mutation. Self-service cards still work without a staff target.

| Existing identity / role | Another customer's saved-card tools |
| --- | --- |
| Customer, picker, packer, merchandising reviewer, unknown explicit role | Denied |
| Office, manager, general staff and existing legacy office aliases | Allowed |
| Super admin | Allowed |
| Any revoked identity, including bootstrap email | Denied |

This table describes this patch's source behavior. It is not a new owner-approved launch role matrix.

## Verification scope

The local HTTP fixture uses the installed Medusa authentication, native validators and native customer handlers, the actual registered middleware, real signed synthetic customer JWTs and a local ephemeral HTTP listener. Customer workflow/persistence boundaries are spies. It tests both registration and profile update, every known authority alias, clearing/revocation attempts, invalid tokens, ordinary preferences and contact edits. Medusa's actual route sorter verifies registration order.

The saved-card tests invoke all four real route handlers (list, SetupIntent, detach, default) with synthetic scopes. Denied roles cannot resolve a provider or target customer; permitted office roles can list cards; replaying an authenticated request re-reads revocation. These checks do not perform real Stripe operations, persist a customer, start the full Medusa app, or establish deployed acceptance.

Focused check: `yarn test:unit --runTestsByPath src/api/__tests__/customer-staff-authority.unit.spec.ts src/api/store/payment-methods/__tests__/staff-capability.unit.spec.ts src/api/store/payment-methods/__tests__/utils.unit.spec.ts src/api/store/payment-methods/setup-intent/__tests__/route.unit.spec.ts`.

## Next #318/#319 packet and release gates

1. Approve the complete role/capability matrix and isolated role identities with Avi/account administrator. Distinguish office, pick, pack, money, customer/role management, merchandising and direct Medusa operators.
2. Bind the shared storefront admin gateway to the original authenticated individual. Backend permission checks must cover native/custom money, customer, role, finalization and #314 accounting-history/handoff/retry routes. Denied or forged requests must cause no mutation; audit entries must record the verified person. Consolidate all three frontend admin clients (`staff/admin.ts`, `staff/order-entry.ts`, `inventory-allocation.ts`).
3. Replace email-only bootstrap compatibility with approved immutable identity binding and an audited recovery policy. Current UI/email bootstrap checks remain outside this prerequisite patch. Do not close #319 based on saved-card denial: full revocation/regrant, stale-session rejection and independently tested recovery remain required.
4. Review current role metadata provenance before treating stored grants as trusted. Blocking new self-writes does not retroactively verify old grants. Use a protected read-only review; do not revoke real staff or create identities without authorization.
5. Integrate #322's separate middleware edits without losing either guard. Update the staff operations guide from the paired storefront PR. Preserve #314's immutable outbox/refund contracts.
6. Obtain exact-head CI, review/release authority, a backend deployment receipt and sanitized actual HTTP role tests before claiming runtime acceptance. Record Stripe, Medusa and accounting effects separately. No marketing sends, live payments or credential changes are needed to review this patch.

Rollback is the prior reviewed deployment revision. There is no migration, credential rotation, stock change, provider call or data rewrite in this candidate. Reverting would restore the unsafe Store metadata write path, so an operational rollback must keep affected staff actions unavailable until the boundary is restored.
