# Preserve legacy office checkout during rollout

The September 21 follow-up review on strategy #372 identified a regression in
backend #40: current storefront impersonation carts belong to the authenticated
office account, while the saved card or approved invoice belongs to the selected
buyer. The new ownership comparison rejected that supported path. Both later
cart-write locks also assumed the cart already belonged to the buyer and had
removed main's customer/email transfer.

The route now allows that existing path only when order review is off, the staff
boundary is log, the cart/request has no review or signed staff authority, and
`getPaymentContextCustomer` has independently verified the office capability,
current staff session and selected customer. The cart must belong to that office
account or already to that same buyer on retry. Any stored target/selected
customer marker must agree. A request header or cart metadata alone grants no
staff authority.

Before the no-amount payment session, the native cart lock rechecks owner,
target, completion, accepted review, signed authority and rollout mode. Only a
legacy staff cart is transferred to the selected buyer and current buyer email.
The existing saved-card ownership, invoice approval/credit, inventory, explicit
final-charge consent and later charge/fulfillment gates remain. Signed/reviewed
carts keep their strict owner and accepted contact instead of being rewritten.

## Standalone deployment and defaults

Against current storefront main `730989c`, backend #40 with unset flags preserves
legacy office saved-card/invoice checkout. `GP_ORDER_REVIEW_ENFORCEMENT` still
defaults off; required or an invalid nonempty value enforces. The staff boundary
still defaults log; enforce or an invalid value disables the legacy exception.
There is no new flag. Any existing accepted review or signed cart remains strict
on rollback. Upgraded storefront carts already bound to the buyer retain their
existing signed/reviewed path. No CMS, analytics or bridge deployment is needed
for this compatibility correction.

This increment adds no migration. The containing PR still requires a protected
fresh database backup and recorded recovery procedure before its existing order
promise migrations run. Application merges/deployment remain held by #372,
including its separately reported sequential-stack conflicts. This source fix
does not claim the full stacks merge in sequence.

## Verification and operations

The isolated route tests use real payment-context authentication, review-owner
checks and cart-lock adapters with synthetic provider/workflow/database effects.
They cover successful saved-card and invoice placement for the selected buyer,
already-transferred retries, ordinary customer and reviewed staff paths,
unauthorized/revoked/stale staff, wrong owner/targets, invalid/required modes,
accepted/signed downgrade attempts and concurrent owner/target/promise/signature/
completion/mode changes. No Stripe request, charge, customer send or live order
runs in these fixtures. Existing review and completion suites run alongside them;
exact-head CI and later native/provider rehearsal remain separate evidence.

The staff operations guide already describes customer-context checkout,
saved-card final charging and approved invoice terms. This restores that existing
workflow without changing staff steps, so no storefront guide edit/build is
needed for this correction. Native login, actual standalone previews and the
single #332 multi-system rehearsal remain release acceptance gates.
