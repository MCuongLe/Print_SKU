-- RỦI RO LƯU TRỮ · UID tạm: lưu phiếu gốc của từng dòng (26/10/2026, docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md việc 2.1).
-- Vì sao: người dùng cần bấm một dòng UID tạm để xem nguyên nhân phát sinh (phiếu IT, phiếu ADJ hay lệnh sản xuất). Dòng Import/Export
--   "Tạo UID Temp" chỉ mang mã phiếu xuất gốc (source_mapping_id); Extension / web tra phiếu gốc trong chính lượt đọc Import/Export
--   90 ngày (dòng xuất có source_code bằng mã đó) và gửi kèm mỗi dòng một object origin = {type, code, reason, by, at, from, to, lines[]}.
-- Tác động:
--   * Cột mới uid_temp_rows.origin jsonb (null = không tìm thấy phiếu gốc hoặc dòng lưu trước migration); chỉ object ≤ 8.000 ký tự.
--   * uid_temp_save (bản gốc uid_temp_snapshot_v1.sql, chưa bản nào thay) nhận thêm khoá origin: object hoặc null; khoá vắng = null
--     (Extension / web cũ vẫn lưu được); sai kiểu, quá 8.000 ký tự hoặc lines không phải mảng → INVALID_ROWS như các trường khác.
--   * uid_temp_overview (bản đang chạy = backend_hygiene_v1.sql, đã che createdBy) trả thêm origin; origin.by (email người duyệt)
--     của người không phải Admin chỉ còn phần trước '@' (N1185). uid_temp_snapshot gọi lại uid_temp_overview nên tự có origin.
--   * create or replace cùng chữ ký (không DROP); quyền ghi lại đúng như uid_temp_snapshot_v1.sql. Chạy lại nhiều lần được.
-- Thứ tự lên: migration này → Reload Extension (tải lại tab WMS) → push web. Web / Extension mới lên trước migration vẫn lưu được
--   (bản SQL cũ bỏ qua khoá origin), chỉ chưa có phiếu gốc.
-- Kiểm cục bộ: node tests/uid_temp_origin_sql.cjs; python scripts/apply_supabase_sql.py supabase/uid_temp_origin_v1.sql --dry-run
-- Lệnh: python scripts/apply_supabase_sql.py supabase/uid_temp_origin_v1.sql
-- kiem: select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'uid_temp_rows' and column_name = 'origin') and position('origin' in pg_get_functiondef('public.uid_temp_save(jsonb,jsonb)'::regprocedure)) > 0 and position('origin' in pg_get_functiondef('public.uid_temp_overview()'::regprocedure)) > 0 as ok
-- Rút lui (web / Extension mới vẫn chạy, chỉ mất phiếu gốc; cột để lại vô hại):
--   chạy lại hàm uid_temp_save trong supabase/uid_temp_snapshot_v1.sql và hàm uid_temp_overview trong supabase/backend_hygiene_v1.sql
--   (muốn bỏ hẳn dữ liệu: alter table public.uid_temp_rows drop column if exists origin;)
begin;

alter table public.uid_temp_rows
  add column if not exists origin jsonb check (origin is null or (jsonb_typeof(origin) = 'object' and length(origin::text) <= 8000));

-- Admin luu mot lan doc. p_rows = [{wh, warehouseName, sku, productName, qty, sourceCode, mappingId, createdBy, createdAt, origin}]
-- (0..5.000 dong); origin = phieu goc {type, code, reason, by, at, from, to, lines:[{sku, qty}]} hoac null / vang.
-- Than ham chep nguyen ban uid_temp_snapshot_v1.sql, chi them origin (kiem kieu + kich thuoc, ghi cot).
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
        or coalesce(jsonb_typeof(e.v->'origin'),'null') not in ('object','null')
        or length(coalesce(e.v->>'origin','')) > 8000
        or (jsonb_typeof(e.v->'origin') = 'object' and coalesce(jsonb_typeof(e.v->'origin'->'lines'),'array') <> 'array')
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

    insert into public.uid_temp_rows(run_id, idx, wh, warehouse_name, sku, product_name, qty, source_code, mapping_id, created_by, created_at, origin)
    select v_id, (o - 1)::integer, x.wh, btrim(x."warehouseName"), btrim(x.sku), nullif(btrim(x."productName"),''), x.qty,
           nullif(btrim(x."sourceCode"),''), nullif(btrim(x."mappingId"),''), nullif(btrim(x."createdBy"),''), x."createdAt", x.origin
      from jsonb_array_elements(p_rows) with ordinality as e(v, o),
           jsonb_to_record(e.v) as x(wh text, "warehouseName" text, sku text, "productName" text, qty numeric, "sourceCode" text, "mappingId" text, "createdBy" text, "createdAt" timestamptz, origin jsonb);
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

-- Moi nguoi xem: lan doc gan nhat + lich su. Than ham chep nguyen ban backend_hygiene_v1.sql (che createdBy), them origin:
-- nguoi khong phai Admin nhan origin.by la phan truoc '@' (N1185); origin null giu null.
create or replace function public.uid_temp_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.uid_temp_runs; v_admin boolean := public.group_uid_admin_allowed();
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
                                          'createdBy',coalesce(case when v_admin then r.created_by else split_part(r.created_by,'@',1) end,''),'createdAt',r.created_at,
                                          'origin',case when r.origin is null then null when v_admin or jsonb_typeof(r.origin->'by') is distinct from 'string' then r.origin else jsonb_set(r.origin,'{by}',to_jsonb(split_part(r.origin->>'by','@',1))) end) order by r.idx)
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
notify pgrst, 'reload schema';
