-- The payroll table is private to browser roles and accessed only through the
-- authenticated admin backend using the Supabase service-role client.

grant select, insert on table public.sales_commission_adjustments to service_role;
