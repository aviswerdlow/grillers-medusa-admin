# Launch migration recovery (#372)

The source candidates now tolerate replay of the incoming-stock, accepted-order,
rehearsal-delivery, lifecycle and refund-provider migrations. The later operational
event-kind migration uses the same expansion rule. This does not authorize a live
migration or prove that a production backup exists.

## Release and backup gate

Before **each merging/deployment step that applies migrations**, the release
operator records the intended Railway project/service/database, current deployed
SHA and migration journal, candidate SHA, fresh backup receipt and restore
target/procedure. Verify backup completion and access to the recovery copy before
starting the step. Retain the previous application revision and the separately
approved recovery owner. A backup recorded for an earlier step is not evidence of
a fresh backup for the next database change.

Rehearse the exact candidate against an isolated restored database, with outbound
payments, accounting and messages disabled. Capture the migration journal before
and after, schema/row preservation, application health and the relevant checkout,
stock and communications acceptance. Production application remains a separate
authorized action. Do not activate publication or enforcement flags merely
because migration checks pass.

## What retry preserves

- `20260920150000`: retain incoming batches, demand, commitments, receipts and
  append-only events; finish missing tables/indexes without dropping data.
- `20260920174500`: retain accepted reviews, snapshots and bindings; install only
  missing immutable-evidence triggers without dropping existing protection.
- `20260920223000`: preserve pinned rehearsal routes and delivery status,
  attempts and accepted receipts. Repeated backfill uses the existing unique key.
- `20260920235000`: install lifecycle source/uniqueness guards before removing
  the superseded uniqueness constraint and expanding allowed kinds.
- `20260921001500`: retain provider scope, scan cursor, queue generations,
  receipt history, order bindings and metrics. Reinstall missing triggers only.
- `20260921033000` and the earlier kind/target expansions: preserve values
  accepted by a later constraint. Replaying an older migration cannot narrow
  the newer enum or continually grow the constraint expression.

Each expansion is one atomic PostgreSQL `DO` statement. A missing constraint is
restored from the owning migration's allowed set. If a newer constraint was
removed outside the migration transaction, restore it with that **newest owning
migration** first; an older migration is not an authority to invent later values.
Unknown event kinds, missing lifecycle source IDs, duplicate original orders and
invalid delivery targets remain rejected.

## Recovery procedure

Keep the failed deployment and its exact error/journal evidence. Confirm which
DDL completed before deciding whether the ordinary migration runner can resume.
These changes do not force already-journaled migrations to run again. Do not
delete journal entries, drop tables, erase queued evidence or guess that an
existing but divergent object matches the intended schema. Investigate schema
drift and use an explicitly reviewed forward repair or restore plan. Irreversible
`down()` methods still refuse to discard operational history.

The focused tests execute the actual migration SQL in isolated PostgreSQL
schemas, with populated rows and deliberate missing-object fixtures. They are
source/recovery tests, not evidence of live backup custody, deployment, external
provider delivery or full launch acceptance. Existing integration gates cover
the unchanged business behavior as part of each candidate's exact-SHA CI.
