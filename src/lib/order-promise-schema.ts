/** SQL-owned immutable evidence. No generated CRUD or historical backfill. */
export const ORDER_PROMISE_SQL = `
create table if not exists gp_order_promise_review (
  id text primary key,
  cart_id text not null,
  customer_id text not null,
  request_id text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  promise jsonb not null check (jsonb_typeof(promise) = 'object'),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  unique (cart_id, request_id),
  unique (id, cart_id, customer_id)
);
create table if not exists gp_order_promise_snapshot (
  id text primary key,
  cart_id text not null,
  customer_id text not null,
  review_id text not null,
  revision integer not null check (revision > 0),
  request_id text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  promise jsonb not null check (jsonb_typeof(promise) = 'object'),
  accepted_at timestamptz not null,
  unique (cart_id, revision),
  unique (cart_id, request_id),
  unique (review_id),
  unique (id, cart_id),
  foreign key (review_id, cart_id, customer_id) references gp_order_promise_review(id, cart_id, customer_id)
);
create table if not exists gp_order_promise_binding (
  order_id text primary key,
  cart_id text not null unique,
  snapshot_id text not null unique,
  workflow_id text not null check (workflow_id = 'complete-cart'),
  workflow_transaction_id text not null check (workflow_transaction_id = cart_id),
  workflow_run_id text not null,
  placed_at timestamptz not null,
  bound_at timestamptz not null default now(),
  foreign key (snapshot_id, cart_id) references gp_order_promise_snapshot(id, cart_id)
);
create or replace function gp_order_promise_immutable_v1() returns trigger as $$
begin
  raise exception 'Accepted-order evidence is immutable; append a verified correction instead';
end;
$$ language plpgsql;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_order_promise_review'::regclass and tgname = 'gp_order_promise_review_immutable' and not tgisinternal) then
    create trigger gp_order_promise_review_immutable before update or delete on gp_order_promise_review
  for each row execute function gp_order_promise_immutable_v1();
  end if;
end; $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_order_promise_snapshot'::regclass and tgname = 'gp_order_promise_snapshot_immutable' and not tgisinternal) then
    create trigger gp_order_promise_snapshot_immutable before update or delete on gp_order_promise_snapshot
  for each row execute function gp_order_promise_immutable_v1();
  end if;
end; $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'gp_order_promise_binding'::regclass and tgname = 'gp_order_promise_binding_immutable' and not tgisinternal) then
    create trigger gp_order_promise_binding_immutable before update or delete on gp_order_promise_binding
  for each row execute function gp_order_promise_immutable_v1();
  end if;
end; $$;
`;
