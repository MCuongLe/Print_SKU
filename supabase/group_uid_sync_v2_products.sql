-- Preserve every SKU inside a Group UID while keeping group_uid_details as one row per UID.
begin;

alter table public.group_uid_sync_staging
  add column if not exists products jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.group_uid_sync_staging
    add constraint group_uid_sync_staging_products_array check (jsonb_typeof(products)='array');
exception when duplicate_object then null;
end $$;

create table if not exists public.group_uid_products (
  group_uid_code text not null references public.group_uid_details(group_uid_code) on delete cascade,
  sku text not null check (btrim(sku) <> ''),
  qty numeric not null check (qty >= 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  product_name text,
  primary key (group_uid_code, sku)
);
create index if not exists group_uid_products_sku_idx on public.group_uid_products(sku);
comment on table public.group_uid_products is 'All SKU components reported by WMS for each Group UID.';

alter table public.group_uid_products enable row level security;
revoke all on public.group_uid_products from public, anon, authenticated;
grant select, insert, update, delete on public.group_uid_products to service_role;

create or replace function public.group_uid_sync_apply(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_sync_runs;
  v_mismatch integer;
  v_verified integer;
  v_total integer;
  v_result jsonb;
begin
  select * into v_run from public.group_uid_sync_runs where id=p_run_id for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status='completed' then
    return jsonb_build_object('runId',p_run_id,'status','completed','verification',v_run.verification,'alreadyCompleted',true);
  end if;
  if v_run.status<>'previewed' then raise exception 'RUN_NOT_PREVIEWED'; end if;
  if v_run.previewed_at is null or v_run.previewed_at < now()-interval '30 minutes' then raise exception 'PREVIEW_EXPIRED'; end if;
  update public.group_uid_sync_runs set status='applying',applied_at=now(),error_message=null where id=p_run_id;

  insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status)
  select group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status
    from public.group_uid_sync_staging where run_id=p_run_id
  on conflict(group_uid_code) do update set
    batch_code=excluded.batch_code,roll_code=excluded.roll_code,warehouse=excluded.warehouse,
    location=excluded.location,sku=excluded.sku,qty=excluded.qty,updated_by=excluded.updated_by,
    updated_date=excluded.updated_date,status=excluded.status
  where excluded.updated_date >= public.group_uid_details.updated_date;

  delete from public.group_uid_products p
   using public.group_uid_sync_staging s, public.group_uid_details g
   where s.run_id=p_run_id and p.group_uid_code=s.group_uid_code
     and g.group_uid_code=s.group_uid_code and s.updated_date>=g.updated_date;
  insert into public.group_uid_products(group_uid_code,sku,qty,product_name)
  select s.group_uid_code,x.sku,x.quantity,x.product_name
    from public.group_uid_sync_staging s
    join public.group_uid_details g using(group_uid_code)
    cross join lateral jsonb_to_recordset(s.products) as x(sku text,quantity numeric,product_name text)
   where s.run_id=p_run_id and s.updated_date>=g.updated_date
  on conflict(group_uid_code,sku) do update set qty=excluded.qty,product_name=excluded.product_name;

  select count(*) into v_mismatch
    from public.group_uid_sync_staging s left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and (g.group_uid_code is null or (s.updated_date>=g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from s.sku or g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or g.updated_date is distinct from s.updated_date or
      g.status is distinct from s.status or
      coalesce((select jsonb_agg(jsonb_build_object('sku',p.sku,'quantity',p.qty,'product_name',p.product_name) order by p.sku)
                  from public.group_uid_products p where p.group_uid_code=s.group_uid_code),'[]'::jsonb) is distinct from s.products)));
  if v_mismatch>0 then raise exception 'VERIFY_FAILED:%',v_mismatch; end if;
  select count(*) into v_total from public.group_uid_details;
  v_verified := v_run.source_count-coalesce((v_run.change_counts->>'issues')::integer,0);
  v_result := jsonb_build_object('verified',v_verified,'databaseCount',v_total,'errors',jsonb_build_array());

  insert into public.group_uid_sync_state(singleton,last_successful_incremental_at,last_successful_full_at,updated_at)
  values(true,v_run.range_to,case when v_run.mode='full' then now() end,now())
  on conflict(singleton) do update set
    last_successful_incremental_at=greatest(coalesce(public.group_uid_sync_state.last_successful_incremental_at,'-infinity'::timestamptz),excluded.last_successful_incremental_at),
    last_successful_full_at=case when v_run.mode='full' then excluded.last_successful_full_at else public.group_uid_sync_state.last_successful_full_at end,
    updated_at=now();
  update public.group_uid_sync_runs set status='completed',verification=v_result,completed_at=now(),error_message=null where id=p_run_id;
  delete from public.group_uid_sync_pages where run_id=p_run_id;
  delete from public.group_uid_sync_staging where run_id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'status','completed','changeCounts',v_run.change_counts,'verification',v_result);
end $$;

revoke all on function public.group_uid_sync_apply(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_apply(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
