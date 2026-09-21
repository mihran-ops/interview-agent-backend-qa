-- alphaScreen sales workspace
-- All tables are service-role only. Browser callers use authenticated Express
-- routes, which validate the JWT and enforce active-representative ownership.

create table if not exists public.sales_reps (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_reps_email_length check (char_length(email) between 3 and 254),
  constraint sales_reps_display_name_length check (char_length(display_name) between 1 and 120)
);

alter table public.public_purchase_intents
  add column if not exists channel text not null default 'retail',
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists created_by_email text,
  add column if not exists ghl_contact_id text,
  add column if not exists ghl_opportunity_id text,
  add column if not exists sales_note text,
  add column if not exists candidate_assistance_name text,
  add column if not exists candidate_assistance_email text,
  add column if not exists promotion_code_id text,
  add column if not exists promotion_code text,
  add column if not exists promotion_label text,
  add column if not exists promotion_amount_off_cents bigint,
  add column if not exists promotion_percent_off numeric(7,4),
  add column if not exists promotion_discount_cents bigint not null default 0,
  add column if not exists platform_fee_cents bigint,
  add column if not exists initial_payment_cents bigint,
  add column if not exists term_start_basis text not null default 'agreement_date',
  add column if not exists activated_at timestamptz,
  add column if not exists canceled_at timestamptz,
  add column if not exists activation_claimed_at timestamptz,
  add column if not exists activation_claim_key text;

-- Sales-assisted agreements intentionally leave these dates unset until the
-- successful payment timestamp establishes the membership term.
alter table public.membership_agreements
  alter column initial_term_start drop not null,
  alter column initial_renewal_date drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'public_purchase_intents_channel_check'
      and conrelid = 'public.public_purchase_intents'::regclass
  ) then
    alter table public.public_purchase_intents
      add constraint public_purchase_intents_channel_check
      check (channel in ('retail', 'sales_assisted'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'public_purchase_intents_term_start_basis_check'
      and conrelid = 'public.public_purchase_intents'::regclass
  ) then
    alter table public.public_purchase_intents
      add constraint public_purchase_intents_term_start_basis_check
      check (term_start_basis in ('agreement_date', 'successful_payment'));
  end if;
end $$;

create index if not exists public_purchase_intents_sales_owner_idx
  on public.public_purchase_intents (created_by_user_id, created_at desc)
  where channel = 'sales_assisted';

create index if not exists public_purchase_intents_ghl_opportunity_idx
  on public.public_purchase_intents (ghl_opportunity_id)
  where ghl_opportunity_id is not null;

create unique index if not exists public_purchase_intents_active_sales_buyer_uidx
  on public.public_purchase_intents (lower(buyer_email))
  where channel = 'sales_assisted' and status not in ('canceled', 'expired');

create table if not exists public.sales_deal_previews (
  id uuid primary key default gen_random_uuid(),
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  normalized_draft jsonb not null,
  package_snapshot jsonb not null,
  pricing_snapshot jsonb not null,
  draft_fingerprint text not null,
  preview_pdf_path text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sales_deal_previews_fingerprint_length check (char_length(draft_fingerprint) = 64)
);

create index if not exists sales_deal_previews_owner_created_idx
  on public.sales_deal_previews (created_by_user_id, created_at desc);

alter table public.public_purchase_intents
  add column if not exists sales_preview_id uuid references public.sales_deal_previews(id) on delete restrict;

create unique index if not exists public_purchase_intents_sales_preview_uidx
  on public.public_purchase_intents (sales_preview_id)
  where sales_preview_id is not null;

create table if not exists public.sales_deal_events (
  id uuid primary key default gen_random_uuid(),
  purchase_intent_id uuid not null references public.public_purchase_intents(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint sales_deal_events_type_length check (char_length(event_type) between 1 and 80)
);

create index if not exists sales_deal_events_intent_created_idx
  on public.sales_deal_events (purchase_intent_id, created_at asc);

create table if not exists public.sales_enterprise_handoffs (
  id uuid primary key default gen_random_uuid(),
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  created_by_email text not null,
  company_name text not null,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  estimated_monthly_interviews text,
  locations text,
  desired_timeline text,
  requirements text,
  notes text,
  ghl_contact_id text,
  ghl_opportunity_id text,
  delivery_status text not null default 'pending',
  delivery_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sales_enterprise_handoffs_delivery_check
    check (delivery_status in ('pending', 'delivered', 'failed'))
);

create index if not exists sales_enterprise_handoffs_owner_created_idx
  on public.sales_enterprise_handoffs (created_by_user_id, created_at desc);

create table if not exists public.sales_idempotency_keys (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  route_key text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (actor_user_id, route_key, idempotency_key),
  constraint sales_idempotency_status_check
    check (response_status is null or response_status between 200 and 599)
);

create index if not exists sales_idempotency_expiry_idx
  on public.sales_idempotency_keys (expires_at);

alter table public.sales_reps enable row level security;
alter table public.sales_deal_previews enable row level security;
alter table public.sales_deal_events enable row level security;
alter table public.sales_enterprise_handoffs enable row level security;
alter table public.sales_idempotency_keys enable row level security;

revoke all on table public.sales_reps from anon, authenticated;
revoke all on table public.sales_deal_previews from anon, authenticated;
revoke all on table public.sales_deal_events from anon, authenticated;
revoke all on table public.sales_enterprise_handoffs from anon, authenticated;
revoke all on table public.sales_idempotency_keys from anon, authenticated;
