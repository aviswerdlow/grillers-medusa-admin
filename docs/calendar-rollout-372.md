# Calendar rollout compatibility — #362 / #372

The backend calendar defaults to `GP_CALENDAR_ENFORCEMENT=off`. This is a
deployment transition, not launch acceptance or a replacement for the approved
calendar. With the switch unset or `off`, an existing cart without calendar
evidence keeps the preceding checkout and shipping-plan path. It does not need
the new CMS calendar or `GRILLERS_CALENDAR_SIGNING_KEY` merely to complete.

Set `GP_CALENDAR_ENFORCEMENT=required` only in the coordinated calendar rollout.
Any other nonempty configured value also enforces the calendar rather than
silently disabling it. Keep the existing payment, inventory, shipping-weight,
packing-policy and staff-identity controls in either mode.

## Seasonal packing boundary in PR35 and descendants

The predecessor calendar PR34 retains its prior undated UPS packing path while
calendar enforcement is off. This seasonal-packing branch intentionally cannot
use that fallback: #363/#374 require validated transit/exposure and approved
seasonal data. Quote and method selection still load calendar transit; UPS
completion still requires a verified selected date. Only pickup and local
legacy completion are released from the new calendar-token requirement here.
The new tests assert that off mode cannot bypass this shipping boundary.

Consequently the UPS deployment-order gap is still open in #372. Complete the
storefront fallback/activation work and reconcile the legacy UPS transition
with the accepted #374 publication lock before claiming independent deployment.
Do not turn off seasonal safeguards, manufacture transit dates or automatically
replace a customer's arrival date to force a passing checkout. The carrier
fallback description below applies to predecessor PR34 only.

## Contract

- `GET /store/grillers/checkout/fulfillment-calendar` returns
  `{ "enforcement": "off" }` or `{ "enforcement": "required" }` with no-store
  caching. It exposes no cart/customer data and does not depend on a working CMS
  or signing key. Required mode stays required during an infrastructure outage.
- For an unsigned legacy cart in off mode, POST `validate` returns
  `{ "state": "legacy", "summary": null }`. POST `list`/`select` returns 503
  `calendar_not_enabled`; it must not manufacture new approved dates.
- Native preparation and completion skip only the new calendar requirement for
  that legacy cart. A warning containing `calendar_enforcement_off` and cart ID
  records the compatibility path; no customer/contact/content/key data is logged.
- Carrier quote and method selection use the preceding service/ZIP packing
  context until calendar activation. Physical mass, fit units, approved packing
  configuration, persisted plan comparison and line snapshots still apply.
- A cart with a calendar token, accepted snapshot or calendar quote ID must keep
  the strict calendar path even if enforcement is switched off. Missing keys,
  unavailable source data, altered lines, changed dates or a removed promise
  block that cart. Existing completed-cart replays remain read-only.

## Evidence and release boundary

Focused tests exercise all four legacy fulfillment modes through native
preparation and completion, no CMS/key dependency, capability values, explicit
off-mode preservation of an existing signed choice, missing/tampered evidence,
completed replay, and carrier quotation/selection under both modes. The existing
required-mode fixtures explicitly set `required`; their guards are unchanged.
Run the canonical exact-revision CI after carrying the correction through the
backend stack. Do not rerun an unchanged full local suite.

This source correction covers the backend calendar boundary. Storefront #53
and its descendants still need the independently deployed frontend fallback:
retain the existing fulfillment controls only for the old/unactivated backend,
keep legacy date saves available during that transition, and recheck before
payment. A required-mode outage or an already signed cart must not downgrade.
Staff draft/payment paths require the same review. #368's order-review rollout,
#365 contact route and #318/#319 staff authorization compatibility remain
separate open work in #372. This document does not establish whole-PR preview
acceptance while those inherited gates remain.

Before enabling `required`, record the deployed CMS/backend/storefront revisions,
Peter-approved published coverage/cutoffs/windows/transit policy, signing-key
custody, and one successful preview order per fulfillment mode. Rehearse both
deployment orders and loss of the CMS/key after activation. Preserve existing
accepted dates rather than clearing cart evidence to work around an error.
Keep the prior revision and a documented recovery plan. Every migrating release
also requires its fresh backup/recovery record. No production flag, key, policy,
deployment, migration or order was changed by this source work.
