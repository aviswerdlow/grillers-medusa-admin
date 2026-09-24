/** SQL-owned order progress. Events and assignments are append-only evidence. */
export const LOCAL_MILESTONE_SQL = `
create table if not exists gp_local_milestone_state (
  order_id text primary key,
  fulfillment_id text not null,
  attempt_id text not null,
  mode text not null check (mode in ('pickup', 'local_delivery')),
  milestone text not null default 'packed',
  version integer not null default 0 check (version >= 0),
  current_event_id text,
  driver_customer_id text,
  updated_at timestamptz not null default now()
);
create table if not exists gp_local_milestone_event (
  event_id text primary key,
  order_id text not null references gp_local_milestone_state(order_id),
  fulfillment_id text not null,
  attempt_id text not null,
  version integer not null check (version > 0),
  kind text not null check (kind in ('record', 'correction')),
  previous_milestone text not null,
  milestone text not null,
  correction_of_event_id text references gp_local_milestone_event(event_id),
  actor_id text not null,
  actor_role text not null,
  reason text,
  note text,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (order_id, version),
  unique (order_id, event_id)
);
create index if not exists gp_local_milestone_event_attempt
  on gp_local_milestone_event(attempt_id, version);
create index if not exists gp_local_milestone_state_office_queue
  on gp_local_milestone_state(milestone, updated_at)
  where milestone in ('local_failed', 'local_returned');
create index if not exists gp_local_milestone_state_driver
  on gp_local_milestone_state(driver_customer_id, updated_at)
  where driver_customer_id is not null;
create table if not exists gp_local_milestone_assignment (
  assignment_id text primary key,
  order_id text not null references gp_local_milestone_state(order_id),
  fulfillment_id text not null,
  driver_customer_id text not null,
  assigned_by text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  assigned_at timestamptz not null default now(),
  replaces_assignment_id text references gp_local_milestone_assignment(assignment_id)
);
create index if not exists gp_local_milestone_assignment_order
  on gp_local_milestone_assignment(order_id, assigned_at);
create or replace function gp_local_milestone_immutable_v1() returns trigger as $$
begin
  raise exception 'Local milestone history is immutable; append a correction';
end;
$$ language plpgsql;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_local_milestone_event'::regclass and tgname = 'gp_local_milestone_event_immutable' and not tgisinternal) then
    create trigger gp_local_milestone_event_immutable before update or delete on gp_local_milestone_event
      for each row execute function gp_local_milestone_immutable_v1();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_local_milestone_assignment'::regclass and tgname = 'gp_local_milestone_assignment_immutable' and not tgisinternal) then
    create trigger gp_local_milestone_assignment_immutable before update or delete on gp_local_milestone_assignment
      for each row execute function gp_local_milestone_immutable_v1();
  end if;
end; $$;
`
