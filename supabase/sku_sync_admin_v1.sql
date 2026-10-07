-- Admin SKU/Combo synchronization audit store. Inside data is collected by the
-- Chrome extension; only the sku-sync Edge Function may read or write this table.
begin;

create table if not exists public.sku_sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'previewed'
    check (status in ('previewed','applying','completed','failed')),
  source text not null default 'inside-extension'
    check (source = 'inside-extension'),
  cutoff text not null,
  source_generated_at timestamptz not null,
  source_counts jsonb not null default '{}'::jsonb,
  change_counts jsonb not null default '{}'::jsonb,
  changes jsonb not null default '{}'::jsonb,
  staged_skus jsonb not null default '[]'::jsonb,
  staged_combo_links jsonb not null default '[]'::jsonb,
  verification jsonb not null default '{}'::jsonb,
  error_message text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  completed_at timestamptz,
  check (jsonb_typeof(source_counts) = 'object'),
  check (jsonb_typeof(change_counts) = 'object'),
  check (jsonb_typeof(changes) = 'object'),
  check (jsonb_typeof(staged_skus) = 'array'),
  check (jsonb_typeof(staged_combo_links) = 'array'),
  check (jsonb_array_length(staged_skus) <= 2000),
  check (jsonb_array_length(staged_combo_links) <= 2000)
);

create index if not exists sku_sync_runs_created_idx
  on public.sku_sync_runs (created_at desc);
create index if not exists sku_sync_runs_status_idx
  on public.sku_sync_runs (status, created_at desc);

alter table public.sku_sync_runs enable row level security;
revoke all on public.sku_sync_runs from public, anon, authenticated;
grant select, insert, update, delete on public.sku_sync_runs to service_role;

comment on table public.sku_sync_runs is
  'Admin audit log and staged changes for Inside SKU/Combo synchronization through the sku-sync Edge Function.';
comment on column public.sku_sync_runs.staged_skus is
  'Only changed SKU rows awaiting an explicit Admin apply action; never a full source dump.';
comment on column public.sku_sync_runs.staged_combo_links is
  'Only changed Combo-Normal links awaiting an explicit Admin apply action; source absence never deletes a link.';

commit;
