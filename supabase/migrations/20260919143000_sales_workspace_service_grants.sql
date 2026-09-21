-- The QA project hardens default table privileges, so RLS bypass alone does
-- not authorize PostgREST's service_role to use newly created sales tables.
-- Browser roles remain denied; grant only the operations used by Express.

revoke all on table public.sales_reps from public, anon, authenticated;
revoke all on table public.sales_deal_previews from public, anon, authenticated;
revoke all on table public.sales_deal_events from public, anon, authenticated;
revoke all on table public.sales_enterprise_handoffs from public, anon, authenticated;
revoke all on table public.sales_idempotency_keys from public, anon, authenticated;

grant select on table public.sales_reps to service_role;
grant select, insert, update on table public.sales_deal_previews to service_role;
grant select, insert on table public.sales_deal_events to service_role;
grant select, insert on table public.sales_enterprise_handoffs to service_role;
grant select, insert, update, delete on table public.sales_idempotency_keys to service_role;
