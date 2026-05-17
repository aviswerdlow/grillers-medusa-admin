import { Migration } from "@mikro-orm/migrations"

export class Migration20260517000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table if not exists "legacy_customer_map" (
        "id" text not null,
        "legacy_customer_id" text not null,
        "qbd_customer_list_id" text null,
        "medusa_customer_id" text null,
        "medusa_auth_identity_id" text null,
        "email_lower" text null,
        "legacy_username" text null,
        "first_name" text null,
        "last_name" text null,
        "phone" text null,
        "auth_import_status" text null,
        "address_import_status" text null,
        "last_imported_at" timestamptz null,
        "metadata" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "legacy_customer_map_pkey" primary key ("id")
      );
    `)

    this.addSql(`
      create table if not exists "legacy_item_map" (
        "id" text not null,
        "qbd_item_list_id" text not null,
        "qbd_name" text null,
        "sku" text null,
        "medusa_product_id" text null,
        "medusa_variant_id" text null,
        "medusa_product_title" text null,
        "medusa_variant_title" text null,
        "confidence" numeric not null default 0,
        "mapping_source" text null,
        "last_seen_at" timestamptz null,
        "metadata" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "legacy_item_map_pkey" primary key ("id")
      );
    `)

    this.addSql(`
      create table if not exists "legacy_order" (
        "id" text not null,
        "source" text not null,
        "source_order_id" text not null,
        "qbd_txn_id" text null,
        "ref_number" text null,
        "legacy_order_id" text null,
        "legacy_customer_id" text null,
        "qbd_customer_list_id" text null,
        "medusa_customer_id" text null,
        "email_lower" text null,
        "customer_name" text null,
        "placed_at" timestamptz null,
        "ship_date" timestamptz null,
        "status" text null,
        "subtotal" numeric not null default 0,
        "tax_total" numeric not null default 0,
        "shipping_total" numeric not null default 0,
        "discount_total" numeric not null default 0,
        "total" numeric not null default 0,
        "currency_code" text not null default 'usd',
        "line_count" numeric not null default 0,
        "searchable_text" text null,
        "source_updated_at" timestamptz null,
        "imported_at" timestamptz null,
        "source_snapshot" jsonb null,
        "metadata" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "legacy_order_pkey" primary key ("id")
      );
    `)

    this.addSql(`
      create table if not exists "legacy_order_line" (
        "id" text not null,
        "legacy_order_id" text not null,
        "source" text not null,
        "source_line_id" text not null,
        "qbd_txn_line_id" text null,
        "qbd_item_list_id" text null,
        "sku" text null,
        "title" text null,
        "description" text null,
        "quantity" numeric not null default 0,
        "unit_price" numeric not null default 0,
        "line_total" numeric not null default 0,
        "currency_code" text not null default 'usd',
        "medusa_product_id" text null,
        "medusa_variant_id" text null,
        "medusa_product_title" text null,
        "medusa_variant_title" text null,
        "mapping_status" text null,
        "imported_at" timestamptz null,
        "source_snapshot" jsonb null,
        "metadata" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "legacy_order_line_pkey" primary key ("id")
      );
    `)

    this.addSql(`
      create unique index if not exists "IDX_legacy_customer_map_legacy_customer_id"
      on "legacy_customer_map" ("legacy_customer_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_customer_map_qbd_customer_list_id"
      on "legacy_customer_map" ("qbd_customer_list_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_customer_map_medusa_customer_id"
      on "legacy_customer_map" ("medusa_customer_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_customer_map_email_lower"
      on "legacy_customer_map" ("email_lower")
      where deleted_at is null;
    `)

    this.addSql(`
      create unique index if not exists "IDX_legacy_item_map_qbd_item_list_id"
      on "legacy_item_map" ("qbd_item_list_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_item_map_sku"
      on "legacy_item_map" ("sku")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_item_map_medusa_variant_id"
      on "legacy_item_map" ("medusa_variant_id")
      where deleted_at is null;
    `)

    this.addSql(`
      create unique index if not exists "IDX_legacy_order_source_order_id"
      on "legacy_order" ("source", "source_order_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_medusa_customer_id"
      on "legacy_order" ("medusa_customer_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_qbd_customer_list_id"
      on "legacy_order" ("qbd_customer_list_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_legacy_customer_id"
      on "legacy_order" ("legacy_customer_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_email_lower"
      on "legacy_order" ("email_lower")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_placed_at"
      on "legacy_order" ("placed_at")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_searchable_text"
      on "legacy_order" using gin (to_tsvector('simple', coalesce("searchable_text", '')))
      where deleted_at is null;
    `)

    this.addSql(`
      create unique index if not exists "IDX_legacy_order_line_source_line_id"
      on "legacy_order_line" ("source", "source_line_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_line_legacy_order_id"
      on "legacy_order_line" ("legacy_order_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_line_qbd_item_list_id"
      on "legacy_order_line" ("qbd_item_list_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_line_sku"
      on "legacy_order_line" ("sku")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_legacy_order_line_medusa_variant_id"
      on "legacy_order_line" ("medusa_variant_id")
      where deleted_at is null;
    `)
  }

  async down(): Promise<void> {
    this.addSql('drop table if exists "legacy_order_line";')
    this.addSql('drop table if exists "legacy_order";')
    this.addSql('drop table if exists "legacy_item_map";')
    this.addSql('drop table if exists "legacy_customer_map";')
  }
}
