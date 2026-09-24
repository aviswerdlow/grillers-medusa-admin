# Local pickup and delivery events (#367)

This source slice is inert unless `GP_LOCAL_MILESTONES_ENABLED=true`. The flag is
off by default. It adds immutable, versioned milestone and assignment history;
it does not send notices, expose a photo control, or change native fulfillment
status. Those are separate #367 slices and activation gates.

## Authority and release

- The #318 staff gateway authenticates every `/admin/grillers/local-milestones/*`
  route. These handlers independently resolve the current named principal, even
  while the shared staff boundary is in observation mode.
- `driver` has only `milestones.drive`. Office, general staff, managers, and
  super admins have `milestones.drive`, `milestones.office`, and
  `milestones.correct`. A driver sees and changes only orders currently assigned
  to their customer ID. A dedicated office action assigns or replaces the
  driver, retaining every assignment row.
- Every write locks the native order. Pickup readiness may precede native
  fulfillment; collection and every local-delivery step require a supplied
  fulfillment linked to the order and still active. All writes require
  `fulfillment_gate_status=released`, an
  allowed finalization status, and the actual successful card charge or released
  invoice status. Canceled, draft, held, and unknown-payment orders fail closed.
- These routes accept only `plant_pickup`, `southeast_pickup`, `local_delivery`,
  and `atlanta_delivery` fulfillment types from the stored order metadata.

## API

The storefront uses the existing authenticated staff gateway. The route base is
`/admin/grillers/local-milestones`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/orders` | Up to 100 current milestone rows, scoped to the actor |
| GET | `/orders/:id` | State and append-only event history |
| POST | `/orders/:id/assign` | Office assignment with `assignment_id`, `fulfillment_id`, `driver_customer_id` |
| POST | `/orders/:id/events` | Forward transition |
| POST | `/orders/:id/corrections` | Office correction of the current event |
| GET | `/exceptions` | Office rows currently failed or returned |

Event commands include `event_id`, `milestone`, and `expected_version`.
`fulfillment_id` is required except for initial pickup readiness before the
native fulfillment exists. Optional `note` and `reason` are limited to 500 characters.
Corrections also require `correction_of_event_id` and a reason. Failure and
return outcomes require a reason. Clients retain the same event ID and body
when retrying. A replay returns the original event with `duplicate=true`;
reusing its ID for a different payload returns 409. Another actor, order, or
version cannot reuse an event ID. A correction appends a new version and retains
the earlier event, its server occurrence time, and the correction's record time.

Pickup moves `packed → pickup_ready → pickup_collected`. Local delivery moves
`packed → local_dispatched → local_delivered` or
`packed → local_dispatched → local_failed → local_returned`.
Only an authorized office actor can append a correction; a driver cannot mark
`local_returned`. Provider message receipts and carrier labels do not invoke
these routes or create business milestones.

## Pending boundaries

Photo evidence remains an in-memory interface/test design until #367 records
the private bucket and compatible provider go. The phone page must omit the
photo control until then. The #359 action/notice map, #320 driver identities,
and #332 real-device walkthrough remain activation requirements. A green source
PR does not satisfy those runtime gates.
