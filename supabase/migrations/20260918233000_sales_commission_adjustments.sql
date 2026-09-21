-- Admin-managed sales commission adjustments and private supporting documents.
-- Commission reports derive earned commission from completed sales-assisted
-- purchases; this table records later credits and deductions in the payroll
-- period when they occur.

create table if not exists public.sales_commission_adjustments (
  id uuid primary key default gen_random_uuid(),
  sales_rep_user_id uuid not null references public.sales_reps(user_id) on delete restrict,
  purchase_intent_id uuid references public.public_purchase_intents(id) on delete restrict,
  effective_at timestamptz not null,
  adjustment_type text not null,
  direction text not null,
  amount_cents bigint not null,
  reason text not null,
  documentation_storage_path text,
  documentation_filename text,
  documentation_content_type text,
  documentation_size_bytes bigint,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  constraint sales_commission_adjustments_type_check
    check (adjustment_type in ('cancellation', 'refund', 'chargeback', 'manual_adjustment')),
  constraint sales_commission_adjustments_direction_check
    check (direction in ('deduction', 'credit')),
  constraint sales_commission_adjustments_amount_check
    check (amount_cents > 0),
  constraint sales_commission_adjustments_reason_length
    check (char_length(reason) between 3 and 2000),
  constraint sales_commission_adjustments_document_size
    check (documentation_size_bytes is null or documentation_size_bytes between 1 and 10485760)
);

create index if not exists sales_commission_adjustments_period_idx
  on public.sales_commission_adjustments (effective_at desc);

create index if not exists sales_commission_adjustments_rep_period_idx
  on public.sales_commission_adjustments (sales_rep_user_id, effective_at desc);

create index if not exists sales_commission_adjustments_purchase_idx
  on public.sales_commission_adjustments (purchase_intent_id)
  where purchase_intent_id is not null;

alter table public.sales_commission_adjustments enable row level security;
revoke all on table public.sales_commission_adjustments from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sales-payroll-documents',
  'sales-payroll-documents',
  false,
  10485760,
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
