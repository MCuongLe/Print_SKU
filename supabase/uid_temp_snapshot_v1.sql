-- RUI RO LUU TRU · tab UID tam: luu ban chup lan doc WMS (18/10/2026).
--
-- Truoc day tab chi giu ket qua trong bo nho trang (ban 1, 16/10/2026: "khong ghi Supabase"): tai lai trang hay may khac la mat,
-- nguoi khong noi duoc WMS (o nha, may khong co Extension) khong xem duoc gi. Nguoi dung chon huong luu Supabase nhu Kiem ke.
--
-- Mo hinh giong sku_count_v1: bang chi cap service_role (RLS bat, khong policy); doc qua ham chi-doc cap anon (uid_temp_overview);
-- ghi qua ham kiem public.group_uid_admin_allowed() chi cap authenticated (uid_temp_save). Du lieu nho (vai chuc dong / 90 ngay)
-- nen ghi MOT lan trong mot giao dich (khong chia start/chunk/finish). Luot rong (khong co UID tam nao) VAN luu: do la ket qua
-- hop le can xem duoc. Giu 10 luot gan nhat (lich su), luot cu hon bi xoa trong cung giao dich.
--
-- Chi them bang va ham moi, khong drop gi: khong can --allow-destructive.
-- Chay migration TRUOC khi push index.html (web moi goi uid_temp_overview / uid_temp_save).
begin;

