# P09 catalog-only rehearsal seed

This extends the existing `src/scripts/seed.ts` entrypoint with protected `catalog-export` and `catalog-import` modes. The normal `yarn seed` demo path is unchanged. Thread C runs these modes only after the release lead reviews the exact-head PR and the isolated `gp-launch-r1` Postgres has been created and migrated.

## Scope and custody

The export selects every non-deleted `published` product linked to the store's default sales channel, with its active variants and original product, variant and price IDs. It includes related options, collection/category/tag links, images, variant price sets and prices, inventory items and levels, plus region/tax, store/currency, sales channel, fulfillment, shipping, stock location and provider settings needed for checkout. The table list is finite in `catalog-seed.ts`; unlisted tables cannot be copied. Live `reserved_quantity` and `raw_reserved_quantity` are reset to zero in the export because they reflect production order reservations.

The protected JSON export contains catalog rows and stays outside Git and shared issue comments. Its sidecar manifest and the seed receipt contain SHA-256 and row counts per table. Excluded customer, order, cart, payment, user, invite, API key, notification and communications tables have zero counts in the manifest and must remain empty in the target. A migrated notification *provider* configuration row is not a notification event and remains untouched. Do not copy production environment variables or secrets into the file.

## Operator sequence

1. Resolve and privately verify the production database URL and the new rehearsal Postgres URL from their distinct Railway services. The script opens a source `READ ONLY` transaction and verifies it; use a database read-only credential as an additional limit where one is available. Keep both URLs in protected environment variables; never paste them into GitHub or terminal output.
2. Export once from this reviewed head. Use a protected directory (mode `0700`) and a new output path. Supply `GP_CATALOG_SOURCE_DATABASE_URL`, `GP_CATALOG_EXPORT_FILE`, and, if the store has more than one channel, `GP_CATALOG_SOURCE_SALES_CHANNEL_ID`. Run `yarn seed:catalog:export`. The files are created mode `0600`, without overwrite. Record the manifest SHA-256 and counts.
3. Before import, confirm the target URL is the **new** Postgres service in Railway environment `6484cbf0-661c-4bfb-a4ca-6bfef1e090cd` (`gp-launch-r1`), after empty-schema migration. Supply `GP_CATALOG_TARGET_DATABASE_URL`, `GP_CATALOG_TARGET_ENVIRONMENT_ID=6484cbf0-661c-4bfb-a4ca-6bfef1e090cd`, and `GP_CATALOG_EXPECTED_SHA256` from the export manifest, along with the source URL and export path. Run `yarn seed:catalog:import`.
4. Read the private `.seed-receipt.json`. Every seeded table count must equal its export count and every excluded table count must be zero. Then independently read the rehearsal Store API and checkout settings. Source/seed counts do not prove P09 Preview acceptance, payment or event delivery.

For remote TLS, provide `GP_CATALOG_DB_CA_PEM` where available. Railway's current public Postgres proxy presents a self-signed chain; if a trusted CA is unavailable, set `GP_CATALOG_ALLOW_RAILWAY_SELF_SIGNED_SSL=yes` explicitly for this single run. The script will otherwise stop. The import refuses a target with the same production host and port or resolved server/database identity, a target outside the approved environment label, a mismatched export hash/schema, nonempty excluded tables, or existing product/variant/price/inventory rows. It deletes and inserts only the finite catalog/settings table list inside one target transaction; it never cascades or retries an import.

## Local source and import proof, September 24

The protected read-only production export had SHA-256 `c3e5d1f69d5cbfb37f4640a332bd431d5653d60211c2beb2ce0a487176c9e99f`, with 767 products, 767 variants, 771 prices and 11 shipping options. A fresh local migrated Postgres import reproduced those four counts, left all 120 excluded tables at zero, and had zero reserved inventory. Medusa migration bookkeeping and its bootstrapped notification-provider row stayed untouched. This is a development proof on a local database, not a rehearsal deployment or P09 PASS. Avi's Stripe test-key vault reference remains a separate #373 input.
