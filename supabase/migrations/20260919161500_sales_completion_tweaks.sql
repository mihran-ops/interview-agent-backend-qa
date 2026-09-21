-- Sales completion UX, notifications, prepaid-role visibility, and dated agreements.
-- New deadline fields are nullable so retail and already-issued agreements keep
-- their existing behavior. Browser roles remain denied.

alter table public.sales_reps
  add column if not exists slack_user_id text null;

alter table public.sales_reps
  drop constraint if exists sales_reps_slack_user_id_check;

alter table public.sales_reps
  add constraint sales_reps_slack_user_id_check
  check (slack_user_id is null or slack_user_id ~ '^[UW][A-Z0-9]{8,20}$');

alter table public.public_purchase_intents
  add column if not exists sales_rep_slack_enqueued_at timestamptz null;

alter table public.sales_deal_previews
  add column if not exists agreement_effective_date date null,
  add column if not exists agreement_renewal_date date null,
  add column if not exists agreement_expires_at timestamptz null;

alter table public.membership_agreements
  add column if not exists agreement_expires_at timestamptz null;

revoke all on table public.sales_reps from public, anon, authenticated;
grant select, update on table public.sales_reps to service_role;

create or replace function public.replace_sales_assisted_agreement(
  p_intent_id uuid,
  p_old_agreement_id uuid,
  p_new_agreement_id uuid,
  p_new_expires_at timestamptz,
  p_replaced_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent_updated integer := 0;
  v_agreement_updated integer := 0;
begin
  update public.public_purchase_intents
  set agreement_id = p_new_agreement_id,
      status = 'agreement_pending',
      expires_at = p_new_expires_at,
      stripe_checkout_session_id = null,
      term_start_basis = 'agreement_date',
      updated_at = p_replaced_at
  where id = p_intent_id
    and channel = 'sales_assisted'
    and agreement_id = p_old_agreement_id
    and status <> 'completed'
    and activated_at is null
    and activation_claimed_at is null;
  get diagnostics v_intent_updated = row_count;

  if v_intent_updated <> 1 then
    return false;
  end if;

  update public.membership_agreements
  set status = 'superseded',
      is_current = false,
      superseded_at = p_replaced_at,
      superseded_by_agreement_id = p_new_agreement_id,
      updated_at = p_replaced_at
  where id = p_old_agreement_id
    and status in ('sent', 'signed')
    and coalesce(checkout_status, '') <> 'paid';
  get diagnostics v_agreement_updated = row_count;

  if v_agreement_updated <> 1 then
    raise exception using errcode = 'P0001', message = 'sales_agreement_not_replaceable';
  end if;

  update public.membership_agreements
  set status = 'sent',
      sent_at = p_replaced_at,
      updated_at = p_replaced_at
  where id = p_new_agreement_id
    and status = 'draft';

  if not found then
    raise exception using errcode = 'P0001', message = 'sales_replacement_not_ready';
  end if;

  return true;
end;
$$;

revoke all on function public.replace_sales_assisted_agreement(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.replace_sales_assisted_agreement(uuid, uuid, uuid, timestamptz, timestamptz)
  to service_role;
