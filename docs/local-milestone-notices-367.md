# Local milestone notice pipeline (#367)

The scheduled job is inert while `GP_LOCAL_MILESTONES_ENABLED` is off. When
enabled, it records one office alert for each failed-delivery or corrected
milestone. Customer notices stay held until an explicit #359 notice policy is
configured with a version, approval time, start time, and lists of milestones
approved for email and SMS. The start time prevents stale preapproval events
from sending later. No production environment setting is changed by this PR.

Email uses `sendTrackedEmail` with transactional purpose, `order_updates` topic,
the **accepted order's email snapshot**, and a key derived from milestone event
and destination. The communications platform applies suppression, customer
identity checks, and observance deferral. A local notice attempt is durably
claimed before provider I/O. A lost provider response moves it to
`needs_reconciliation` and raises an office alert; it is never resent
automatically. Blackout-deferred notices are retried only after the allowed
time. The notice table is an audit and replay guard beside the existing
communications message log.

Current checkout order-SMS consent is expressly limited to UPS shipping and
tracking. It **does not authorize local pickup or delivery texts**. This job
records local SMS suppression, with no Twilio call, even if that UPS consent is
present. A separate approved customer-controlled local consent and sender are
required before local texts can be enabled. #359 must settle which physical
actions send notices before a policy can be configured.

The job reads milestone events created by backend PR #59. Its migration creates
only the local notice attempt ledger. Merge or activation sequencing must keep
the master flag off until both schema slices and the approved #359 policy are
ready. No customer email or SMS is sent from a local milestone while the flag
or policy is absent.