create table if not exists public.uid_temp_runs (
  id uuid primary key default gen_random_uuid(),
  read_at timestamptz not null,
  warehouses jsonb not null default '[]'::jsonb check (jsonb_typeof(warehouses) = 'array'),
  warn text[] not null default '{}',
  scanned integer not null default 0 check (scanned >= 0),
  pages integer not null default 0 check (pages >= 0),
  range_days integer not null default 90 check (range_days between 1 and 366),
  row_count integer not null default 0 check (row_count >= 0),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists uid_temp_runs_read_idx on public.uid_temp_runs (read_at desc, created_at desc);

create table if not exists public.uid_temp_rows (
  run_id uuid not null references public.uid_temp_runs(id) on delete cascade,
  idx integer not null check (idx >= 0),
  wh text not null check (wh in ('mtg','garment')),
  warehouse_name text not null check (length(btrim(warehouse_name)) between 1 and 120),
  sku text not null check (length(btrim(sku)) between 1 and 80),
  product_name text check (product_name is null or length(product_name) <= 500),
  qty numeric not null check (qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric and qty <> '-Infinity'::numeric),
  source_code text check (source_code is null or length(source_code) <= 80),
  mapping_id text check (mapping_id is null or length(mapping_id) <= 80),
  created_by text check (created_by is null or length(created_by) <= 200),
  created_at timestamptz,
  primary key (run_id, idx)
);

alter table public.uid_temp_runs enable row level security;
alter table public.uid_temp_rows enable row level security;
revoke all on public.uid_temp_runs from public, anon, authenticated;
revoke all on public.uid_temp_rows from public, anon, authenticated;
grant select, insert, update, delete on public.uid_temp_runs to service_role;
grant select, insert, update, delete on public.uid_temp_rows to service_role;

-- Admin luu mot lan doc. p_run = {readAt, warehouses:[{warehouseId, warehouseName, companyName}], warn:[text], scanned, pages, rangeDays};
-- p_rows = [{wh, warehouseName, sku, productName, qty, sourceCode, mappingId, createdBy, createdAt}] (0..5.000 dong).
-- readAt = moc CUOI cua khoang truy van WMS (khong phai luc doc xong): ban moi nhat chon theo read_at, nen hai may doc chong nhau
-- thi ban phu den moc muon hon thang. Luu tuan tu bang advisory lock (hai luot cung luu khong cung xoa / de 11 luot).
-- Ep kieu du lieu tu JSON nam trong khoi exception: gia tri sai kieu tra INVALID_ROWS, khong nem loi tho.
create or replace function public.uid_temp_save(p_run jsonb, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_bad integer; v_count integer; v_read timestamptz;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được lưu UID tạm'));
  end if;
  perform pg_advisory_xact_lock(hashtext('public.uid_temp_save'));
  if p_run is null or jsonb_typeof(p_run) <> 'object'
     or jsonb_typeof(p_run->'warehouses') is distinct from 'array' or jsonb_array_length(p_run->'warehouses') not between 1 and 10 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Thông tin lần đọc không hợp lệ'));
  end if;
  begin
    v_read := (p_run->>'readAt')::timestamptz;
  exception when others then
    v_read := null;
  end;
  if v_read is null or v_read > now() + interval '10 minutes' or v_read < now() - interval '1 day' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Giờ đọc không hợp lệ'));
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần lưu tối đa 5.000 dòng'));
  end if;
  begin
    select count(*) into v_bad
      from jsonb_array_elements(p_rows) as e(v)
     where jsonb_typeof(e.v) <> 'object' or jsonb_typeof(e.v->'qty') is distinct from 'number'
        or jsonb_typeof(e.v->'wh') is distinct from 'string' or jsonb_typeof(e.v->'warehouseName') is distinct from 'string'
        or jsonb_typeof(e.v->'sku') is distinct from 'string'
        or coalesce(jsonb_typeof(e.v->'productName'),'null') not in ('string','null')
        or coalesce(jsonb_typeof(e.v->'sourceCode'),'null') not in ('string','null')
        or coalesce(jsonb_typeof(e.v->'mappingId'),'null') not in ('string','null')
        or coalesce(jsonb_typeof(e.v->'createdBy'),'null') not in ('string','null')
        or coalesce(jsonb_typeof(e.v->'createdAt'),'null') not in ('string','null');
    if v_bad = 0 then
      select count(*) into v_bad
        from jsonb_to_recordset(p_rows) as x(wh text, "warehouseName" text, sku text, "productName" text, qty numeric, "sourceCode" text, "mappingId" text, "createdBy" text, "createdAt" timestamptz)
       where wh is null or wh not in ('mtg','garment')
          or nullif(btrim("warehouseName"),'') is null or length(btrim("warehouseName")) > 120
          or nullif(btrim(sku),'') is null or length(btrim(sku)) > 80
          or qty is null or qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
          or length(coalesce("productName",'')) > 500 or length(coalesce("sourceCode",'')) > 80
          or length(coalesce("mappingId",'')) > 80 or length(coalesce("createdBy",'')) > 200;
    end if;
    if v_bad > 0 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng UID tạm thiếu hoặc sai dữ liệu'));
    end if;
    -- Bo dem: khoa vang thi dung mac dinh; khoa co mat (ke ca null) phai la so nguyen trong mien, sai kieu thi tra loi.
    if exists (select 1 from (values ('scanned', 0, 2000000000), ('pages', 0, 2000000000), ('rangeDays', 1, 366)) as k(f, lo, hi)
                where p_run ? k.f
                  and case when jsonb_typeof(p_run->k.f) <> 'number' then true
                           else (p_run->>k.f)::numeric <> trunc((p_run->>k.f)::numeric) or (p_run->>k.f)::numeric not between k.lo and k.hi end) then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Bộ đếm lần đọc không hợp lệ'));
    end if;

    insert into public.uid_temp_runs(read_at, warehouses, warn, scanned, pages, range_days, row_count, created_by)
    values (v_read, p_run->'warehouses',
            coalesce(array(select left(t, 300) from jsonb_array_elements_text(case when jsonb_typeof(p_run->'warn') = 'array' then p_run->'warn' else '[]'::jsonb end) as t limit 20), '{}'),
            coalesce((p_run->>'scanned')::numeric::integer, 0), coalesce((p_run->>'pages')::numeric::integer, 0),
            coalesce((p_run->>'rangeDays')::numeric::integer, 90),
            jsonb_array_length(p_rows), (select auth.uid()))
    returning id into v_id;

    insert into public.uid_temp_rows(run_id, idx, wh, warehouse_name, sku, product_name, qty, source_code, mapping_id, created_by, created_at)
    select v_id, (o - 1)::integer, x.wh, btrim(x."warehouseName"), btrim(x.sku), nullif(btrim(x."productName"),''), x.qty,
           nullif(btrim(x."sourceCode"),''), nullif(btrim(x."mappingId"),''), nullif(btrim(x."createdBy"),''), x."createdAt"
      from jsonb_array_elements(p_rows) with ordinality as e(v, o),
           jsonb_to_record(e.v) as x(wh text, "warehouseName" text, sku text, "productName" text, qty numeric, "sourceCode" text, "mappingId" text, "createdBy" text, "createdAt" timestamptz);
    get diagnostics v_count = row_count;
  exception when others then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng UID tạm sai kiểu dữ liệu: ' || left(sqlerrm, 200)));
  end;

  delete from public.uid_temp_runs
   where id not in (select id from public.uid_temp_runs order by read_at desc, created_at desc, id desc limit 10);
  -- Luot vua ghi cu hon ca 10 luot da giu (may doc cham luu muon) thi bi don ngay: bao ro, khong bao "da luu".
  if not exists (select 1 from public.uid_temp_runs where id = v_id) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','STALE_RUN','message','Lần đọc này cũ hơn các lần đọc đã lưu nên không giữ lại; bấm Đọc WMS để đọc mới'));
  end if;

  return jsonb_build_object('ok',true,'data',jsonb_build_object('runId',v_id,'rowCount',v_count),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Moi nguoi xem: lan doc gan nhat (chi doc, cap anon nhu sku_count_overview) + danh sach cac lan doc da giu (lich su).
create or replace function public.uid_temp_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.uid_temp_runs;
begin
  select * into v_run from public.uid_temp_runs order by read_at desc, created_at desc, id desc limit 1;
  if not found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('run',null,'rows','[]'::jsonb,'history','[]'::jsonb),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'run', jsonb_build_object('id',v_run.id,'readAt',v_run.read_at,'warehouses',v_run.warehouses,'warn',to_jsonb(v_run.warn),
                              'scanned',v_run.scanned,'pages',v_run.pages,'rangeDays',v_run.range_days,'rowCount',v_run.row_count),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('wh',r.wh,'warehouseName',r.warehouse_name,'sku',r.sku,'productName',coalesce(r.product_name,''),
                                          'qty',r.qty,'sourceCode',coalesce(r.source_code,''),'mappingId',coalesce(r.mapping_id,''),
                                          'createdBy',coalesce(r.created_by,''),'createdAt',r.created_at) order by r.idx)
        from public.uid_temp_rows r where r.run_id = v_run.id), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('id',h.id,'readAt',h.read_at,'rowCount',h.row_count) order by h.read_at desc, h.created_at desc, h.id desc)
        from public.uid_temp_runs h), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.uid_temp_save(jsonb,jsonb) from public, anon;
revoke all on function public.uid_temp_overview() from public;
grant execute on function public.uid_temp_save(jsonb,jsonb) to authenticated;
grant execute on function public.uid_temp_overview() to anon, authenticated;

commit;
notify pgrst,'reload schema';
