import { publicationCheckSql } from "./order-publication-migration";

export const REFUND_PROVIDER_SQL = `
create table if not exists gp_refund_provider_scope (
  id integer primary key check (id = 1), account_id text not null,
  livemode boolean not null, starts_at timestamptz not null,
  scan_after text, lease_token text, lease_until timestamptz
);
create table if not exists gp_refund_provider_event (
  event_id text primary key, refund_id text not null, event_type text not null,
  payload_hash text not null, event_created_at timestamptz not null,
  received_at timestamptz not null default now()
);
create table if not exists gp_refund_provider_queue (
  refund_id text primary key, generation integer not null default 1,
  due_at timestamptz not null default now(), attempts integer not null default 0,
  reason text, last_checked_at timestamptz
);
create index if not exists gp_refund_provider_due on gp_refund_provider_queue(due_at,refund_id);
create table if not exists gp_refund_provider_receipt (
  id text primary key, refund_id text not null, revision integer not null,
  account_id text not null, livemode boolean not null,
  payment_intent_id text not null, native_refund_hint text,
  amount_minor bigint not null check (amount_minor > 0), currency_code text not null,
  status text not null check (status in ('pending','requires_action','succeeded','failed','canceled')),
  provider_created_at timestamptz not null, observed_at timestamptz not null,
  unique (refund_id,revision)
);
create table if not exists gp_refund_provider_binding (
  refund_id text primary key, order_id text not null,
  native_refund_id text, origin text not null check (origin in ('native','final_charge','provider_only')),
  bound_at timestamptz not null default now()
);
create table if not exists gp_refund_provider_metric (
  refund_id text primary key, event_id text not null unique, order_id text not null
);
create or replace function gp_refund_evidence_immutable() returns trigger as $$
begin raise exception 'Refund provider evidence is immutable'; end;
$$ language plpgsql;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_refund_provider_receipt'::regclass and tgname = 'gp_refund_receipt_immutable' and not tgisinternal) then
    create trigger gp_refund_receipt_immutable before update or delete on gp_refund_provider_receipt
for each row execute function gp_refund_evidence_immutable();
  end if;
end; $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_refund_provider_event'::regclass and tgname = 'gp_refund_event_immutable' and not tgisinternal) then
    create trigger gp_refund_event_immutable before update or delete on gp_refund_provider_event
for each row execute function gp_refund_evidence_immutable();
  end if;
end; $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_refund_provider_binding'::regclass and tgname = 'gp_refund_binding_immutable' and not tgisinternal) then
    create trigger gp_refund_binding_immutable before update or delete on gp_refund_provider_binding
for each row execute function gp_refund_evidence_immutable();
  end if;
end; $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_refund_provider_metric'::regclass and tgname = 'gp_refund_metric_immutable' and not tgisinternal) then
    create trigger gp_refund_metric_immutable before update or delete on gp_refund_provider_metric
for each row execute function gp_refund_evidence_immutable();
  end if;
end; $$;
create or replace function gp_refund_scope_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Refund scope is immutable'; end if;
  if row(OLD.account_id,OLD.livemode,OLD.starts_at) is distinct from row(NEW.account_id,NEW.livemode,NEW.starts_at)
  then raise exception 'Refund scope is immutable'; end if;
  return NEW;
end;
$$ language plpgsql;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_refund_provider_scope'::regclass and tgname = 'gp_refund_scope_immutable' and not tgisinternal) then
    create trigger gp_refund_scope_immutable before update or delete on gp_refund_provider_scope
for each row execute function gp_refund_scope_guard();
  end if;
end; $$;
${publicationCheckSql("kind", [
  "placed",
  "finalized",
  "canceled",
  "fulfillment_created",
  "shipped",
  "delivered",
  "return_requested",
  "refunded",
  "refund_updated",
])}
`;
