# Fulfillment calendar candidate — launch #362

September 21 rollout correction: enforcement now defaults off for legacy carts;
signed choices retain their checks. See [calendar rollout compatibility](calendar-rollout-372.md)
for the capability endpoint, required-mode activation gate and remaining
storefront/staff fallback work in #372. This is not whole-PR preview acceptance.

Tracking: https://github.com/aviswerdlow/grillers-pride-strategy/issues/362

This is an **in-progress, coordinated release candidate**. Do not deploy it by
itself. Source tests are not an approved operating calendar, a native Medusa
database rehearsal, or a carrier/production receipt. Staff phone-entry source is implemented;
post-order shipping overrides and the combined native rehearsal remain open. Original acceptance and
dependencies remain open.

## Contract and ownership

`POST /store/grillers/checkout/fulfillment-calendar` accepts `action`, `cart_id`,
and optional `shipping_option_id` / regional `route_id`. `list` reads the actual
cart and shipping option, published CMS operating data and an explicitly approved
transit fallback. It returns customer arrival/pickup choices, windows, internal
pick/dispatch dates, Eastern cutoff instants, elapsed cold-chain hours, carrier
business days, calendar/transit revisions, expiry and a context revision.

`select` additionally needs `arrival_date`, `window_id` where applicable and the
displayed `context_revision`. UPS calls the existing WWEX **quote**, never booking,
when configured. A changed carrier date returns `state: changed` and a signed
`replacement_quote`; the caller must obtain an explicit new customer selection.
It cannot silently select the proposed date. The response cache belongs to the
exact origin, destination, service, dispatch date and packed request, is bounded,
and expires from request start rather than extending the life of a slow response.
Cross-process replacement acceptance uses the signed token, not that cache.

A successful selection returns metadata for the native cart update. Storefront
actions preserve staff-cart authorization and reattach the exact option to refresh
its persisted packing snapshot. `validate` checks the selected current cart without
changing an order. There is no free-form-date or generic ZIP-table acceptance.

`fulfillment_calendar_selection_v1` is a signed cart selection. It binds the actual
cart/customer, address, basket/price, currency/region, service/route/window, policy
revision and expiry. The backend-only `GRILLERS_CALENDAR_SIGNING_KEY` must contain
at least 32 bytes. Never use a public storefront variable or check it into Git.
No production key has been created or changed by this work. Key rotation
invalidates outstanding cart selections; accepted order snapshots remain readable.

Native and custom completion preparation write
`fulfillment_calendar_accepted_v1`. The native workflow validate hook compares the
loaded cart against fresh source/cart data and the signed selection. These fields
must be loaded by the real Medusa workflow, which remains a release rehearsal gate.
Completed-cart replays do not recalculate a historical order. Store projection
hides the accepted internal object. No source test proves actual database
serialization or prevents every concurrent mutation after the hook; #312 owns
stock/order coordination, and its stopped fixture must not be retried here.

## Operating data and approvals

Use the companion Strapi schema candidate before publishing policy data. Approval
is a business input, not inferred from the existence of old fields or historical
calendar code. Peter's #358 answer, #324 closures and #325 routes supply it.

- Checkout `FulfillmentCalendarPolicy`: revision, approval reference/time, coverage
  dates, `America/New_York`, origin ZIP, horizon (1–60 days), quote lifetime
  (30–1800 seconds), plant operating days, UPS dispatch/carrier/arrival weekdays,
  preparation days, cutoff/packing/arrival-by times, maximum packed hours and an
  explicit decision about non-delivery-day holds.
- Plant policy also needs preparation/cutoff days and times, pickup windows and any
  weekday cutoff overrides. Existing plant weekdays, additional dates and blackouts
  are consumed. There is no implicit Monday/Friday cutoff approval.
- Keep `FulfillmentBlackoutDates` operations, UPS pickup and UPS delivery flags
  separate. Historical `ShippingBlackoutDates` still block UPS pickup and delivery.
  A UPS-only holiday does not close local pickup/delivery.
- Every active Atlanta zone and regional route needs Calendar Preparation Days,
  Calendar Cutoff Days/Time, Calendar Pack Time and Calendar Windows. Existing ZIP
  weekdays and confirmed regional Available Dates are consumed. Past-only or empty
  Chattanooga/Gainesville-like routes remain unavailable. Inactive rows are ignored;
  an incomplete **active** row rejects policy loading for review rather than
  inventing a schedule. Approval must cover all consumed active records.
- `FulfillmentTransitRules` holds approved fallback business days by origin ZIP,
  exact service and destination ZIP prefix, with its own revision, approval and
  coverage. Longest matching prefix wins; ties are rejected. No unapproved nationwide
  five-day or April ZIP-table fallback exists. This candidate requires a fallback
  to present initial UPS choices; a configured carrier then checks the selected
  dated shipment. Carrier-only initial choice discovery is not implemented.
  The CMS uses `UPS_3_DAY_SELECT` and `UPS_2ND_DAY_AIR` so its GraphQL schema can
  start. This adapter maps those values to the existing `3_DAY_SELECT` and
  `2ND_DAY_AIR` carrier codes; `GROUND` and `OVERNIGHT` are unchanged. Publish the
  corrected Strapi schema with this backend adapter in the coordinated calendar
  release. Old digit-leading CMS values are invalid and are not accepted as a
  substitute. Existing carrier requests and customer shipping methods retain
  their current identifiers.

