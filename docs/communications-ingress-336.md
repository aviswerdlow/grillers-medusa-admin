# Communications measurement ingress — #336 / #341

This source contract is recorded before changing the shared receiver. Extend
backend PR43 and release it with frontend PR63's explicit browser envelope.
Do not activate the live rehearsal while the remaining producers below are open.

## Receiver contract

`/api/track`, `/api/batch` and `/api/identify` are public measurement receivers,
even when a caller uses a server-held key. They are not alternate order, payment,
provider-delivery or consent-authority writers. All three require a configured
accepted API key and the same origin checks. The existing production Stripe
secret determines test/live mode; the caller cannot override it. Unknown mode
returns unavailable. A test server or any declared test/rehearsal payload is
excluded before profile/identity/event writes, queueing, external destinations or
production alerts. There is no rehearsal communications receiver/fallback here.

Known production browser events require explicit production/test-false markers,
analytics consent with its timestamp, stable browser event ID and occurrence time.
Missing/contradictory/malformed metadata is refused rather than relabeled.
Explicit rejection is ignored without buffering/replay. Batch validation happens
before any writes and applies to every member, not just the batch wrapper.
Batch-level test or denied-consent markers veto member ingestion; wrapper metadata
cannot grant a member missing consent, classification, identity or time.

An explicit list covers the currently emitted browser interactions. Server-owned
purchase/refund/fulfillment/customer/provider/flow events are refused even under a
valid public key. Browser IDs cannot use the durable server journal's identity
namespace. The accepted event retains its browser ID/time and assignment context;
source and classification are receiver-owned. Public input cannot select a native
customer/profile/order, flow/template, or claim authenticated phone/SMS consent.
The existing email-only identify behavior does not grant marketing permission.
Native customer/profile sync remains the operational contact owner.

Frontend PR63 already sends the required browser envelope. Older unclassified
callers, including storefront-server back-in-stock forwarding, must migrate to
their appropriate classified/authorized producer contract before release. Do not
keep an unmarked-event exception that permits test contamination. Primary waitlist,
subscription, order and transactional operations are not changed by this receiver
work; their own producer/send classification still needs verification.

## Producer inventory and remaining work

| Producer                                                         | Current source status / next action                                                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable order purchase/finalization/lifecycle/refund publisher | Existing durable source and isolated analytics targets; retain all prior migrations, activation and provider gates.                           |
| Browser Jitsu/GP sender                                          | PR63 `04ae3ab`: current consent/test classification, isolated targets and no duplicate confirmation-page purchase.                            |
| Public communications track/batch/identify                       | This receiver contract; prove compatible production ingestion and no side effects on denied/test/unknown/forged input.                        |
| Generic backend cart updated/completed                           | Still lacks accepted request-time consent/context; capture and preserve source evidence, then classify delivery.                              |
| Generic backend customer created/updated                         | Still lacks accepted request-time measurement context; preserve required operational profile sync separately.                                 |
| Shipping forecast and inventory subscribers                      | Bind to original immutable order classification/context and retain event-before-binding recovery; do not infer from current mutable metadata. |
| Communications native customer and derived cart/flow events      | Propagate source classification through maintenance/recovery; no test-triggered production automation.                                        |
| Storefront-server back-in-stock, standalone review-click         | Classify separately with purpose/recipient authority; the browser guard does not cover these paths.                                           |

Keep #332's one controlled rehearsal stopped until this entire producer inventory,
actual isolated routing/grants/CORS, authenticated identity/exposure continuity,
GTM consent template, provider/report/operator receipts and original prerequisites
are satisfied. No deployment, configuration, send or financial action is implied.
