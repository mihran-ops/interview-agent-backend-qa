-- Usage billing ledger for the Enterprise model.
--
-- One row per interview billed beyond a role's included count. The row is written
-- before the Stripe invoice item exists and stamped with billed_at once it does,
-- so a failure part-way through a cycle leaves rows that can be re-attached
-- rather than interviews that are billed twice or not at all.

create extension if not exists pgcrypto;

create table if not exists public.usage_billing_ledger (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  role_id uuid not null,
  interview_id uuid not null unique,
  unit_price_cents integer not null,
  stripe_invoice_id text null,
  stripe_invoice_item_id text null,
  period_start timestamptz null,
  period_end timestamptz null,
  billed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint usage_billing_ledger_unit_price_check check (unit_price_cents >= 0)
);

-- Unbilled work for a client, and every row attached to one invoice.
create index if not exists usage_billing_ledger_client_billed_at_idx
  on public.usage_billing_ledger (client_id, billed_at);

create index if not exists usage_billing_ledger_stripe_invoice_id_idx
  on public.usage_billing_ledger (stripe_invoice_id);

alter table public.usage_billing_ledger enable row level security;

revoke all privileges on table public.usage_billing_ledger
from public, anon, authenticated;

grant select, insert, update, delete on table public.usage_billing_ledger
to service_role;
