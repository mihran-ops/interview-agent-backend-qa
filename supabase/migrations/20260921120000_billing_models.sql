-- Billing models: fixed, rollover and usage.
--
--   fixed    - a per-role interview allowance that is lost when the role closes
--   rollover - unused allowance becomes client-wide credit for rollover_days
--   usage    - interviews beyond the included count are billed on the platform invoice
--
-- public.client_plan_settings is not created by any migration in this repository;
-- it exists only in the hosted database, so this file can only alter it. Every
-- statement below is guarded, so re-running the migration is a no-op.

do $$
declare
  billing_model_added boolean := false;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'billing_model'
  ) then
    alter table public.client_plan_settings
      add column billing_model text not null default 'fixed';
    billing_model_added := true;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'usage_interview_fee_cents'
  ) then
    alter table public.client_plan_settings
      add column usage_interview_fee_cents integer;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'rollover_days'
  ) then
    alter table public.client_plan_settings
      add column rollover_days integer not null default 90;
  end if;

  -- The backfill runs only on the migration that introduces the column, so a
  -- later re-run cannot overwrite a model an administrator has changed by hand.
  if billing_model_added then
    update public.client_plan_settings
    set billing_model = case lower(coalesce(plan_tier, ''))
      when 'pro' then 'rollover'
      when 'enterprise' then 'usage'
      else 'fixed'
    end;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_plan_settings_billing_model_check'
      and conrelid = 'public.client_plan_settings'::regclass
  ) then
    alter table public.client_plan_settings
      add constraint client_plan_settings_billing_model_check
      check (billing_model in ('fixed', 'rollover', 'usage'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'client_plan_settings_usage_interview_fee_cents_check'
      and conrelid = 'public.client_plan_settings'::regclass
  ) then
    alter table public.client_plan_settings
      add constraint client_plan_settings_usage_interview_fee_cents_check
      check (usage_interview_fee_cents is null or usage_interview_fee_cents >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'client_plan_settings_rollover_days_check'
      and conrelid = 'public.client_plan_settings'::regclass
  ) then
    alter table public.client_plan_settings
      add constraint client_plan_settings_rollover_days_check
      check (rollover_days > 0);
  end if;
end $$;

-- Row level security and the service-role grant are already in place from
-- 20260803155651_public_api_emergency_containment.sql. Both statements are
-- idempotent and are repeated here so this migration stands on its own.
alter table public.client_plan_settings enable row level security;

revoke all privileges on table public.client_plan_settings
from public, anon, authenticated;

grant select, insert, update, delete on table public.client_plan_settings
to service_role;
