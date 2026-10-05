-- Doi chieu ADJ cua UID da cat voi file "Group UID History" cua WMS.
--
-- Dong Action = Cut trong history WMS la ket qua lenh ADJ (ghi chu
-- "Cut N out of group <UID> (remaining R)"). Admin nap file zip/xlsx tren man
-- Cat Group UID, trinh duyet chi gui dong Cut len day; dashboard doi chieu voi
-- cut_group_uids (adj_exported_at) de tim UID: da ADJ nhung quen tick, ADJ sai
-- so luong, tick ma WMS khong co, chua ADJ, Cut nhieu lan.
--
-- Chi tinh dong Cut cua WMS xay ra TU LUC UID duoc quet cat tren app tro di
-- (w.cut_at >= c.cut_at): tick ADJ luon sau khi quet, nen Cut truoc do la mot
-- lan cat khac cua cung UID (WMS cho cat nhieu lan), khong phai ADJ cua lan nay.
--
-- So luong chuan (1 m moi UID) KHONG tinh o day: frontend dung chung ham
-- computeCutQty da co o bang Tra cuu, de mot cong thuc duy nhat.
--
-- Khong drop gi: chi them bang va ham moi, nen khong can --allow-destructive.
-- Chay migration TRUOC khi cap nhat index.html.
begin;

create table if not exists public.wms_group_uid_history_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check (btrim(file_name) <> '' and length(file_name) <= 240),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  total_rows integer not null check (total_rows >= 0),
  cut_rows integer not null check (cut_rows >= 0),
  new_rows integer not null default 0 check (new_rows >= 0),
  changed_rows integer not null default 0 check (changed_rows >= 0),
  -- Khoang thoi gian file WMS bao phu (Updated Date nho nhat / lon nhat, gio VN).
  -- Dung de phan biet "chua ADJ" voi "file chua cap nhat toi luc tick".
  data_from timestamptz not null,
  data_until timestamptz not null check (data_until >= data_from),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists wms_group_uid_history_imports_created_idx
  on public.wms_group_uid_history_imports (created_at desc);

create table if not exists public.wms_group_uid_cuts (
  group_uid_code text not null check (length(btrim(group_uid_code)) between 1 and 40),
  cut_at timestamptz not null,
  qty numeric not null check (qty >= 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  remaining_qty numeric check (remaining_qty is null or (remaining_qty >= 0 and remaining_qty <> 'NaN'::numeric and remaining_qty <> 'Infinity'::numeric)),
  sku text,
  cut_by text,
  warehouse text,
  import_id uuid references public.wms_group_uid_history_imports(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Nap lai file chong len nhau khong nhan doi: moi lan Cut = 1 UID + 1 thoi diem.
  primary key (group_uid_code, cut_at)
);
create index if not exists wms_group_uid_cuts_cut_at_idx on public.wms_group_uid_cuts (cut_at desc);

alter table public.wms_group_uid_history_imports enable row level security;
alter table public.wms_group_uid_cuts enable row level security;
revoke all on public.wms_group_uid_history_imports from public, anon, authenticated;
revoke all on public.wms_group_uid_cuts from public, anon, authenticated;
grant select, insert, update, delete on public.wms_group_uid_history_imports to service_role;
grant select, insert, update, delete on public.wms_group_uid_cuts to service_role;

-- Admin nap cac dong Cut. Toi da 5.000 dong/lan; chi Admin (user_roles).
create or replace function public.wms_group_uid_cut_import(
  p_file_name text, p_file_sha256 text, p_total_rows integer,
  p_data_from timestamptz, p_data_until timestamptz, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_import uuid; v_bad integer; v_new integer := 0; v_changed integer := 0; v_previous integer; v_cut integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp file lịch sử WMS'));
  end if;
  if nullif(btrim(p_file_name),'') is null or length(p_file_name) > 240
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$'
     or p_total_rows is null or p_total_rows < 0
     or p_data_from is null or p_data_until is null or p_data_until < p_data_from
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_FILE','message','File không hợp lệ hoặc có quá 5.000 dòng Cut'));
  end if;
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,qty numeric,remaining_qty numeric,sku text,cut_by text,warehouse text)
   where nullif(btrim(group_uid_code),'') is null or length(btrim(group_uid_code)) > 40
      or cut_at is null or qty is null or qty < 0 or qty = 'NaN'::numeric or qty = 'Infinity'::numeric
      or (remaining_qty is not null and (remaining_qty < 0 or remaining_qty = 'NaN'::numeric or remaining_qty = 'Infinity'::numeric));
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng Cut thiếu hoặc sai dữ liệu'));
  end if;

  select count(*) into v_previous from public.wms_group_uid_history_imports where file_sha256 = p_file_sha256;
  v_cut := jsonb_array_length(p_rows);
  insert into public.wms_group_uid_history_imports(file_name,file_sha256,total_rows,cut_rows,data_from,data_until,created_by)
  values (btrim(p_file_name),p_file_sha256,p_total_rows,v_cut,p_data_from,p_data_until,(select auth.uid()))
  returning id into v_import;

  with src as (
    select distinct on (btrim(group_uid_code), cut_at)
           btrim(group_uid_code) as group_uid_code, cut_at, qty, remaining_qty,
           nullif(btrim(sku),'') as sku, nullif(btrim(cut_by),'') as cut_by, nullif(btrim(warehouse),'') as warehouse
      from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,qty numeric,remaining_qty numeric,sku text,cut_by text,warehouse text)
     order by btrim(group_uid_code), cut_at
  ), written as (
    insert into public.wms_group_uid_cuts as w(group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,import_id)
    select group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,v_import from src
    on conflict (group_uid_code,cut_at) do update
      set qty=excluded.qty, remaining_qty=excluded.remaining_qty, sku=excluded.sku,
          cut_by=excluded.cut_by, warehouse=excluded.warehouse, import_id=excluded.import_id
      where (w.qty,w.remaining_qty,w.sku,w.cut_by,w.warehouse)
            is distinct from (excluded.qty,excluded.remaining_qty,excluded.sku,excluded.cut_by,excluded.warehouse)
    returning (xmax = 0) as inserted
  )
  select coalesce(count(*) filter (where inserted),0), coalesce(count(*) filter (where not inserted),0)
    into v_new, v_changed from written;

  update public.wms_group_uid_history_imports set new_rows=v_new, changed_rows=v_changed where id=v_import;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'importId',v_import,'cutRows',v_cut,'newRows',v_new,'changedRows',v_changed,
      'unchangedRows',greatest(v_cut-v_new-v_changed,0),'previousImports',v_previous),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
