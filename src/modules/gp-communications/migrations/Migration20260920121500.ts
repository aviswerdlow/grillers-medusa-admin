import { Migration } from "@mikro-orm/migrations";

export class Migration20260920121500 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table if not exists "gp_receipt_contact" (
        "id" text primary key,
        "customer_id" text not null,
        "revision" integer not null default 0,
        "active_email" text null,
        "active_verified_at" timestamptz null,
        "pending_challenge_id" text null,
        "last_requested_at" timestamptz null,
        "request_window_start" timestamptz null,
        "request_count" integer not null default 0,
        "last_revoke_request_id" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null
      );`);
    this.addSql(`create table if not exists "gp_receipt_challenge" (
        "id" text primary key,
        "customer_id" text not null,
        "email" text not null,
        "request_id" text not null,
        "token_hash" text null,
        "expires_at" timestamptz not null,
        "status" text not null default 'pending',
        "delivery_status" text not null default 'requested',
        "attempts" integer not null default 0,
        "consumed_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null
      );`);
    this.addSql(`create table if not exists "gp_receipt_snapshot" (
        "id" text primary key,
        "cart_id" text not null,
        "customer_id" text null,
        "email" text not null,
        "contact_revision" integer not null,
        "source" text not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null
      );`);
    this.addSql(
      `create unique index if not exists "UQ_gp_receipt_contact_customer" on "gp_receipt_contact" ("customer_id");`
    );
    this.addSql(
      `create unique index if not exists "UQ_gp_receipt_contact_active_email" on "gp_receipt_contact" ("active_email") where active_email is not null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_gp_receipt_challenge_request" on "gp_receipt_challenge" ("customer_id", "request_id");`
    );
    this.addSql(
      `create index if not exists "IDX_gp_receipt_snapshot_cart" on "gp_receipt_snapshot" ("cart_id");`
    );
  }
  async down(): Promise<void> {
    throw new Error(
      "Receipt contacts contain accepted order evidence; use a reviewed restore plan, not destructive rollback"
    );
  }
}
