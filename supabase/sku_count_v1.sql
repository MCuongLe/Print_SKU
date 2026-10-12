-- Man KIEM KE SKU tren trang chu (12/10/2026): moi nhan vien kho xem duoc ban chup gan nhat, chi Admin dong bo tu WMS.
--
-- Truoc day man #admin/kiem-ke chi doc truc tiep WMS qua Extension va khong luu gi. Nay Admin bam "Doc va dong bo" thi web doc WMS
-- (Extension), doi chieu kiem ke ngay tren trinh duyet roi luu KET QUA GOP THEO (kho, SKU) len day; nguoi xem chi doc ban luu,
-- phan nhom (chua kiem ke / qua 30 ngay / trong 30 ngay) duoc tinh luc xem theo gio hien tai nen moc 30 ngay luon dung.
--
-- Mo hinh giong Lich su Group UID: bang chi cap cho service_role, doc qua ham chi-doc cap cho anon (sku_count_overview),
-- ghi qua ham kiem group_uid_admin_allowed() chi cap cho authenticated (sku_count_save_start / _chunk / _finish).
--
-- Moi lan dong bo la mot "luot": start -> chunk (<= 1.000 dong/lan) -> finish. Dong cua luot chi hien ra khi finish chuyen luot sang
-- 'completed', nen nguoi xem khong bao gio thay du lieu do dang. Giu 3 luot hoan tat gan nhat, luot hong/bo do bi don.
--
-- Chi them bang va ham moi, khong drop gi: khong can --allow-destructive.
-- Chay migration TRUOC khi cap nhat index.html.
begin;

create table if not exists public.sku_count_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running','completed','failed')),
  warehouses jsonb not null default '[]'::jsonb,
  missing text[] not null default '{}',
  source_counts jsonb not null default '{}'::jsonb,
  threshold_days integer not null default 30 check (threshold_days between 1 and 365),
  row_count integer not null default 0 check (row_count >= 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);
create index if not exists sku_count_runs_done_idx on public.sku_count_runs (completed_at desc) where status = 'completed';

