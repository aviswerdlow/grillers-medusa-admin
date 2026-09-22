# Native cart measurement and recovery — #336 / #341

Record the source contract before replacing the mutable cart subscribers.

- Capture the cart actually returned by a successful native Store API mutation,
  including the `parent` cart in a line-delete response. Medusa 2.10.3 item-edit
  workflows do not expose a common final hook; their handlers refetch the cart
  after workflow success. A response observation is not a native commit timestamp
  or a financial fact. Preserve its observed time and separately returned native
  revision. A server-generated request ID identifies each successful observation;
  event-bus retries retain it, while separate HTTP requests remain separate activity.
- Capture current consent and backend-known Stripe mode before the mutation.
  Keep unknown evidence unknown. Analytics denial must omit browser identifiers
  and assignments but can carry the separate marketing-cookie choice. Neither
  cookie choice grants or revokes an email subscription. Freeze the authoritative
  profile's email permission when first saving the source, accepting opt-in only
  when its timestamp predates the observed activity and its recipient matches.
  Later opt-in cannot authorize older activity; current revocation, purpose,
  topic, suppression and holdout checks still apply at enrollment/send.
- Required cart operations and their response cannot depend on analytics or
  transport. Snapshot only the successful response, never request cart values or
  a delayed re-query. An event-bus outage before acceptance is a source gap;
  accepted events are saved immutably before separate delivery/recovery.
- Retire the delayed `cart.updated` analytics and cart-lifecycle query writers.
  The old `cart.completed` analytics event must not invent a second financial
  owner: order placement/completion remains the existing immutable order publisher.
- Jitsu and GP destinations use the original context and independent receipts.
  Test measurement can use only the configured named isolated route. Unknown or
  denied measurement cannot be promoted by later server/profile settings.
- Only native production cart activity can create the recovery projection.
  Preserve its source identity/hash and monotonic activity time; old delayed
  observations cannot resurrect a later empty, completed or changed cart.
  Browser activity may extend an existing projection only with matching captured
  identity and classified consent; it cannot choose its recipient or source lane.
- Expiration must atomically save a deterministic derived source with the original
  lineage and mark its cart expired. Missing legacy lineage is unavailable, not
  permission to enroll. Native completion is an independent veto even before the
  order analytics publisher catches up. Worker retries must not lose expiration
  between changing the status and saving its source.
- Revalidate saved expiration lineage, current cart state and existing profile
  permission before enrollment and each recovery step. A newer cart observation,
  native completion, unknown/test source lane or missing original email permission
  cannot start or continue production recovery. Existing purpose/suppression and
  blackout rules remain authoritative. Do not send while testing this source.
- Retain cart source IDs and original classification/assignment versions on email,
  suppression/deferral and holdout records. Analytics-denied or unavailable cart
  email outcomes remain operational records without external measurement.
  A suppressed email is not a sent recovery email. Existing email recovery is the
  covered send path; SMS and subsequent custom flow chains retain separate gates.

The source capture and worker use an unset-by-default `GP_CART_MEASUREMENT_ENABLED`
flag. Release the paired storefront headers, backend capture, recovery and retired
writers together. Existing communications source/delivery/lifecycle tables are
reused; retain all four earlier publication migrations and activation epoch.
Preserve snapshots/receipts on rollback; unclassified writers are not a fallback.

Missing request context does not grant analytics; the backend may still know the
operational lane. Malformed or conflicting context makes that lane unavailable.
Disabling the flag pauses queued cart-recovery steps without advancing them.
Legacy unclassified lifecycle rows are not backfilled by inference. Before any
activation, an operator must verify the approved flow definitions and recipients;
the capture flag does not approve seeded or custom flows.

Actual native HTTP coverage, event-bus retention/retry, destination dedup/report
receipts and controlled recovery-send acceptance remain #332 gates. Requests that
return no complete cart, internal/background cart workflows and staff operations
do not acquire customer consent by inference. The remaining shipping/inventory,
account welcome, calendar/segment/provider, back-in-stock and review-click writers
and authenticated browser identity/exposure work keep their separate gates.
