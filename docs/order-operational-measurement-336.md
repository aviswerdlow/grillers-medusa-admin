# Shipping and allocation measurement — #336 / #369

Record this contract before replacing shared producers. Extend the existing
original-order publication journal, activation epoch and independent transport
receipts; do not create another financial or communications owner.

- A shipping notification records an intent, including before native order binding.
  A bounded scan repairs missed notifications from successful bindings. Resolve
  only the immutable accepted order's packing and price evidence. Current order,
  catalog, customer or CMS reads cannot rewrite it. Pickup/local orders are
  explicitly excluded from carrier forecasts.
- Accepted customer shipping, estimated carrier freight and estimated packaging
  are distinct from charged amounts, physical packing and carrier bills. Unknown
  values remain null; free shipping is a real zero. Preserve original policy and
  snapshot IDs. Do not infer freight by subtracting packaging or invent a model
  version that was not recorded.
- Inventory measurement identifies individual durable allocation-audit transitions,
  not the counts returned by a retry. The audit ID, transition time/status and
  quantity are the source; original order binding supplies consent/test/assignment
  context. Audits arriving before binding remain discoverable. Missing or malformed
  audit evidence is unavailable, not reconstructed from today's allocation state.
- These three event types deliver only to classified Jitsu/GP targets. They must
  not increment purchase/profile counters or enroll flows. Preserve independent
  retry/lease behavior and named isolated rehearsal routing. Retire their generic
  fire-and-forget analytics path at the coordinated release.
  Shared pending-delivery alerts require a known production backlog and a live
  backend mode; held tests/unknown sources stay in logs and retained receipts.
- Required stock allocation/release and its operational failure handling remain
  separate. This reader does not repair #312's stopped native reservation fixture
  or make existing mutation/audit writes atomic. Their crash gaps and separately
  classified operational alerts remain launch gates; do not call audit-derived
  reporting a proof of stock correctness.
- The warehouse consumer must retain unavailable values and distinguish estimate
  drift from actual margin. A carrier bill plus a quote is not a settled customer
  charge or actual packaging cost. Replayed source IDs count once, and test/unknown
  classification cannot become a production margin sample.

Requires the new publication-kind migration after the four existing migrations,
the inventory audit schema, paired warehouse view/probe changes and the existing
disabled publication-worker activation. No migrations or flags are applied here.
Retain evidence on rollback and disable the worker rather than deleting receipts
or restoring the old unclassified writers. Actual native audit completeness,
event-before-binding recovery, destination dedup/report/operator evidence and the
full #369 shipment/charge/bill/adjustment ledger still require acceptance in #332.
