-- Interview credits for the rollover billing model.
--
-- When a Pro client closes a role, whatever allowance the role did not use is
-- minted as a credit the client can spend on any other role until it expires.
-- Draws are recorded one row per interview, so a retry cannot spend twice.
--
-- public.roles is not created by any migration in this repository, so the column
-- it gains here is added behind an existence check.

create extension if not exists pgcrypto;

create table if not exists public.interview_credits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  source_role_id uuid not null,
  quantity integer not null,
  remaining integer not null,
  minted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_credits_quantity_check check (quantity > 0),
  constraint interview_credits_remaining_check check (remaining >= 0)
);

-- A closed role mints at most one live credit, so a repeated close is a no-op
-- rather than a second grant. A revoked credit does not block a later mint.
create unique index if not exists interview_credits_source_role_uidx
  on public.interview_credits (source_role_id)
  where revoked_at is null;

create index if not exists interview_credits_client_expires_at_idx
  on public.interview_credits (client_id, expires_at);

create table if not exists public.interview_credit_draws (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references public.interview_credits(id) on delete cascade,
  client_id uuid not null,
  role_id uuid not null,
  interview_id uuid not null unique,
  quantity integer not null default 1,
  drawn_at timestamptz not null default now()
);

create index if not exists interview_credit_draws_role_id_idx
  on public.interview_credit_draws (role_id);

-- Counts draws taken against a role's credit that must be given back if the role
-- is reopened and its own allowance is restored.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'roles'
      and column_name = 'rollover_drawn_offset'
  ) then
    alter table public.roles
      add column rollover_drawn_offset integer not null default 0;
  end if;
end $$;

alter table public.interview_credits enable row level security;
alter table public.interview_credit_draws enable row level security;

revoke all privileges on table public.interview_credits
from public, anon, authenticated;

revoke all privileges on table public.interview_credit_draws
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.interview_credits,
  public.interview_credit_draws
to service_role;
