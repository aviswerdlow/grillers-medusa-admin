// A posting's source facts never change. Delivery leases and receipts are separate.
export const QBD_POSTING_OUTBOX_SQL = `
create table if not exists gp_qbd_posting_outbox (
  id text primary key,
  sequence bigserial not null unique,
  order_id text not null,
  request_key text not null unique,
  action text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency_code text not null,
  order_snapshot jsonb not null,
  depends_on_request_key text null references gp_qbd_posting_outbox(request_key),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'posted', 'failed', 'blocked')),
  attempts integer not null default 0,
  retry_generation integer not null default 0,
  available_at timestamptz not null default now(),
  lease_id text null,
  leased_until timestamptz null,
  bridge_job_id text null,
  receipt jsonb null,
  last_error text null,
  delivered_at timestamptz null,
  posted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists gp_qbd_posting_delivery_idx
  on gp_qbd_posting_outbox(status, available_at, sequence);
create index if not exists gp_qbd_posting_order_idx
  on gp_qbd_posting_outbox(order_id, sequence);
create or replace function gp_qbd_preserve_posting_source() returns trigger as $$
begin
  if (new.id, new.sequence, new.order_id, new.request_key, new.action,
      new.amount_minor, new.currency_code, new.order_snapshot,
      new.depends_on_request_key, new.created_at)
     is distinct from
     (old.id, old.sequence, old.order_id, old.request_key, old.action,
      old.amount_minor, old.currency_code, old.order_snapshot,
      old.depends_on_request_key, old.created_at) then
    raise exception 'QuickBooks posting source is immutable';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists gp_qbd_posting_source_guard on gp_qbd_posting_outbox;
create trigger gp_qbd_posting_source_guard before update on gp_qbd_posting_outbox
  for each row execute function gp_qbd_preserve_posting_source();

-- A started/uncertain refund is deliberately never released by a timeout.
-- Recovery requires comparing the provider receipt with the order ledger.
create table if not exists gp_staff_refund_request (
  id text primary key,
  order_id text not null,
  payment_id text not null,
  request_key text not null,
  fingerprint text not null,
  request_details jsonb not null,
  status text not null check (status in ('started', 'succeeded', 'reconcile')),
  provider_refund_id text null,
  response jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, request_key)
);
create index if not exists gp_staff_refund_unresolved_idx
  on gp_staff_refund_request(order_id, status);
`
