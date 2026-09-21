import { Migration } from "@mikro-orm/migrations";

/** Deliberately SQL-owned ledger: all writes pass through transactional commands. */
export class Migration20260920150000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`create table if not exists gp_incoming_batch (
      id text primary key, variant_id text not null, qbd_list_id text not null,
      stock_unit text not null, source_system text not null, source_ref text not null,
      expected_quantity integer not null check (expected_quantity >= 0),
      confirmed_quantity integer not null default 0 check (confirmed_quantity >= 0),
      usable_at timestamptz not null, status text not null check (status in ('draft','confirmed','cancelled','receipt_pending')),
      revision integer not null default 0, created_by text not null,
      confirmed_by text, confirmed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (source_system, source_ref)
    );`);
    this.addSql(`create table if not exists gp_incoming_demand (
      id text primary key, variant_id text not null, qbd_list_id text not null, stock_unit text not null,
      order_id text, cart_id text, line_item_id text not null,
      quantity integer not null check (quantity > 0), remaining_quantity integer not null check (remaining_quantity >= 0 and remaining_quantity <= quantity),
      needed_by timestamptz not null, customer_date date not null, calendar_revision text not null,
      status text not null check (status in ('committed','released')), exception_reason text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      check (order_id is not null or cart_id is not null)
    );`);
    this.addSql(`create table if not exists gp_incoming_commitment (
      id text primary key, demand_id text not null references gp_incoming_demand(id),
      batch_id text not null references gp_incoming_batch(id), batch_revision integer not null,
      quantity integer not null check (quantity > 0), remaining_quantity integer not null check (remaining_quantity >= 0 and remaining_quantity <= quantity),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (demand_id,batch_id)
    );`);
    this.addSql(`create table if not exists gp_incoming_receipt (
      id text primary key, batch_id text not null unique references gp_incoming_batch(id),
      source_system text not null, source_ref text not null, quantity integer not null check (quantity >= 0),
      usable_at timestamptz not null, recorded_by text not null,
      status text not null default 'pending_adapter' check (status = 'pending_adapter'),
      created_at timestamptz not null default now(), unique (source_system,source_ref)
    );`);
    this.addSql(`create table if not exists gp_incoming_event (
      request_id text primary key, payload_hash text not null, event_type text not null,
      variant_id text not null, actor_id text not null, reason text not null,
      payload jsonb not null, result jsonb not null, created_at timestamptz not null default now()
    );`);
    this
      .addSql(`create index if not exists gp_incoming_batch_supply on gp_incoming_batch (variant_id,status,usable_at);
      create unique index if not exists gp_incoming_demand_cart_line on gp_incoming_demand (cart_id,line_item_id) where cart_id is not null and status = 'committed';
      create unique index if not exists gp_incoming_demand_order_line on gp_incoming_demand (order_id,line_item_id) where order_id is not null and status = 'committed';
      create index if not exists gp_incoming_commitment_batch on gp_incoming_commitment (batch_id);
      create index if not exists gp_incoming_demand_order on gp_incoming_demand (order_id);
      create index if not exists gp_incoming_event_variant on gp_incoming_event (variant_id,created_at);`);
  }
  async down(): Promise<void> {
    throw new Error(
      "Incoming stock contains commitments and receipt evidence. Use a reviewed restore plan."
    );
  }
}