exception when others then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','IMPORT_ERROR','message',left(sqlerrm,300)));
end $$;

-- Danh sach UID da cat kem cac dong Cut cua WMS; frontend phan loai trang thai.
-- Loc SKU / Lot / ngay cat giong cut_group_uid_search.
create or replace function public.cut_group_uid_reconcile(
  p_access_token text, p_sku text default '', p_lot text default '',
  p_date_from date default null, p_date_to date default null, p_limit integer default 5000
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,''));
        v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
        'printStatus',q.print_status,'cutAt',q.cut_at,'adjExportedAt',q.adj_exported_at,
        'wmsCuts',coalesce((select jsonb_agg(jsonb_build_object('cutAt',w.cut_at,'qty',w.qty,'remaining',w.remaining_qty,'by',w.cut_by) order by w.cut_at)
                              from public.wms_group_uid_cuts w where w.group_uid_code=q.group_uid_code and w.cut_at>=q.cut_at),'[]'::jsonb)
      ) order by q.cut_at desc) from (
        select * from public.cut_group_uids c
         where (v_sku='' or c.sku ilike '%'||v_sku||'%')
           and (v_lot='' or c.lot ilike '%'||v_lot||'%')
           and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
           and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
         order by c.cut_at desc limit v_limit
      ) q),'[]'::jsonb),
    'coverage',(select case when count(*)=0 then null else jsonb_build_object(
        'from',min(data_from),'until',max(data_until),'files',count(*),'importedAt',max(created_at)) end
        from public.wms_group_uid_history_imports),
    'lastImport',(select jsonb_build_object('fileName',i.file_name,'createdAt',i.created_at,'cutRows',i.cut_rows,
        'newRows',i.new_rows,'changedRows',i.changed_rows,'dataUntil',i.data_until)
        from public.wms_group_uid_history_imports i order by i.created_at desc limit 1),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- "Tick giup": UID da ADJ tren WMS (dung 1 dong Cut) nhung chua tick -> ghi
-- adj_exported_at bang gio Cut cua WMS. Bo qua UID da tick, khong co Cut (tu luc
-- quet tro di) hoac Cut nhieu lan. Server khong biet so luong chuan, nen frontend chi gui UID o
-- trang thai "Quen tick" (khong gui UID sai so luong).
create or replace function public.cut_group_uid_adj_from_wms(p_access_token text, p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_codes text[]; v_updated integer;
begin
  select coalesce(array_agg(distinct btrim(x)),'{}') into v_codes from unnest(coalesce(p_codes,'{}')) x where nullif(btrim(x),'') is not null;
  if cardinality(v_codes) not between 1 and 200 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lượt chọn từ 1 đến 200 UID'));
  end if;
  with eligible as (
    select c.group_uid_code, min(w.cut_at) as wms_at
      from public.cut_group_uids c
      join public.wms_group_uid_cuts w on w.group_uid_code = c.group_uid_code and w.cut_at >= c.cut_at
     where c.group_uid_code = any(v_codes) and c.adj_exported_at is null
     group by c.group_uid_code
    having count(*) = 1
  ), changed as (
    update public.cut_group_uids c set adj_exported_at = e.wms_at, updated_at = now()
      from eligible e where c.group_uid_code = e.group_uid_code and c.adj_exported_at is null
    returning c.group_uid_code, c.adj_exported_at
  )
  select count(*) into v_updated from changed;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('updated',v_updated,'skipped',cardinality(v_codes)-v_updated),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.wms_group_uid_cut_import(text,text,integer,timestamptz,timestamptz,jsonb) from public, anon;
revoke all on function public.cut_group_uid_reconcile(text,text,text,date,date,integer) from public;
revoke all on function public.cut_group_uid_adj_from_wms(text,text[]) from public;
grant execute on function public.wms_group_uid_cut_import(text,text,integer,timestamptz,timestamptz,jsonb) to authenticated;
grant execute on function public.cut_group_uid_reconcile(text,text,text,date,date,integer) to anon, authenticated;
grant execute on function public.cut_group_uid_adj_from_wms(text,text[]) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
