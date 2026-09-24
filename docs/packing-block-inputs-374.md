# Editable packing inputs and block quantities — #374

The three cost-sheet inputs are explicit CMS values: `DryIcePricePerLb` in
USD/lb, `DryIceBlockWeightLb` in physical lb/block, and each active
`PackagingBoxes[].UnitCost` in USD per whole physical box. None is inferred from
the other. Block weight has no default and is required for enabled publication
and customer packing plans. `MinimumDryIceAmount` remains a separate lb floor.

Each seasonal exposure row now names `Service`, `BoxTier`, `ThroughHours` and
`DryIceBlocksPerBox`. CMS enum values `UPS_3_DAY_SELECT` and `UPS_2ND_DAY_AIR` map
to unchanged carrier codes. The selected calendar supplies actual packing and
arrival instants; approved delay allowance is added before selecting the row.
Transit business days are not substituted for elapsed hours. No wildcard or
other service/box fallback supplies a missing rule. Every permitted service
must have a physically feasible box covering the full policy duration; a small
box may stop at an earlier duration. Duplicate boundaries and decreasing block
quantities in the same service/box group are rejected.

For each eligible box, ice lb = max(minimum ice lb, block lb × blocks per box).
The planner then packs whole sellable units within food/ice fit and physical
food + ice + tare gross limits. It chooses among physically feasible plans by
box-plus-ice cost, then box count, preserving the existing selection contract.
Ice cost is actual planned ice lb × USD/lb; box cost is whole box count × that
box's unit cost. The selected row, block mass, minimum, prices and actual package
plan are copied into the accepted quote and its hash. A later CMS edit changes
a new quote, not the accepted order; it does not authorize a new customer charge.
The same plan continues to supply carrier packages and packaging cost.

Peter's 54 workbook rows remain synthetic conformance evidence, not runtime
weight ranges, physical packing approval or freight training/evaluation labels.
Its fractional small-box factors correspond to proposed ice quantities of 15,
15 and 7.5 lb with 10-lb blocks, not 0.75 physical boxes. The new contract can
represent those quantities through fractional blocks per physical box. Peter
must still approve them and their elapsed-hour mapping. A 38-lb food + 20-lb ice
example cannot be forced into a 50-lb gross box; ice and tare still consume cap.

## Compatibility, recovery and release

No new flag or operating default is introduced. Missing new fields make the
reviewed backend's carrier quote unavailable, never a minimum-based substitute.
The CMS guard is always on. The previous `DryIceMultiplier` column remains for
protected draft/data review, but enabled new policies require it to be cleared
and explicit block rules to be approved. The old seasonal reader then rejects
the missing legacy multiplier rather than silently reading block rules as
minimum multipliers. Do not auto-convert or erase historical/accepted snapshots.

Current backend main predates seasonal packing and will ignore the new fields;
a CMS-only deployment does not activate block-aware packing. Deploying this
backend against current CMS main lacks approved rules and holds carrier quotes.
Coordinate the reviewed CMS/backend release under #372/#374; do not infer safe
activation from independent green CI or an old backend's unchanged quotes.
Storefront guide-only deployment changes no runtime flag/default.

Before schema deployment, verify a fresh protected database and complete
singleton/component export, actual table/relationship inventory (including the
prior `policys` name), restore procedure and isolated recovery. If older candidate
data exists, review its migration explicitly. Enter only approved current costs,
block quantities, physical/fit limits, dates and approval references; keep the
operator ready for same-day republish and runtime readback. #357/#358 remain the
owners of unresolved charge, calendar, cap, small-box and pie-physical inputs.
Reuse #332's one short, long/hot and pie-heavy quote/order/provider rehearsal.
No data was published and no schema/database/provider action ran in this change.

Verification covers CMS mapping/cache, each editable input, fractional ice with
whole boxes, block-size repacking, delayed exposure, service-specific coverage,
physical-cap contradiction, immutable accepted results, rejected invalid/legacy
rules, shared CMS/backend validation and real Strapi schema/document readback.
Synthetic tests and source CI remain distinct from production migration,
physical calibration, approved data and checkout/provider acceptance.
