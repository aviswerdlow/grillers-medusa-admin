# C04 Constant Contact import contract

This code path is disabled unless `GP_CC_IMPORT_ENABLED=true`. That switch is
for a later, separately approved import window. This PR does not run an import,
enable flows, or send messages.

The admin POST `/admin/grillers/communications/imports` accepts a protected
batch with these fields:

| Field | Meaning |
| --- | --- |
| `batch_id` | Stable identity for one reviewed batch. Replaying identical content returns the completed run; changed content under that identity is rejected. |
| `manifest_sha256` | SHA-256 of the frozen protected C04 manifest. |
| `source_sha256` | SHA-256 of the frozen source archive. |
| `decision_ref` | Exact #341 decision comment referenced in the importer. |
| `rows` | Constant Contact source rows in manifest order. |
| `eligibility` | One reviewed, protected decision per source row, in the same order. |
| `eligibility_sha256` | SHA-256 of the eligibility array using canonical JSON (object keys sorted recursively, original array order). |

Each eligibility entry includes `row_sha256` (canonical JSON SHA-256 of its
source row), canonical `email` or null, explicit `email_eligible` boolean,
and an `exclusion_reason` for excluded rows. An excluded unsubscribe or
suppression needs a `suppression` object with `scope`, `reason`, and
`source` unless the source row itself records an unsubscribe or bounce.
The protected manifest and inputs remain in private custody. Do not include
customer rows in a PR or issue.

The importer uses source status only to veto pending, deleted, bounced, or
unsubscribed rows. It never converts Active, Confirmed, or Subscribed into
consent. It rejects conflicting decisions and duplicate eligible destinations,
persists suppressions before any positive consent projection, rechecks current
GP suppressions, and leaves stronger GP opt-ins and topic opt-outs intact.
It never resubscribes an existing suppression.

New policy grants carry `consent_source=constant_contact_import_2026_09_24`,
the fixed decision link, batch identity, and manifest digest. Their
`email_consent_at` remains null because the policy decision is not a
historical opt-in event. The email send gate recognizes this exact provenance
as the alternative to an actual opt-in timestamp. This importer never changes
SMS consent, phone identity, or historical flow enrollment. SMS requires a
separate verified explicit record for the exact destination number.

The subsequent dry reconcile must compare the protected manifest, fresh
Constant Contact/GP/Postmark vetoes, counts, and row samples in isolation.
Only a separate scoped import approval may enable and call the POST route.
