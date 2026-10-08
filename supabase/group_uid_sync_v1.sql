-- Incremental + full Group UID synchronization, driven by the read-only Chrome connector.
-- Source access tokens never enter Supabase; only normalized Group UID rows are staged here.
begin;

create table if not exists public.group_uid_sync_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('incremental','full')),
  status text not null check (status in ('running','previewed','applying','completed','failed','expired')),
  range_from timestamptz,
  range_to timestamptz not null,
  expected_pages integer check (expected_pages is null or expected_pages > 0),
  page_count integer not null default 0 check (page_count >= 0),
  source_count integer not null default 0 check (source_count >= 0),
  valid_count integer not null default 0 check (valid_count >= 0),
  change_counts jsonb not null default '{}'::jsonb,
  verification jsonb not null default '{}'::jsonb,
  error_message text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  previewed_at timestamptz,
  applied_at timestamptz,
  completed_at timestamptz
);

create unique index if not exists group_uid_sync_one_active_idx
  on public.group_uid_sync_runs ((1))
  where status in ('running','previewed','applying');
create index if not exists group_uid_sync_runs_created_idx on public.group_uid_sync_runs (created_at desc);

create table if not exists public.group_uid_sync_pages (
  run_id uuid not null references public.group_uid_sync_runs(id) on delete cascade,
  page_no integer not null check (page_no > 0),
  row_count integer not null check (row_count >= 0 and row_count <= 500),
  received_at timestamptz not null default now(),
  primary key (run_id, page_no)
);

