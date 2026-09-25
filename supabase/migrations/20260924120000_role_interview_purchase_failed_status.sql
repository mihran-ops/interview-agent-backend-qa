-- Allow 'failed' as a role interview purchase status.
--
-- The Stripe webhook has always written this status when a delayed-notification
-- payment fails (src/routes/webhooks/stripe.js, the async_payment_failed
-- branches), but the check constraint never permitted it. The update is
-- rejected, the error propagates, the webhook answers 500, and Stripe retries a
-- payment that has permanently failed for the whole of its backoff schedule.
--
-- Widening the constraint is safe: no existing row can violate a superset of the
-- values it already allowed.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'role_interview_purchases_status_check'
      and conrelid = 'public.role_interview_purchases'::regclass
  ) then
    alter table public.role_interview_purchases
      drop constraint role_interview_purchases_status_check;
  end if;

  alter table public.role_interview_purchases
    add constraint role_interview_purchases_status_check
    check (status in ('pending', 'paid', 'failed', 'voided', 'refunded'));
end $$;

-- Already in place from 20260803155651_public_api_emergency_containment.sql.
-- Repeated so this migration stands on its own; both statements are idempotent.
alter table public.role_interview_purchases enable row level security;

revoke all privileges on table public.role_interview_purchases
from public, anon, authenticated;

grant select, insert, update, delete on table public.role_interview_purchases
to service_role;
