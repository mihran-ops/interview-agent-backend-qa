-- Idempotency keys for admin billing actions that move money.
--
-- Mirrors public.sales_idempotency_keys: the same header contract, the same
-- fingerprint check, the same stored replay. A separate table because the sales
-- one is scoped to sales representatives, and these callers are administrators.

create table if not exists public.billing_idempotency_keys (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  route_key text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (actor_user_id, route_key, idempotency_key),
  constraint billing_idempotency_status_check
    check (response_status is null or response_status between 200 and 599)
);

create index if not exists billing_idempotency_expiry_idx
  on public.billing_idempotency_keys (expires_at);

alter table public.billing_idempotency_keys enable row level security;

revoke all privileges on table public.billing_idempotency_keys
from public, anon, authenticated;

grant select, insert, update, delete on table public.billing_idempotency_keys
to service_role;
