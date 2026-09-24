# Accepted experiment context — launch #336

This candidate stacks on backend PR41 and pairs with the storefront experiment
evidence and analytics completeness candidates. It fixes dropped/conflicting
attribution and supplies a verifiable version for newly issued assignments.
It does not replace the purchase/communications publisher or certify provider
delivery. No experiment is activated by this code.

## Meaning of the fields

The storefront derives an experiment `version` from the actual code release SHA
and complete experiment definition. Both variants share that revision. A separate
`evaluation_version` fingerprints the evaluated Statsig rule/group/value (or the
explicit registry/override/sticky source). An experiment name ending in `v1` is
not a version receipt. A change in code release or definition creates a new
revision, while the previously accepted order keeps its old one.

A server-only HMAC authenticates experiment ID, variant, assignment ID, experiment
revision, evaluation fingerprint and release SHA. The backend verifies the exact
tuple before calling either revision known. The token is evidence of a
server-issued assignment, not proof the customer viewed it, consent, payment or
permission to call an API. The browser still reports which assignments it used.

The storefront preserves receipts through its assignment cookie and cart metadata.
Browser event context includes both versions but excludes signatures. The backend
accepted-order projection excludes signatures, key IDs, release details and PII.
Existing legacy analytics context helpers carry version fields when present;
they are not a substitute for the immutable publisher still required by #336.

## Completeness and old evidence

New cart lines explicitly report `experiment_context_status` plus the context map.
An explicitly observed empty map is distinct from an old/missing observation.
Malformed cookies, dropped records, rejected/oversized cookie writes, absent line
markers, invalid receipts, excessive entries and conflicting assignments make the
accepted status `unverified`. A conflict retains an unknown assignment rather
than becoming a verified empty set. The backend bounds work at 100 assignments.
These failures do not throw from the attribution adapter or change commercial
price, consent, payment, stock, calendar or terms.

The immutable promise schema adds only optional fields. Old rows keep their exact
hash and absent status projects as null. No backfill, new signature, current
profile lookup or relabeling turns those old records into verified history.
The paired parity checker refuses unknown/unverified context even if its array
is empty; known tests and analytics opt-outs keep the existing cohort exclusions.

The current cookie has a finite capacity. Capacity loss is now observable and
holds measurement readiness closed; it does not silently prune assignments.
Verify the intended simultaneous-experiment set and cookie-disabled/mobile cases
before activation. Cart-line evidence is not a lifetime exposure ledger: later
page exposures, merged same-variant lines and guest-to-user/cart transitions still
need the full browser-to-accepted-order evidence in the #332/#336 rehearsal.

## Operator prerequisites (no values provisioned)

- Storefront server: `GP_EXPERIMENT_EVIDENCE_KEY_ID`, and
  `GP_EXPERIMENT_EVIDENCE_KEYS` as a JSON object mapping approved key IDs to
  independent random secrets of at least 32 bytes. Never use a `NEXT_PUBLIC_`
  variable, a staff signing key, a Stripe key or an analytics delivery credential.
- Backend server: the same approved evidence key ring in
  `GP_EXPERIMENT_EVIDENCE_KEYS`; it requires no active signing-key ID.
- Storefront code identity: Vercel's `VERCEL_GIT_COMMIT_SHA`, or an explicitly
  approved `GP_EXPERIMENT_RELEASE_SHA` on a different host; exactly 40 hex digits.
  Missing release/key configuration leaves a version unknown and shopping usable.
- Retain old verification keys while carts/reviews may still reference them.
  Roll out both applications and the stricter parity client as one reviewed
  candidate. Do not silently rotate/remove keys underneath an active checkout.

The synthetic producer/consumer vector in both repositories contains an explicitly
fake test key. No production key, access grant, environment or data was changed.

## Validation and remaining acceptance

Focused coverage includes real server assignment, signed sticky reuse, unsigned
cookie reevaluation, common experiment versus per-evaluation versions, browser
cookie/cart/exposure propagation, malformed/capacity loss, a frozen cross-repo
receipt, tampering/key failure, conflicts, legacy hash preservation, trusted
checkout assembly, unchanged money/consent and strict parity completeness.

Next: durable original `order.placed` publication across event-before-binding,
separate finalization/refund, consent/test/identity continuity and actual
Jitsu/warehouse/GA4/communications receipts. Checkout already records customer
analytics choice and derives test mode from its Stripe key; unknown configuration
or staff consent remains unknown. This change does not grant consent or classify
production QA orders from a client-authored flag. Preserve stopped fixture loops.