create table if not exists public.group_uid_sync_staging (
  run_id uuid not null references public.group_uid_sync_runs(id) on delete cascade,
  group_uid_code text not null check (btrim(group_uid_code) <> ''),
  batch_code text,
  roll_code text,
  warehouse text,
  location text,
  sku text,
  qty numeric not null check (qty >= 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  updated_by text,
  updated_date timestamptz not null,
  status text not null check (btrim(status) <> ''),
  products jsonb not null default '[]'::jsonb check (jsonb_typeof(products)='array'),
  primary key (run_id, group_uid_code)
);
create index if not exists group_uid_sync_staging_updated_idx on public.group_uid_sync_staging (run_id, updated_date);

create table if not exists public.group_uid_sync_changes (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.group_uid_sync_runs(id) on delete cascade,
  group_uid_code text not null,
  change_type text not null check (change_type in ('added','updated','missing','stale_source','verification_failed')),
  before_data jsonb,
  after_data jsonb,
  changed_fields text[] not null default '{}'::text[],
  source_updated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists group_uid_sync_changes_run_type_idx on public.group_uid_sync_changes (run_id, change_type, id);

create table if not exists public.group_uid_sync_state (
  singleton boolean primary key default true check (singleton),
  last_successful_incremental_at timestamptz,
  last_successful_full_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.group_uid_sync_state(singleton) values (true) on conflict (singleton) do nothing;

create table if not exists public.group_uid_products (
  group_uid_code text not null references public.group_uid_details(group_uid_code) on delete cascade,
  sku text not null check (btrim(sku) <> ''),
  qty numeric not null check (qty >= 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  product_name text,
  primary key (group_uid_code, sku)
);
create index if not exists group_uid_products_sku_idx on public.group_uid_products(sku);

alter table public.group_uid_sync_runs enable row level security;
alter table public.group_uid_sync_pages enable row level security;
alter table public.group_uid_sync_staging enable row level security;
alter table public.group_uid_sync_changes enable row level security;
alter table public.group_uid_sync_state enable row level security;
alter table public.group_uid_products enable row level security;

revoke all on public.group_uid_sync_runs, public.group_uid_sync_pages, public.group_uid_sync_staging,
  public.group_uid_sync_changes, public.group_uid_sync_state from public, anon, authenticated;
revoke all on public.group_uid_products from public, anon, authenticated;
grant select, insert, update, delete on public.group_uid_sync_runs, public.group_uid_sync_pages,
  public.group_uid_sync_staging, public.group_uid_sync_changes, public.group_uid_sync_state to service_role;
grant select, insert, update, delete on public.group_uid_products to service_role;
grant usage, select on sequence public.group_uid_sync_changes_id_seq to service_role;

create or replace function public.group_uid_sync_prepare(p_mode text, p_range_to timestamptz, p_created_by uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from timestamptz;
  v_run public.group_uid_sync_runs;
begin
  if p_mode not in ('incremental','full') or p_range_to is null or p_created_by is null then
    raise exception 'INVALID_PREPARE';
  end if;
  update public.group_uid_sync_runs
     set status='expired', completed_at=now(), error_message='Bản xem trước hết hạn sau 30 phút'
   where (status='previewed' and previewed_at < now() - interval '30 minutes')
      or (status='running' and created_at < now() - interval '30 minutes');
  delete from public.group_uid_sync_pages p using public.group_uid_sync_runs r
   where p.run_id=r.id and r.status in ('completed','failed','expired') and r.created_at<now()-interval '7 days';
  delete from public.group_uid_sync_staging s using public.group_uid_sync_runs r
   where s.run_id=r.id and r.status in ('completed','failed','expired') and r.created_at<now()-interval '7 days';
  if exists(select 1 from public.group_uid_sync_runs where status in ('running','previewed','applying')) then
    raise exception 'ACTIVE_RUN';
  end if;
  select last_successful_incremental_at - interval '30 minutes'
    into v_from from public.group_uid_sync_state where singleton=true;
  if p_mode='incremental' and v_from is null then raise exception 'FULL_REQUIRED'; end if;
  insert into public.group_uid_sync_runs(mode,status,range_from,range_to,created_by)
  values(p_mode,'running',case when p_mode='incremental' then v_from end,p_range_to,p_created_by)
  returning * into v_run;
  return jsonb_build_object('runId',v_run.id,'mode',v_run.mode,'status',v_run.status,
    'rangeFrom',v_run.range_from,'rangeTo',v_run.range_to);
end $$;

create or replace function public.group_uid_sync_preview(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_sync_runs;
  v_pages integer;
  v_source integer;
  v_added integer;
  v_updated integer;
  v_missing integer;
  v_stale integer;
  v_unchanged integer;
  v_previous_full integer;
  v_drop numeric := 0;
  v_counts jsonb;
begin
  select * into v_run from public.group_uid_sync_runs where id=p_run_id for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status <> 'running' then raise exception 'RUN_NOT_RUNNING'; end if;
  select count(*) into v_pages from public.group_uid_sync_pages where run_id=p_run_id;
  if v_run.expected_pages is null or v_pages <> v_run.expected_pages or
     exists(select 1 from generate_series(1,v_run.expected_pages) p where not exists(
       select 1 from public.group_uid_sync_pages x where x.run_id=p_run_id and x.page_no=p)) then
    raise exception 'PAGES_INCOMPLETE';
  end if;
  select count(*) into v_source from public.group_uid_sync_staging where run_id=p_run_id;
  if v_source <> v_run.source_count then raise exception 'SOURCE_COUNT_MISMATCH'; end if;
  if v_run.mode='full' and v_source<1000 then raise exception 'FULL_SOURCE_TOO_SMALL'; end if;

  delete from public.group_uid_sync_changes where run_id=p_run_id;
  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'added',null,to_jsonb(s)-'run_id',
         array['group_uid_code'],s.updated_date
    from public.group_uid_sync_staging s
    left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and g.group_uid_code is null;

  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'updated',to_jsonb(g),to_jsonb(s)-'run_id',
    array_remove(array[
      case when g.batch_code is distinct from s.batch_code then 'batch_code' end,
      case when g.roll_code is distinct from s.roll_code then 'roll_code' end,
      case when g.warehouse is distinct from s.warehouse then 'warehouse' end,
      case when g.location is distinct from s.location then 'location' end,
      case when g.sku is distinct from s.sku then 'sku' end,
      case when g.qty is distinct from s.qty then 'qty' end,
      case when g.updated_by is distinct from s.updated_by then 'updated_by' end,
      case when g.updated_date is distinct from s.updated_date then 'updated_date' end,
      case when g.status is distinct from s.status then 'status' end
    ],null),s.updated_date
    from public.group_uid_sync_staging s join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and s.updated_date >= g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from s.sku or g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or g.updated_date is distinct from s.updated_date or
      g.status is distinct from s.status);

  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'stale_source',to_jsonb(g),to_jsonb(s)-'run_id',array['updated_date'],s.updated_date
    from public.group_uid_sync_staging s join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and s.updated_date < g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from s.sku or g.qty is distinct from s.qty or g.status is distinct from s.status);

  if v_run.mode='full' then
    insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields)
    select p_run_id,g.group_uid_code,'missing',to_jsonb(g),null,array['group_uid_code']
      from public.group_uid_details g
     where not exists(select 1 from public.group_uid_sync_staging s where s.run_id=p_run_id and s.group_uid_code=g.group_uid_code);
  end if;

  select count(*) filter(where change_type='added'),count(*) filter(where change_type='updated'),
         count(*) filter(where change_type='missing'),count(*) filter(where change_type='stale_source')
    into v_added,v_updated,v_missing,v_stale
    from public.group_uid_sync_changes where run_id=p_run_id;
  v_unchanged := greatest(v_source-v_added-v_updated-v_stale,0);
  if v_run.mode='full' then
    select source_count into v_previous_full from public.group_uid_sync_runs
     where mode='full' and status='completed' and id<>p_run_id order by completed_at desc limit 1;
    if coalesce(v_previous_full,0)>0 and v_source<v_previous_full then
      v_drop := round((v_previous_full-v_source)::numeric*100/v_previous_full,2);
    end if;
  end if;
  v_counts := jsonb_build_object('added',v_added,'updated',v_updated,'unchanged',v_unchanged,
    'missing',v_missing,'issues',v_stale,'totalChanges',v_added+v_updated);
  update public.group_uid_sync_runs set status='previewed',page_count=v_pages,source_count=v_source,
    valid_count=v_source,change_counts=v_counts,
    verification=jsonb_build_object('previousFullCount',v_previous_full,'fullDropPercent',v_drop),previewed_at=now()
   where id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'status','previewed','mode',v_run.mode,
    'rangeFrom',v_run.range_from,'rangeTo',v_run.range_to,'pageCount',v_pages,
    'sourceCount',v_source,'changeCounts',v_counts,
    'verification',jsonb_build_object('previousFullCount',v_previous_full,'fullDropPercent',v_drop));
end $$;

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

revoke all on function public.group_uid_sync_prepare(text,timestamptz,uuid) from public, anon, authenticated;
revoke all on function public.group_uid_sync_preview(uuid) from public, anon, authenticated;
revoke all on function public.group_uid_sync_apply(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_prepare(text,timestamptz,uuid) to service_role;
grant execute on function public.group_uid_sync_preview(uuid) to service_role;
grant execute on function public.group_uid_sync_apply(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
