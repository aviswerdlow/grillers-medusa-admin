# Legacy Customer and Order Migration Runbook

This migration keeps the customer experience frictionless while keeping QuickBooks Desktop as the historical source of truth.

## What Gets Imported

- Legacy site customer accounts with valid emails.
- Existing legacy passwords re-hashed into Medusa emailpass provider metadata.
- Legacy usernames as additional emailpass provider identities, so password managers that fill the old username can still authenticate.
- Legacy billing and shipping addresses into the Medusa customer address book.
- QuickBooks Desktop invoice history into `legacy_order`, `legacy_order_line`, and `legacy_item_map`.

The customer-facing reorder page reads both native Medusa orders and the QuickBooks-backed projection. Mapped historical products render as reorderable product cards. Unmapped or no-longer-online product lines still render as historical items instead of being hidden. Non-product QuickBooks lines such as subtotals, pickup rows, card fees, discounts, shipping rows, and notes remain available in admin historical order lookup but are filtered out of the customer reorder list.

## Required Environment

Backend:

- `DATABASE_URL`
- `JWT_SECRET`
- `COOKIE_SECRET`
- Normal Medusa/Redis env used by this app

Legacy customer import:

- `LEGACY_DB_HOST`
- `LEGACY_DB_PORT`
- `LEGACY_DB_NAME`
- `LEGACY_DB_USER`
- `LEGACY_DB_PASSWORD`
- optional `LEGACY_DB_SSL=1`

QuickBooks import:

- `CONDUCTOR_SECRET_KEY` or `CONDUCTOR_API_KEY`
- `CONDUCTOR_END_USER_ID`

The QBD script first checks the backend env and then falls back to `../grillerspride/.env` for Conductor credentials.

## Commands

Run migrations first:

```bash
yarn medusa db:migrate
```

Dry-run customers:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-legacy-customers.ts -- --limit=100
```

Apply customers:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-legacy-customers.ts -- --apply
```

By default, existing Medusa provider passwords are not overwritten. To deliberately refresh existing imported hashes from the legacy password source:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-legacy-customers.ts -- --apply --update-existing-passwords
```

Dry-run QBD invoices via Conductor:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-qbd-order-history.ts -- --source=conductor --start-date=2016-01-01 --end-date=2026-05-17 --max-records=200
```

Read the dry-run summary before applying. The important fields are:

- `productLines`: QBD lines that should appear in customer reorder history.
- `nonProductLines`: ledger/service/note rows preserved for admin lookup but hidden from reorder.
- `mappedLines`: product lines mapped to a current Medusa variant.
- `uniqueUnmappedProductItems` and `topUnmappedProductItems`: SKUs/QBD item ids that need product SKU or metadata mapping coverage before they can be one-click reorderable.

Apply QBD invoices via Conductor:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-qbd-order-history.ts -- --source=conductor --start-date=2016-01-01 --end-date=2026-05-17 --apply
```

If the dry-run reports unmapped product SKUs that should be one-click reorderable, create a CSV with these columns:

```csv
qbd_item_list_id,sku,medusa_variant_id,medusa_sku,confidence,mapping_source
8000071A-1337017833,1-76-25-1,,1-76-25-1,1,manual_csv
```

Either `medusa_variant_id` or `medusa_sku` can identify the target variant. `qbd_item_list_id` is preferred because it is stable across QuickBooks item renames. Dry-run the mapping file:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-legacy-item-maps.ts -- --file=./legacy-item-maps.csv
```

Apply approved mappings and backfill already imported historical lines:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-legacy-item-maps.ts -- --file=./legacy-item-maps.csv --apply
```

Fallback to the legacy MySQL invoice XML mirror:

```bash
./node_modules/.bin/medusa exec ./src/scripts/import-qbd-order-history.ts -- --source=legacy-mysql --start-date=2016-01-01 --end-date=2026-05-17 --apply
```

## Verification

After import, verify projection counts:

```sql
select count(*) from legacy_customer_map;
select count(*) from legacy_order;
select count(*) from legacy_order_line;
select count(*) from legacy_item_map;
```

Spot-check admin lookup:

- Open Medusa Admin.
- Go to Historical Orders.
- Search by customer name, invoice/ref number, SKU, or item title.
- Open an order and confirm line-level contents are visible.

Spot-check storefront reorder:

- Sign in as a migrated customer.
- Open `/us/account/reorder`.
- Confirm native Medusa items and imported QBD historical product lines both appear.
- Confirm mapped items are product cards and unmapped product lines are visible as unavailable historical items.
- Confirm QuickBooks ledger/service rows such as `Subtotal`, `CCC`, pickup, discount, and note lines do not appear in reorder history.

## Safety Notes

- Do not run `--apply` against production until dry-runs have clean failure counts and the migration has been applied.
- The scripts intentionally avoid printing customer emails, addresses, or passwords in logs.
- QuickBooks is read-only through Conductor. The Medusa database receives only the projection.
- The customer import assumes legacy `CUSTOMERS.PASSWORD` values are usable plaintext or legacy-cleartext equivalents. If a subset fails real login testing, re-check password encoding before broad launch.
