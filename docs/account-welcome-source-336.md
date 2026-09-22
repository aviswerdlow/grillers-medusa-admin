## Packet 1 transition

Default behavior change: the existing `customer.created` service-welcome subscriber remains active until `GP_ACCOUNT_WELCOME_ENABLED=true`. Unset, empty, false and invalid values keep the legacy lane. This replaces the previous candidate's default-on replacement worker. Both lanes share `customer-welcome:<customer-id>` idempotency; original-source sends retain their production-lane, original-recipient and receipt guards. Capture may save source evidence before activation, but the replacement worker stays idle. #373 owns coordinated API/worker activation and provider/no-duplicate readback.

Segment and calendar audience holds retain the existing bounded operational alerts. This source change sends no messages.

# Original account welcome source — #336 / #341

Record this contract before replacing the shared welcome sender. Required account
service email is independent of analytics or marketing consent.

- The native customer-create hook retains its returned recipient, name, account
  status, creation time and transaction ID in a request-scoped holder. Only the
  successful Store account-registration response releases that snapshot. A failed
  outer authentication-link step cannot produce a welcome. Sparse response fields
  cannot remove the hook's original evidence. This is a successful-response
  observation, not a claimed database-commit timestamp.
- The request freezes the server-known live/test/unknown lane and available
  analytics context, including explicit denial. Missing analytics consent does
  not prevent a production service welcome. Conflicting/malformed supplied
  context remains unavailable; later configuration cannot promote the source.
- A subscriber saves an immutable account-scoped source in existing communications
  storage without profile creation, destinations or flows. Duplicate notification
  cannot replace the original recipient or context. Native account/profile work
  remains independent; failure before bus acceptance is a distinct source gap.
- A bounded minute worker uses the existing source delivery lock/receipt.
  Test/unknown sources cannot send through production or raise production-send
  alerts. Current account deletion, loss of account status or changed recipient
  veto the saved welcome; they never redirect it to a new address.
- Preserve the existing customer-welcome idempotency key across handover. A queued
  or failed prior attempt with uncertain provider outcome requires reconciliation;
  never automatically resend it or call it delivered. Sent/provider-accepted and
  suppressed results remain distinct; external delivery still needs its receipt.
- The installed Medusa notification module returns Postmark's MessageID in
  `external_id`; `provider_id` is only the provider name and `id` is internal.
  Shared email recording now requires the successful external receipt and keeps
  missing receipts queued/unconfirmed. Existing historical IDs are not repaired
  or promoted; #340 still needs provider readback and reconciliation.
- Message logs, suppression/send outcomes and matched Postmark callbacks retain
  original source/context. Denied/unknown analytics excludes reporting, while the
  operational service record remains. Welcome outcomes cannot enroll marketing
  flows. A callback or current profile cannot grant original analytics permission.

`GP_ACCOUNT_WELCOME_ENABLED` defaults to **false**. Only explicit `true`
activates the original-source worker and retires the existing `customer.created`
subscriber. Capture remains active before activation; analytics and marketing
flags stay independent. Original-source sends require a production source and
server lane, and never promote old test/unknown sources after a key change.

The legacy subscriber keeps current-main behavior, including its existing
customer lookup and guest exclusion. It does not claim immutable registration
or recipient provenance. At activation, API and worker must agree on the flag;
verify source capture, worker health and in-flight provider attempts through
#373 before changing it. Both senders use the same customer welcome idempotency
key. This is a transition, not a claim that legacy welcome data is original
measurement evidence.

No new schema is needed; retain the five publication migrations and existing
communications tables, source/message history and delivery receipts on rollback.
Before the inherited migrating stack releases, verify a fresh protected database
backup, restore access/procedure, migration journal and previous/candidate SHAs.
Paired deployment, request-scope propagation through nested native workflows,
event-bus acceptance/retention, concurrent account changes and controlled recipient/
Postmark/operator readback remain #332 gates. Do not repeat signup to repair email.
The wider PR remains held by #372/#373: this fallback preserves existing welcomes, not the separate retired purchase-producer gap or missing
isolated rehearsal destinations. Do not deploy the whole PR alone.
This does not complete other calendar/segment/SMS/custom-flow/provider producers,
back-in-stock/review-click or browser identity/exposure work. No send is authorized.
