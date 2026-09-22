# Materialized audience refresh boundary — #336 / #341

Source contract recorded before changing the shared segment readers. This is a
bounded correction to audience selection, not approval to activate campaigns or
calendar flows. The full #356 communications program remains required.

## Observed failures

- An absent ClickHouse connection returned an empty list and erased membership.
- A failed warehouse query left old membership intact but counted as refreshed.
- Calendar enrollment and warehouse-backed campaign selection accepted that old
  membership without checking the definition or the last successful computation.
- Profile segment refresh silently stopped at 10,000 profiles.

## Contract

Refresh the current definition under a segment row lock. Replace membership and
its receipt atomically; a failed query or oversized result leaves the old rows for
diagnosis but records the latest attempt as unavailable. Successful empty results
are valid, separately recorded results. Never count a failed attempt as refreshed.
Concurrent attempts serialize; definition changes cannot be overwritten by a
result evaluated against an earlier definition. A membership-write failure rolls
back those writes before the unavailable receipt is saved.

The receipt records the definition hash, refresh identity, observation/completion
times, member count and member-set hash. It does not label the source as production
or grant permission to contact any member. Every active member carries the same
refresh identity. No new schema or historical backfill is required.

Materialized readers lock and read the current receipt and membership together.
They reject inactive, never-refreshed, failed, altered, incomplete or older-than-
24-hour results. Missing or failed receipts hold sending until a successful refresh.
Campaigns report unavailable, including SMS campaigns sharing the audience reader;
calendar enrollment counts a held flow and creates no new enrollments from it.
Consent and suppression checks remain independently required.

## Refresh recovery and alerts

The `gp-communications-audiences` job runs every 15 minutes without a new flag. It
only recomputes membership: it does not enroll flows, run campaigns or send messages.
Missing/failed/changed receipts are due immediately; successful receipts are renewed
at six hours, ahead of the 24-hour reader limit. Segment row locks serialize writes.
This job does not restart or enable deliberately stopped marketing workers.

Before activating an audience, run the refresh-only release warm-up with the correct
API/worker environment: `yarn medusa exec ./src/scripts/refresh-communication-audiences.ts`.
It exits unsuccessfully if any active audience remains unavailable. Inspect the
saved refresh receipt and its reason, repair the named query/source/storage problem,
then repeat that bounded refresh. Do not use **Run flows** to repair membership:
that maintenance action can send due campaigns. Do not clear membership or loosen
consent to make the refresh succeed.

Failed refresh results and held calendar enrollments emit
`communications_audience_held` warnings even when no exception was thrown. The two
stages each coalesce repeats for 15 minutes per process, with a suppressed count;
a successful stage clears its cooldown. Counts contain no customer identities.
The same warning is logged locally, so missing analytics alert credentials do not
hide the hold. Alert failure does not release an audience or interrupt other work.
Storage failures that cannot save a receipt fail the job and use the scheduled-job
failure alert. A working alert receiver and the release warm-up still need runtime
readback; local fixtures do not prove either.

Against other repos' current mains this refresh is backend-only and requires no
frontend/CMS change. Initial selection remains held until the warm-up succeeds;
the periodic retry is recovery, not evidence that activation is safe. No schema is
added here. This does not waive the inherited migration backup or the wider PR's
#372/#373 no-gap, original-source and isolated-rehearsal release gates.

## Remaining launch gates

This boundary does not repair warehouse email-to-profile matching, classify older
warehouse/profile data, prove absence of an order, freeze an original recipient or
consent, or revoke an already selected/queued audience. Complete original-purpose
calendar/segment snapshots, flow/version and recipient vetoes, SMS and provider
classification, and deliberate activation before the controlled #332 rehearsal.
Do not infer readiness from a fresh membership receipt. Historical unclassified
activity must not acquire production status or permission from today's profile.

Query/storage failures that prevent recording a receipt must surface as a failed
maintenance run; never report them as a successful empty refresh. No deployment,
provider send, audience activation or production configuration is authorized by
this source change.