All clock comparisons use real Eastern offsets, including daylight saving. Carrier
business days are not elapsed cold-chain days. `packingDays = ceil(elapsedHours/24)`
drives the existing ice/box maximum-duration rules; `transitDays` remains the carrier
business-day value. #363 must validate seasonal rules against this contract.
The arrival-by time is a conservative operating estimate, not a guaranteed carrier
delivery time. This version uses Eastern Time for every configured window; do not
approve a route in another time zone without an explicit correct customer promise.

## Consumers and remaining work

- Storefront: all customer modes consume the new endpoint, preserve context,
  announce errors, discard late responses, require explicit confirmation and check
  again before card setup/order submission. Regional locations with no future
  choice show an empty state. The plant recovery shortcut no longer invents today.
- Staff: frontend PR 53 separates draft creation, signed calendar selection and
  payment/link preparation. It rechecks actual date, inventory and actor before
  payment setup, immediately before card confirmation and before native completion.
  Free-form dates are refused; changed draft inputs discard the old payment form.
  Inventory exception receipts are renewed for the selected date only after an
  explicit staff review. Completed-cart replay does not recheck consumed inventory.
- Integrate #318/#319 backend PR 32 commit `92717bd` alongside this candidate. Its
  exact calendar quote endpoint retains staff identity checks but does not demand
  payment-ready ATP before a date can be chosen. All actual payment/completion
  endpoints retain ATP/override checks. Do not apply a broad checkout bypass or
  remove #313 final-charge protection. The two backend branches are not merged here.
- Regional routing reads country/state from the actual cart, normalizes US state
  names/codes and offers only active stops in that state. Cross-state/non-US
  requests fail before a signed choice; changing address invalidates acceptance.
  The optional `regionalLocations` list contains id/city/state, never an inferred
  operating date. Empty and past-only schedules remain unavailable.
- Staff post-order changes: preserve original accepted promise, validate a proposed
  replacement against the current operating source and record the exception/approval
  history. #368 owns durable operating exceptions and downstream projections.
- Date fields use ISO `YYYY-MM-DD`: `requestedDeliveryDate` and `scheduledDate`
  are customer arrival/pickup; `fulfillmentPickDate` is preparation;
  `fulfillmentDispatchDate` and compatibility `qbdDueDate` are dispatch.
  `fulfillmentWindowLabel` / `fulfillmentCalendarTimezone` preserve the approved
  window for customer views and email instead of reinterpreting a window id.
  The native hook compares those projections with the signed accepted choice.
- The finalization queue filters by dispatch, returns `dispatch_date`, `pick_date`
  and `arrival_date` separately, and keeps older UPS/regional orders lacking
  dispatch visible in an unfiltered queue. Never relabel their arrival as ship day.
  Legacy plant/Atlanta same-day dates remain usable. #364 still owns stock needed
  by preparation; the inventory allocation's requested customer date is unchanged.
- Confirmation/cart/checkout display civil dates without a browser-timezone shift.
  U.S. legacy date-only strings remain supported; invalid dates require review.
  Confirmation email renders arrival/window, recognizes regional pickup and Atlanta
  delivery, and promises tracking only for shipped orders. #367 still owns payment
  wording, lifecycle milestones, durable send/delivery evidence and exceptions.
- The companion QBD bridge candidate on PR 7 gives Sales Orders the explicit dispatch
  field. A/R invoices must ignore checkout `qbdDueDate`. Calendar orders ignore stale
  generic due-date aliases and inherit QBD terms unless `qbd_invoice_due_date` is
  explicitly supplied. #370 owns the trusted source/authority for that optional
  collection deadline; its presence is not proof of approval. Legacy pre-calendar
  snake-case A/R aliases remain compatible. Card invoices stay due on transaction day.
  No existing order, QBD document or live account was rewritten.
- #368 amendments must update projections only after current-calendar, inventory,
  repricing and customer-approval consequences pass atomically/durably. The existing
  free-form `shipping_override` mutation is not that workflow; do not release it as
  a safe amendment or overwrite the original accepted calendar snapshot.
- #361 weights and trusted packing snapshot stay required. The forecast's commercial
  price remains separate from carrier transit and calendar eligibility; #331 owns
  price policy and #363 owns seasonal ice/packing calibration.

## Smallest remaining acceptance set

1. Complete #331 pricing and #364 inventory interfaces, then #368 post-order amendments and the remaining allocation/report consumers. Staff entry
   source fixtures now cover authority, changed/expired dates and pre-charge refusal;
   real native workflow and provider acceptance remain required.
2. Review paired CMS/backend/frontend exact-head CI. Do not rerun an equivalent full
   suite locally. Unit fixtures cover calendar/DST/cutoffs, source pagination,
   incomplete policy, signed revisions, changed cart, carrier cache/late response,
   native/custom guard calls and packing propagation. They do not start live services.
3. After Peter's approval and explicit publication/key authorization, rehearse in
   a controlled environment with a real native cart/workflow and test identity:
   all four modes; last-minute closure; expired quote; concurrent basket change;
   direct API bypass attempt; actual carrier response; order snapshot and QBD due
   date; staff entry and override. Keep money, Medusa, carrier and QBD receipts separate.
4. Show desktop/mobile checkout with real staged source data and keyboard/error-focus
   behavior. Synthetic component screenshots cannot satisfy this native rehearsal.
5. Obtain the separately authorized coordinated release. Snapshot CMS, preserve the
   old deploys and record key/version custody. Roll back the paired code/data versions
   if required; never recalculate or rewrite existing accepted order snapshots.

No issue may close on these source artifacts alone.
