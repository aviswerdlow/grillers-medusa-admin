# Native customer measurement — #336 / #341

Record this contract before replacing the delayed customer analytics writers.
The customer mutation and service/profile operations remain authoritative and
must not depend on measurement transport or consent.

- Storefront server requests forward the current valid cookie choice and browser
  identity/assignment evidence in a bounded measurement header. It grants no
  account identity, SMS permission or marketing subscription.
- Store middleware stores that context in the request's scoped container. The
  backend's Stripe key determines the original test/live classification; unknown
  or conflicting evidence is unavailable. Do not store it on mutable customer
  metadata or infer it from a later customer query.
- Native create/update workflow hooks capture the returned customer ID/revision,
  workflow transaction ID and context. The event is grouped with the workflow;
  compensation clears the group's measurement notification. Missing grouping,
  transaction or request context is not permission to invent evidence.
- A separate subscriber saves the accepted snapshot before external delivery.
  Each native change has one stable event ID; later updates and retries cannot
  overwrite its original time, classification, consent or assignment evidence.
  No names, email addresses, phone numbers or addresses go to analytics.
- Delivery uses independent receipts for Jitsu, GP analytics and communications
  automation, with bounded recovery from the saved source. Tests can reach only
  verified isolated analytics routes; they cannot start production automation.
  Unknown/denied consent does not produce a measurement source. Required profile
  updates and account service email remain separate.
- The older customer analytics subscribers and the measurement portion of the
  operational profile subscriber must retire with this source owner. Do not send
  a second identity/purchase event to compensate for delayed reporting.

Activation is a coordinated source release, not implied by tests. Native hook
context/group propagation, actual receiver/report receipts and operator routing
remain #332 gates. Other cart/shipping/inventory and communications producers,
back-in-stock forwarding, review-click and full authenticated browser continuity
remain in the producer matrix; this customer slice does not cover those writers.

## Release and recovery

`GP_CUSTOMER_MEASUREMENT_ENABLED=true` enables source capture and the bounded
minute worker together. It is unset by default and has not been activated.
Existing communications tables and unique event/delivery indexes are reused;
there is no additional migration. Retain all four prior publication migrations.
Both storefront header capture and backend hooks/receiver/worker must ship as one
handover. The old unclassified customer writers are deliberately not a fallback.

The existing `GP_ORDER_REHEARSAL_ENABLED`, `GP_REHEARSAL_ID` and isolated destination
configuration also serve this source. Original test labels and named run survive
later configuration changes. Jitsu and GP receive the same stable event ID/time;
a missing browser session is marked unavailable and gets only a stable source
surrogate required by the warehouse schema, not a claimed browser session.

The source is retained in `gp_communication_event` with its original snapshot/hash.
`gp_event_delivery` targets `native_customer_jitsu`, `native_customer_gp` and
`native_customer_automation` have independent receipts. The worker retries saved
failures after one minute with a bounded fair scan and nonblocking per-source
transaction lock. Acknowledgment-before-receipt crashes may replay the same ID;
actual downstream deduplication remains provider acceptance, not an exactly-once
transport claim. Test automation is terminally excluded; held tests do not generate
production measurement alerts. Existing purpose consent/suppression/holdout checks
still govern production flow enrollment in the same receipt transaction.

A native event-bus persistence outage is logged without adding a new account
failure. Grouped-event release, retention/retry and request-scope propagation must
be proven against the deployed Medusa/event-bus configuration in #332. Do not
claim that handler tests alone prove these runtime guarantees. Saved event rows
allow delivery recovery without repeating native customer operations; a failure
before source notification is accepted is a distinct source-availability gap.

The separate [account welcome source](account-welcome-source-336.md) now captures
successful Store registration independently of analytics permission and retains
the original recipient through service delivery and matched callbacks. Its flag
is unset and native scope/bus, account-change races and actual provider receipts
remain gates. Calendar/segment audiences and unmatched/general provider callbacks
still need their own original-purpose contracts. Neither source completes all
communications send isolation.
