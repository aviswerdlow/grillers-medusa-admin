/** Source intent and independent delivery receipts. Never delete to retry. */
export const ORDER_PUBLICATION_SQL = `
create table if not exists gp_order_publication_epoch (
  id integer primary key check (id = 1), starts_at timestamptz not null
);
create table if not exists gp_order_publication (
  event_id text primary key,
  order_id text not null,
  kind text not null check (kind in ('placed', 'finalized')),
  source_id text,
  state text not null default 'waiting' check (state in ('waiting','ready','excluded')),
  actor_id text,
  properties jsonb,
  attempts integer not null default 0,
  reason text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (order_id, kind)
);
create table if not exists gp_order_publication_delivery (
  event_id text not null references gp_order_publication(event_id),
  target text not null check (target in ('jitsu','gp_analytics','communications','communications_automation')),
  status text not null default 'pending' check (status in ('pending','inflight','retry','held','excluded','accepted')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token text,
  lease_until timestamptz,
  reason text,
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (event_id,target)
);
create index if not exists gp_order_publication_pending on gp_order_publication(state,next_attempt_at);
create index if not exists gp_order_publication_delivery_due on gp_order_publication_delivery(status,next_attempt_at);
create table if not exists gp_order_publication_profile (
  order_id text primary key,
  event_id text not null unique references gp_order_publication(event_id),
  profile_id text not null,
  placement_total numeric not null check (placement_total >= 0),
  placed_at timestamptz not null
);
create or replace function gp_order_publication_frozen_v1() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Order publication evidence is retained'; end if;
  if OLD.state in ('ready','excluded') and NEW is distinct from OLD then
    raise exception 'Resolved order publication evidence is immutable';
  end if;
  if NEW.event_id <> OLD.event_id or NEW.order_id <> OLD.order_id or NEW.kind <> OLD.kind then
    raise exception 'Order publication identity is immutable';
  end if;
  return NEW;
end; $$ language plpgsql;
drop trigger if exists gp_order_publication_frozen on gp_order_publication;
create trigger gp_order_publication_frozen before update or delete on gp_order_publication
for each row execute function gp_order_publication_frozen_v1();
`;
