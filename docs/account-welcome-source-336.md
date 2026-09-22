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

`GP_ACCOUNT_WELCOME_ENABLED` defaults to **enabled** (unset/empty or `true`).
Explicit `false` or an invalid nonempty value pauses the worker and send guard.
Capture remains active during a pause so resuming can use the original successful
registration, without repeating signup or reconstructing a recipient. This removes
the unapproved default-off service-mail gap; it does not turn analytics or marketing
on. Both the saved source and current server must still be the production lane.
Current Stripe test mode does not send production welcomes, and old test/unknown
sources never become production after a key change.

Against current storefront main, no new request header or frontend flag is needed
for a service welcome. The backend API must capture the source and its paired worker
must run this revision. Warm up and verify that handover before removing the old
release; mixed old/new API and worker versions are not a proven transition. Retain
the shared idempotency key and reconcile in-flight provider attempts. The old delayed
customer.created subscriber remains retired: it can precede failed auth linking and
cannot supply the original recipient safely. Native guest/import/staff customer
creation is not evidence of successful Store account registration.

No new schema is needed; retain the five publication migrations and existing
communications tables, source/message history and delivery receipts on rollback.
Before the inherited migrating stack releases, verify a fresh protected database
backup, restore access/procedure, migration journal and previous/candidate SHAs.
Paired deployment, request-scope propagation through nested native workflows,
event-bus acceptance/retention, concurrent account changes and controlled recipient/
Postmark/operator readback remain #332 gates. Do not repeat signup to repair email.
The wider PR remains held by #372/#373: this default fixes the service-welcome
configuration gap, not the separate retired purchase-producer gap or missing
isolated rehearsal destinations. Do not deploy the whole PR alone.
This does not complete other calendar/segment/SMS/custom-flow/provider producers,
back-in-stock/review-click or browser identity/exposure work. No send is authorized.
