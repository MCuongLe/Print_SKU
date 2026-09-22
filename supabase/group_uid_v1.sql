-- Group UID detail snapshot from WMS. Apply to the existing Print SKU project.
begin;
create table public.group_uid_details (
  group_uid_code text primary key check (btrim(group_uid_code) <> ''),
  batch_code text,
  roll_code text,
  warehouse text,
  location text,
  product text,
  sku text,
  qty numeric not null check (qty >= 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  updated_by text,
  updated_date timestamptz not null,
  status text not null check (btrim(status) <> '')
);
comment on table public.group_uid_details is 'WMS snapshot: one row per Group UID. Blank SKU/product is allowed. Source dates use UTC+07:00.';
comment on column public.group_uid_details.product is 'Product Name from the WMS export, retained even when SKU is not in SKU_Name.';
comment on column public.group_uid_details.qty is 'Qty from WMS, in the source SKU unit; not necessarily a piece count.';
comment on column public.group_uid_details.updated_by is 'Updated By from WMS, not a Supabase Auth user ID.';
comment on column public.group_uid_details.updated_date is 'Updated Date from WMS, not the import time.';
create index group_uid_details_sku_idx on public.group_uid_details (sku);
create index group_uid_details_location_idx on public.group_uid_details (warehouse, location);
create index group_uid_details_status_idx on public.group_uid_details (status);
alter table public.group_uid_details enable row level security;
revoke all on public.group_uid_details from public, anon, authenticated;
grant select, insert, update on public.group_uid_details to service_role;
commit;