create table if not exists public.sku_count_rows (
  run_id uuid not null references public.sku_count_runs(id) on delete cascade,
  warehouse_id integer not null,
  warehouse_name text not null check (btrim(warehouse_name) <> ''),
  sku text not null check (length(btrim(sku)) between 1 and 80),
  product_name text,
  qty numeric not null check (qty > 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  uom text,
  locations jsonb not null default '[]'::jsonb check (jsonb_typeof(locations) = 'array'),
  last_approved_at timestamptz,
  last_approved_by text,
  primary key (run_id, warehouse_id, sku)
);

alter table public.sku_count_runs enable row level security;
alter table public.sku_count_rows enable row level security;
revoke all on public.sku_count_runs from public, anon, authenticated;
revoke all on public.sku_count_rows from public, anon, authenticated;
grant select, insert, update, delete on public.sku_count_runs to service_role;
grant select, insert, update, delete on public.sku_count_rows to service_role;

-- Admin mo mot luot dong bo. p_warehouses = [{warehouseId, warehouseName, companyName}] cac kho doc duoc;
-- p_missing = ten kho yeu cau nhung khong doc duoc (thieu quyen) de nguoi xem thay canh bao ket qua mot phan.
create or replace function public.sku_count_save_start(p_warehouses jsonb, p_missing text[], p_source_counts jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đồng bộ kiểm kê'));
  end if;
  if p_warehouses is null or jsonb_typeof(p_warehouses) <> 'array' or jsonb_array_length(p_warehouses) not between 1 and 10 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Danh sách kho đã đọc không hợp lệ'));
  end if;
  update public.sku_count_runs set status = 'failed', error_message = 'Lượt đồng bộ bỏ dở', completed_at = now()
   where status = 'running' and created_at < now() - interval '1 hour';
  insert into public.sku_count_runs(warehouses, missing, source_counts, created_by)
  values (p_warehouses, coalesce(p_missing, '{}'), coalesce(p_source_counts, '{}'::jsonb), (select auth.uid()))
  returning id into v_id;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('runId',v_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Admin ghi mot dot dong (toi da 1.000). Dong chi hien voi nguoi xem sau khi finish.
create or replace function public.sku_count_save_chunk(p_run_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bad integer; v_saved integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đồng bộ kiểm kê'));
  end if;
  if not exists (select 1 from public.sku_count_runs where id = p_run_id and status = 'running') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','RUN_NOT_RUNNING','message','Lượt đồng bộ không còn mở'));
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 1000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần ghi từ 1 đến 1.000 dòng'));
  end if;
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as x(warehouse_id integer, warehouse_name text, sku text, product_name text, qty numeric, uom text, locations jsonb, last_approved_at timestamptz, last_approved_by text)
   where warehouse_id is null or nullif(btrim(warehouse_name),'') is null or nullif(btrim(sku),'') is null or length(btrim(sku)) > 80
      or qty is null or qty <= 0 or locations is null or jsonb_typeof(locations) <> 'array';
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng kiểm kê thiếu hoặc sai dữ liệu'));
  end if;
  with src as (
    select distinct on (warehouse_id, btrim(sku)) warehouse_id, btrim(warehouse_name) as warehouse_name, btrim(sku) as sku,
           nullif(btrim(product_name),'') as product_name, qty, nullif(btrim(uom),'') as uom, locations,
           last_approved_at, nullif(btrim(last_approved_by),'') as last_approved_by
      from jsonb_to_recordset(p_rows) as x(warehouse_id integer, warehouse_name text, sku text, product_name text, qty numeric, uom text, locations jsonb, last_approved_at timestamptz, last_approved_by text)
     order by warehouse_id, btrim(sku)
  ), written as (
    insert into public.sku_count_rows(run_id, warehouse_id, warehouse_name, sku, product_name, qty, uom, locations, last_approved_at, last_approved_by)
    select p_run_id, warehouse_id, warehouse_name, sku, product_name, qty, uom, locations, last_approved_at, last_approved_by from src
    on conflict (run_id, warehouse_id, sku) do update
      set warehouse_name = excluded.warehouse_name, product_name = excluded.product_name, qty = excluded.qty, uom = excluded.uom,
          locations = excluded.locations, last_approved_at = excluded.last_approved_at, last_approved_by = excluded.last_approved_by
    returning 1
  )
  select count(*) into v_saved from written;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('saved',v_saved),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Admin chot luot: tu day nguoi xem thay du lieu moi (completed_at dung clock_timestamp de cac luot sat nhau van co thu tu ro rang). Luot rong bi tu choi de khong thay ban chup cu bang ban chup trong.
create or replace function public.sku_count_save_finish(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đồng bộ kiểm kê'));
  end if;
  if not exists (select 1 from public.sku_count_runs where id = p_run_id and status = 'running') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','RUN_NOT_RUNNING','message','Lượt đồng bộ không còn mở'));
  end if;
  select count(*) into v_count from public.sku_count_rows where run_id = p_run_id;
  if v_count = 0 then
    update public.sku_count_runs set status = 'failed', error_message = 'Lượt đồng bộ không có dòng nào', completed_at = clock_timestamp() where id = p_run_id;
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','EMPTY_RUN','message','Không có dòng kiểm kê nào để lưu; giữ nguyên bản chụp cũ'));
  end if;
  update public.sku_count_runs set status = 'completed', row_count = v_count, completed_at = clock_timestamp() where id = p_run_id;
  delete from public.sku_count_runs
   where id <> p_run_id
     and (status = 'failed'
          or (status = 'completed' and id not in (select id from public.sku_count_runs where status = 'completed' order by completed_at desc, id desc limit 3)));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('runId',p_run_id,'rowCount',v_count),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Moi nguoi xem: ban chup hoan tat gan nhat (chi doc, cap cho anon nhu Tra cuu UID).
create or replace function public.sku_count_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.sku_count_runs;
begin
  select * into v_run from public.sku_count_runs where status = 'completed' order by completed_at desc, id desc limit 1;
  if not found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('run',null,'rows','[]'::jsonb),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'run', jsonb_build_object('id',v_run.id,'readAt',v_run.completed_at,'warehouses',v_run.warehouses,'missing',to_jsonb(v_run.missing),
                              'sourceCounts',v_run.source_counts,'thresholdDays',v_run.threshold_days,'rowCount',v_run.row_count),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('warehouseId',r.warehouse_id,'warehouseName',r.warehouse_name,'sku',r.sku,
                                          'productName',coalesce(r.product_name,''),'qty',r.qty,'uom',coalesce(r.uom,''),
                                          'locations',r.locations,'lastApprovedAt',r.last_approved_at,'lastApprovedBy',r.last_approved_by)
                       order by r.warehouse_id, r.sku)
        from public.sku_count_rows r where r.run_id = v_run.id), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.sku_count_save_start(jsonb,text[],jsonb) from public, anon;
revoke all on function public.sku_count_save_chunk(uuid,jsonb) from public, anon;
revoke all on function public.sku_count_save_finish(uuid) from public, anon;
revoke all on function public.sku_count_overview() from public;
grant execute on function public.sku_count_save_start(jsonb,text[],jsonb) to authenticated;
grant execute on function public.sku_count_save_chunk(uuid,jsonb) to authenticated;
grant execute on function public.sku_count_save_finish(uuid) to authenticated;
grant execute on function public.sku_count_overview() to anon, authenticated;

commit;
notify pgrst,'reload schema';
