# Refund identity and outcome reconciliation — launch candidate

This is the provider-evidence source candidate for strategy #336, coordinated
with #314. The reconciliation worker neither issues a refund nor writes order, inventory,
QuickBooks or customer-message state. Retain those independent acceptance gates.

## Contract before changing shared refund/publication code

- Preserve the existing Stripe provider identifier, amount conversion,
  idempotency key, payment methods and all non-refund methods. The opt-in evidence
  adapter adds the native refund ID to Stripe metadata and preserves a sanitized
  response in native payment data. It must not make a second provider call to
  recover a missing response. Failed/canceled provider responses must not be
  treated as successful native refunds. Existing uncertain intents stay blocked.
- A dedicated signed refund webhook durably deduplicates event IDs and queues
  the refund ID. Parse the verified raw bytes. Never use notification timestamps
  to order status transitions or trust an unsigned parsed body.
- A disabled-by-default worker verifies/pins the Stripe account, test/live mode
  and activation epoch. It uses GET requests only. Bounded paginated discovery
  repairs missing notifications; individual current-object reads handle duplicate
  and out-of-order notices. Retain a durable cursor, fair polling queue, request
  generations and fenced worker ownership. No uncertain read is acknowledged as
  a successful reconciliation.
- Immutable status observations preserve provider refund identity, amount,
  currency, PaymentIntent, mode and observation time. Later outcomes append
  evidence. A unique native PaymentIntent-to-order relation plus the immutable
  original establishes order ownership; native refund metadata is checked against
  the payment/order relation and amount, never guessed from amounts or time.
  External provider refunds may have no native refund row: preserve that fact and
  surface reconciliation rather than create a financial transaction.
- Test/live disagreement, ambiguous orders, conflicting native identity or
  amount/currency, missing originals and unsupported evidence remain unavailable.
  Nothing grants consent or rewrites an accepted original.
- Each observed transition has a distinct journal event. Provider-reported
  success can arrive after pending and can later fail; preserve every observation
  and do not call Stripe success proof of a bank-statement credit. Original gross
  placement remains unchanged. GA4 must count a provider refund once, including
  the older direct-refund success path; status updates/failure use separate
  events, not fabricated purchases or negative refunds.
- Keep original native-recorded refund events immutable. They describe native
  recording, while provider observations describe processor state. Retain current
  test/consent/experiment gating, isolated rehearsal targets, communications
  suppression/holdout and independent transactional-email paths.

Installed source: Medusa Stripe provider 2.10.3 `StripeBase.refundPayment` calls
`refunds.create` with the native refund idempotency key, discards its response and
returns the original PaymentIntent data. The native payment module creates the
refund row before this call; existing staff idempotency/reconciliation guards
must remain. The current source publisher is backend PR43 and its full stack.

Primary references (read September 20, 2026): [Stripe refund object](https://docs.stripe.com/api/refunds/object)
defines status/identity/minor units; [refund events](https://docs.stripe.com/refunds#refund-events)
documents creation/update/failure notifications; [webhook ordering and duplicate handling](https://docs.stripe.com/webhooks#event-ordering)
requires event-ID deduplication without assuming arrival order.

## Acceptance and release

Prove signature/raw-body boundaries, replay/conflicting IDs, account/mode/epoch
pinning, lost notification recovery, fair cursor/queue advancement, stale-worker
fencing, equal partial refunds, external refunds, ambiguous identity, pending to
success to failure, unchanged originals/gross counters and once-only GA4 refund
measurement. Use focused mocks plus isolated real PostgreSQL and canonical CI;
then the already planned #332 native/provider rehearsal, not another money run.

Before activation, integrate the stack and apply the added migration, verify
snapshot/recovery, provision the dedicated webhook secret and read-capable key,
verify account/mode and endpoint registration, and enable the provider evidence
adapter and read-only worker in a coordinated release. Review in-flight legacy
refunds before changing their idempotency parameters. Keep historical unmatched
rows explicitly unresolved. Do not provision or enable anything as part of source
work. Disable the worker to stop polling; retain sources, cursor, receipts and
pins. Actual provider/report/alert/financial reconciliation remains open until
the corresponding evidence is recorded.

## Configuration and bounded recovery

Keep `GP_STRIPE_REFUND_EVIDENCE_ENABLED` and `GP_REFUND_RECONCILIATION_ENABLED`
disabled until the combined release. The first preserves provider identity during
the existing customer-authorized native refund; it does not introduce a second
money action. The second runs the GET-only worker and signed queue endpoint.
`GP_REFUND_STRIPE_READ_KEY` must be an explicit restricted/secret Stripe key for
reads; there is no implicit fallback to the charge key. Set the expected
`GP_REFUND_STRIPE_ACCOUNT_ID` and the same `GP_ORDER_PUBLICATION_START_AT` as the
publication worker. The publication epoch must already be pinned. The worker
verifies `/v1/account` before pinning or processing. Review read-key permissions
for account, refund listing and refund retrieval. Do not print any keys.

Register `/webhooks/stripe/refunds` for `refund.created`, `refund.updated` and
`refund.failed`, using the dedicated `STRIPE_REFUND_WEBHOOK_SECRET`. Raw-body
verification precedes JSON parsing. Connect events are unsupported and refused;
refunds without a PaymentIntent remain unresolved. The refund object itself
has no `livemode`; verified account plus explicit key mode and signed event mode
supply that boundary. A missing/changed pin or failed queue commit returns a
retryable response, never a successful acknowledgment.

Migration `20260921001500` adds the pinned scope/cursor, event inbox, fair queue,
immutable receipts/order links and successful-refund measurement owner. Each job
scans one page (100 refunds) and reads at most ten due refund objects under a
five-minute fenced lease. Requests time out at ten seconds and refuse redirects.
A completed scan returns to its first page; already queued records keep their
next-check time. New notifications advance a generation so a concurrent GET
cannot defer them. Pending/action-required/unlinked reads retry after five
minutes; resolved outcomes remain eligible for six-hour checks and notifications.
These intervals are polling choices, not customer refund deadlines.

Use `gp_refund_provider_queue.reason` and `last_checked_at`, joined by refund ID
to the latest `gp_refund_provider_receipt` and optional
`gp_refund_provider_binding`, to investigate `refund_reconciliation_pending`.
The alert contains counts, not customer or raw provider payloads. Missing native
refund metadata/rows, ambiguous order links, test-mode/currency disagreement or
unsupported evidence need operator reconciliation. `provider_only` means no
verified native refund identity, not proof that a particular person created an
external refund. Never infer a match from equal amounts or nearby timestamps.
There is no automatic financial repair: #314/#332 must prove Medusa, Stripe and
QuickBooks state separately, and alerts require actual operator receipt.

`order_refund_updated` publishes each distinct observed status with its original
order context. The observation timestamp is when the GET was recorded, not an
invented settlement time. Exactly one immutable source owns standard GA4 refund
measurement; an existing ready direct-success event retains ownership. Later
status observations and later native-recorded events cannot take it. Analytics
also deduplicates successful events by provider refund ID within its own lane.
The existing transport retry/cache limitations remain; this is not proof of
all-time exactly-once delivery to GA4. A later failure is a separate event and
alert, not a fabricated purchase, negative refund, or automatic GA4 correction.
Reconcile any resulting GA4/net-accounting discrepancy explicitly.
