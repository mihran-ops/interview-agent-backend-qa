-- Durable, service-role-only outbox for sales integration side effects.
-- Payment activation only enqueues an event. A bounded worker claims rows with
-- SKIP LOCKED so Slack or CRM availability never controls customer activation.

alter table public.public_purchase_intents
  add column if not exists sales_won_enqueued_at timestamptz;

create table if not exists public.sales_integration_deliveries (
  id uuid primary key default gen_random_uuid(),
  integration text not null,
  event_type text not null,
  event_key text not null,
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  delivered_at timestamptz,
  external_message_id text,
  external_channel_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_integration_deliveries_integration_check
    check (integration in ('slack', 'ghl')),
  constraint sales_integration_deliveries_event_type_length
    check (char_length(event_type) between 1 and 80),
  constraint sales_integration_deliveries_event_key_length
    check (char_length(event_key) between 1 and 240),
  constraint sales_integration_deliveries_status_check
    check (status in ('pending', 'processing', 'retry', 'delivered', 'failed')),
  constraint sales_integration_deliveries_attempt_count_check
    check (attempt_count >= 0 and max_attempts between 1 and 25)
);

create unique index if not exists sales_integration_deliveries_event_uidx
  on public.sales_integration_deliveries (integration, event_type, event_key);

create index if not exists sales_integration_deliveries_due_idx
  on public.sales_integration_deliveries (next_attempt_at, created_at)
  where status in ('pending', 'retry');

create index if not exists sales_integration_deliveries_intent_idx
  on public.sales_integration_deliveries (purchase_intent_id, created_at desc);

alter table public.sales_integration_deliveries enable row level security;
revoke all on table public.sales_integration_deliveries from anon, authenticated;
grant select, insert, update on table public.sales_integration_deliveries to service_role;

create or replace function public.claim_sales_integration_deliveries(
  p_limit integer default 10,
  p_lock_token uuid default gen_random_uuid(),
  p_now timestamptz default now(),
  p_integration text default null
)
returns setof public.sales_integration_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.sales_integration_deliveries as exhausted
  set status = 'failed',
      locked_at = null,
      lock_token = null,
      last_error = coalesce(exhausted.last_error, 'delivery_worker_interrupted'),
      updated_at = p_now
  where exhausted.status = 'processing'
    and exhausted.locked_at < p_now - interval '10 minutes'
    and exhausted.attempt_count >= exhausted.max_attempts
    and (p_integration is null or exhausted.integration = p_integration);

  return query
  with candidates as (
    select delivery.id
    from public.sales_integration_deliveries as delivery
    where (p_integration is null or delivery.integration = p_integration)
    and ((
      delivery.status in ('pending', 'retry')
      and delivery.next_attempt_at <= p_now
      and delivery.attempt_count < delivery.max_attempts
    ) or (
      delivery.status = 'processing'
      and delivery.locked_at < p_now - interval '10 minutes'
      and delivery.attempt_count < delivery.max_attempts
    ))
    order by delivery.next_attempt_at asc, delivery.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.sales_integration_deliveries as delivery
  set status = 'processing',
      attempt_count = delivery.attempt_count + 1,
      locked_at = p_now,
      lock_token = p_lock_token,
      updated_at = p_now
  from candidates
  where delivery.id = candidates.id
  returning delivery.*;
end;
$$;

revoke all on function public.claim_sales_integration_deliveries(integer, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_sales_integration_deliveries(integer, uuid, timestamptz, text) to service_role;
