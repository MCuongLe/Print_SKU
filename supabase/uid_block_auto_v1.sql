-- LỰA UID BLOCKED: tự nhận UID Blocked mới + đánh dấu UID hết Blocked (21/10/2026, docs/plans/2026-10-21-uid-blocked-quet-truoc.md).
--
-- Vì sao: người dùng 21/10 — "khi cập nhật có group blocked mới thì đưa qua đây". Danh sách WMS (uid_block_import_wms) chỉ đổi
-- khi Admin bấm "Lấy từ WMS". Người dùng chốt: tự cập nhật 30 phút (pg_cron); UID trong danh sách mà WMS hết Blocked thì bỏ khỏi
-- "còn thiếu" nhưng PHẢI hiển thị là "Hết Blocked" (giữ 7 ngày), lượt đã quét vẫn giữ; danh sách Excel (Admin nạp tay) KHÔNG tự đổi.
--
-- Tác động:
--   1. Cột mới: uid_block_lists.source ('excel' mặc định | 'wms'); uid_block_items.added_at (lúc UID vào danh sách WMS — null = có
--      từ lần lấy tay đầu tiên), released_at (lúc phát hiện hết Blocked; null = còn Blocked), wms_status (trạng thái WMS lúc dựng,
--      ≤ 100 ký tự). Danh sách đã có được đánh source = 'wms' khi tên "WMS Blocked ·…" VÀ sheets là 1–10 tên kho có trong
--      group_uid_details (chạy lại không đổi gì; danh sách Excel đặt tên giống vẫn là 'excel').
--   2. _uid_block_import_body(p_list, p_items, p_by): thân nạp cũ của uid_block_import (khoá advisory, kiểm kiểu,
--      1–20.000 dòng — riêng source 'wms' được 0 dòng, giữ 5 danh sách, chép lượt quét) KHÔNG kiểm Admin — chỉ chủ sở hữu gọi (revoke public/anon/authenticated). Nhận thêm
--      p_list.source, mỗi dòng addedAt / releasedAt (chuỗi giờ ISO có múi giờ hoặc null) + wmsStatus. item_count / by_warehouse
--      KHÔNG tính dòng hết Blocked. Lượt quét của UID hết Blocked vẫn được chép sang danh sách mới (còn trong "Đã lựa").
--   3. uid_block_import(p_list, p_items): chữ ký + quyền cũ; kiểm Admin rồi gọi thân với auth.uid().
--   4. _uid_block_build_wms(p_warehouses, p_prev): dựng danh sách dùng chung cho lấy tay và cron (chỉ đọc).
--      Blocked hiện tại ở các kho: addedAt giữ của danh sách trước nếu UID đã có (chưa hết Blocked), danh sách trước là WMS → now(),
--      danh sách trước Excel/không có → null. UID của danh sách trước (chỉ khi nó là WMS) không còn trong tập Blocked hiện tại →
--      releasedAt (giữ cũ / now), wmsStatus hiện tại (null nếu không còn trong group_uid_details), giữ chi tiết cũ; quá 7 ngày bỏ nếu CHƯA quét (đã quét → giữ).
--   5. uid_block_import_wms(p_warehouses): chữ ký + quyền cũ; khoá nạp TRƯỚC khi đọc danh sách đang dùng, dựng qua hàm (4),
--      source 'wms', vẫn nạp qua uid_block_import.
--   6. uid_block_refresh_wms(): chỉ chủ sở hữu / pg_cron. Danh sách đang dùng không phải WMS → không làm gì. Dựng lại (4) với kho
--      = sheets của danh sách; so tập hai chiều — dòng còn Blocked (mã, kho, vị trí, SKU, lot, roll, trạng thái), dòng hết Blocked
--      (mã, trạng thái WMS hiện tại), không so giờ; giống → không tạo danh sách; khác → nạp qua thân (2), p_by null, tên
--      "WMS Blocked · <kho> · dd/mm HH:MI" (giờ VN); dựng ra rỗng vẫn tạo danh sách rỗng (trừ khi danh sách đang dùng đã rỗng).
--   7. pg_cron 'uid-block-refresh-wms' mỗi 30 phút (cùng tên thì pg_cron thay lịch cũ).
--   8. uid_block_snapshot (= bản group_uid_rfid_v1.sql, giữ chữ ký/quyền/nhánh unchanged/rfid): item thêm addedAt, releasedAt,
--      wmsStatus; list thêm source.
--   9. uid_block_scan (= bản uid_block_v1.sql, giữ chữ ký/quyền/khoá máy/khoá chia sẻ): UID hết Blocked mà giờ quét sau lúc hết
--      Blocked → không ghi, trả not_blocked + released/wmsStatus/releasedAt; giờ quét ≤ released_at (hàng chờ ngoại tuyến) vẫn ghi.
-- Khoá: refresh / import_wms giữ khoá độc quyền pg_advisory_xact_lock('public.uid_block_import') từ lúc đọc danh sách đang dùng tới
-- hết giao dịch (thân nạp lấy lại cùng khoá — advisory lock tái nhập trong một phiên); uid_block_scan giữ khoá chia sẻ nên lượt
-- quét chờ lượt dựng xong (một lần quét group_uid_details + ~vài trăm dòng) rồi thấy danh sách mới (STALE_LIST) hoặc cũ.
-- Chỉ thêm cột/ràng buộc/hàm, thay hàm và thêm lịch cron; không drop: không cần --allow-destructive.
-- Cần có trước: uid_block_v1, uid_block_wms_v1, group_uid_rfid_v1. Chạy migration TRƯỚC khi push index.html (web đọc addedAt /
-- releasedAt / wmsStatus / source).
-- Chạy: python scripts/apply_supabase_sql.py supabase/uid_block_auto_v1.sql
begin;

alter table public.uid_block_lists add column if not exists source text not null default 'excel';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uid_block_lists_source_check'
                   and conrelid = 'public.uid_block_lists'::regclass) then
    alter table public.uid_block_lists add constraint uid_block_lists_source_check check (source in ('excel', 'wms'));
  end if;
end $$;

alter table public.uid_block_items add column if not exists added_at timestamptz;
alter table public.uid_block_items add column if not exists released_at timestamptz;
alter table public.uid_block_items add column if not exists wms_status text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uid_block_items_wms_status_check'
                   and conrelid = 'public.uid_block_items'::regclass) then
    alter table public.uid_block_items add constraint uid_block_items_wms_status_check check (wms_status is null or char_length(wms_status) <= 100);
  end if;
end $$;

comment on column public.uid_block_lists.source is
  'excel = Admin nạp tệp (không tự đổi); wms = dựng từ group_uid_details (uid_block_import_wms / cron uid_block_refresh_wms).';
comment on column public.uid_block_items.added_at is
  'Lúc UID Blocked vào danh sách WMS (cron phát hiện mới); NULL = có từ lần lấy tay đầu tiên hoặc danh sách Excel.';
comment on column public.uid_block_items.released_at is
  'Lúc phát hiện UID không còn Blocked (rời tập Blocked của các kho); NULL = còn Blocked. Dòng hết Blocked giữ 7 ngày (đã quét → giữ luôn).';

-- Danh sách WMS đã nạp trước migration này (uid_block_import_wms, 21/10/2026 07:56 — duy nhất, tra chỉ đọc trước khi viết):
-- ghi đích danh id, KHÔNG suy nguồn theo tên tệp hay dữ liệu kho (Codex vòng 2: Excel đặt tên "WMS Blocked …" phải giữ 'excel').
update public.uid_block_lists l set source = 'wms'
 where l.id = 'fbeef2e5-902c-4cf8-b9bc-948ec6fd8792' and l.source <> 'wms';

-- Thân nạp (= uid_block_import trong uid_block_v1.sql, bỏ kiểm Admin; người nạp = p_by). p_list = {fileName, sheets:[text],
-- source?: 'excel'|'wms'}; p_items = [{groupUid, sku, productName, lot, roll, warehouse, location, fileStatus, addedAt?, releasedAt?,
-- wmsStatus?}]. Giờ: chuỗi ISO có múi giờ (to_jsonb(timestamptz) của Postgres) — kiểm dạng trước, giá trị sai lịch (tháng 13)
-- rơi vào exception → INVALID_INPUT.
create or replace function public._uid_block_import_body(p_list jsonb, p_items jsonb, p_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_prev uuid; v_bad integer; v_total integer; v_count integer; v_by jsonb; v_carried integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('public.uid_block_import'));

  if p_list is null or jsonb_typeof(p_list) <> 'object'
     or jsonb_typeof(p_list->'fileName') is distinct from 'string'
     or length(btrim(p_list->>'fileName')) not between 1 and 200
     or jsonb_typeof(p_list->'sheets') is distinct from 'array'
     or jsonb_array_length(case when jsonb_typeof(p_list->'sheets') = 'array' then p_list->'sheets' else '[]'::jsonb end) > 100
     or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_list->'sheets') = 'array' then p_list->'sheets' else '[]'::jsonb end) as s(v)
                 where jsonb_typeof(s.v) <> 'string' or length(s.v #>> '{}') > 200)
     or coalesce(jsonb_typeof(p_list->'source'),'null') not in ('string','null')
     or coalesce(p_list->>'source','excel') not in ('excel','wms') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Thông tin tệp không hợp lệ (tên tệp 1–200 ký tự, danh sách sheet là chuỗi, nguồn excel hoặc wms)'));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end)
        not between (case when coalesce(p_list->>'source','excel') = 'wms' then 0 else 1 end) and 20000 then
    -- Danh sách WMS được rỗng (dòng hết Blocked cuối cùng hết hạn 7 ngày); tệp Excel vẫn phải có ít nhất 1 UID.
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần nạp từ 1 đến 20.000 UID'));
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_items) as e(v)
   where jsonb_typeof(e.v) <> 'object'
      or jsonb_typeof(e.v->'groupUid') is distinct from 'string'
      or btrim(e.v->>'groupUid') !~ '^[0-9]{16}$'
      or coalesce(jsonb_typeof(e.v->'sku'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'productName'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'lot'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'roll'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'warehouse'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'location'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'fileStatus'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'addedAt'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'releasedAt'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'wmsStatus'),'null') not in ('string','null')
      or length(coalesce(e.v->>'sku','')) > 300
      or length(coalesce(e.v->>'productName','')) > 300
      or length(coalesce(e.v->>'lot','')) > 300
      or length(coalesce(e.v->>'roll','')) > 300
      or length(coalesce(e.v->>'warehouse','')) > 300
      or length(coalesce(e.v->>'location','')) > 300
      or length(coalesce(e.v->>'fileStatus','')) > 300
      or length(coalesce(e.v->>'wmsStatus','')) > 100
      or (e.v->>'addedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
      or (e.v->>'releasedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$';
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT',
      'message','Có ' || v_bad || ' dòng sai dữ liệu (Group UID phải đúng 16 chữ số, các cột khác là chữ tối đa 300 ký tự, trạng thái WMS tối đa 100 ký tự, giờ dạng ISO có múi giờ)'));
  end if;

  select l.id into v_prev
    from public.uid_block_lists l
   order by l.imported_at desc, l.id desc
   limit 1;

  begin
    insert into public.uid_block_lists(file_name, sheets, source, item_count, imported_by, imported_at)
    values (btrim(p_list->>'fileName'), p_list->'sheets', coalesce(p_list->>'source','excel'), 0, p_by, clock_timestamp())
    returning id into v_id;

    insert into public.uid_block_items(list_id, group_uid_code, sku, product_name, lot, roll, warehouse, location, file_status, added_at, released_at, wms_status)
    select distinct on (btrim(e.v->>'groupUid'))
           v_id, btrim(e.v->>'groupUid'), nullif(btrim(e.v->>'sku'),''), nullif(btrim(e.v->>'productName'),''),
           nullif(btrim(e.v->>'lot'),''), nullif(btrim(e.v->>'roll'),''), nullif(btrim(e.v->>'warehouse'),''),
           nullif(btrim(e.v->>'location'),''), nullif(btrim(e.v->>'fileStatus'),''),
           (e.v->>'addedAt')::timestamptz, (e.v->>'releasedAt')::timestamptz, nullif(btrim(e.v->>'wmsStatus'),'')
      from jsonb_array_elements(p_items) with ordinality as e(v, o)
     order by btrim(e.v->>'groupUid'), e.o;
    get diagnostics v_total = row_count;

    -- Đếm UID còn Blocked: dòng hết Blocked (released_at) chỉ để hiển thị + giữ lượt quét, không tính vào số lượng.
    select count(*)::integer into v_count from public.uid_block_items i where i.list_id = v_id and i.released_at is null;

    select coalesce(jsonb_object_agg(w.k, w.n), '{}'::jsonb) into v_by
      from (select coalesce(i.warehouse, '') as k, count(*) as n
              from public.uid_block_items i where i.list_id = v_id and i.released_at is null group by 1) w;

    update public.uid_block_lists set item_count = v_count, by_warehouse = v_by where id = v_id;

    insert into public.uid_block_scans(list_id, group_uid_code, scanned_at, recorded_at, device_id, device_name)
    select v_id, s.group_uid_code, s.scanned_at, s.recorded_at, s.device_id, s.device_name
      from public.uid_block_scans s
      join public.uid_block_items i on i.list_id = v_id and i.group_uid_code = s.group_uid_code
     where s.list_id = v_prev;
    get diagnostics v_carried = row_count;
  exception when others then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Không lưu được danh sách: ' || left(sqlerrm, 200)));
  end;

  delete from public.uid_block_lists
   where id not in (select id from public.uid_block_lists order by imported_at desc, id desc limit 5);

  return jsonb_build_object('ok',true,'data',jsonb_build_object('listId',v_id,'itemCount',v_count,'byWarehouse',v_by,
                                                                'carriedScans',v_carried,'releasedCount',v_total - v_count),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Admin nạp (web: Nạp Excel; uid_block_import_wms). Chữ ký, quyền, khoá JSON trả về như uid_block_v1.sql.
create or replace function public.uid_block_import(p_list jsonb, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp danh sách UID blocked'));
  end if;
  return public._uid_block_import_body(p_list, p_items, (select auth.uid()));
end$$;

-- Dựng danh sách WMS (mảng item cho thân nạp). p_prev = danh sách đang dùng (đọc SAU khoá nạp ở hàm gọi). Thứ tự: kho, vị trí, mã.
create or replace function public._uid_block_build_wms(p_warehouses text[], p_prev uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_now timestamptz := now(); v_src text; v_items jsonb;
begin
  select l.source into v_src from public.uid_block_lists l where l.id = p_prev;

  with cur as materialized (
    select g.group_uid_code, g.sku, g.batch_code, g.roll_code, g.warehouse, g.location, g.status
      from public.group_uid_details g
     where g.status ilike 'blocked'
       and g.warehouse = any(p_warehouses)
       and g.group_uid_code ~ '^[0-9]{16}$'
  ), r as (
    select c.group_uid_code, c.warehouse, c.location,
           jsonb_build_object(
             'groupUid', c.group_uid_code,
             'sku', left(c.sku, 300),
             'productName', left(n.product_name, 300),
             'lot', left(c.batch_code, 300),
             'roll', left(c.roll_code, 300),
             'warehouse', left(c.warehouse, 300),
             'location', left(c.location, 300),
             'fileStatus', left(c.status, 300),
             'wmsStatus', left(c.status, 100),
             'addedAt', case when p.group_uid_code is not null and p.released_at is null then p.added_at
                             when v_src = 'wms' then v_now else null end,
             'releasedAt', null) as item
      from cur c
      left join public.uid_block_items p on p.list_id = p_prev and p.group_uid_code = c.group_uid_code
      left join lateral (select s.product_name from public."SKU_Name" s where s.sku = c.sku limit 1) n on true
    union all
    -- UID của danh sách WMS trước không còn trong tập Blocked hiện tại (hết Blocked, đổi kho hoặc không còn trên WMS).
    select p.group_uid_code, p.warehouse, p.location,
           jsonb_build_object(
             'groupUid', p.group_uid_code,
             'sku', p.sku,
             'productName', p.product_name,
             'lot', p.lot,
             'roll', p.roll,
             'warehouse', p.warehouse,
             'location', p.location,
             'fileStatus', p.file_status,
             'wmsStatus', left(g.status, 100),
             'addedAt', p.added_at,
             'releasedAt', coalesce(p.released_at, v_now)) as item
      from public.uid_block_items p
      left join public.group_uid_details g on g.group_uid_code = p.group_uid_code
     where v_src = 'wms'
       and p.list_id = p_prev
       and not exists (select 1 from cur c where c.group_uid_code = p.group_uid_code)
       -- Quá 7 ngày chỉ bỏ dòng CHƯA quét; dòng đã có lượt quét giữ mãi để lượt quét còn được chép (Đã lựa không mất).
       and (p.released_at is null or p.released_at >= v_now - interval '7 days'
            or exists (select 1 from public.uid_block_scans s where s.list_id = p_prev and s.group_uid_code = p.group_uid_code))
  )
  select coalesce(jsonb_agg(r.item order by r.warehouse, r.location, r.group_uid_code), '[]'::jsonb) into v_items
    from r;
  return v_items;
end $$;

-- Admin lấy tay (nút "Lấy từ WMS"). Như uid_block_wms_v1.sql + khoá trước khi đọc danh sách đang dùng + hàm dựng chung.
create or replace function public.uid_block_import_wms(p_warehouses text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_wh text[]; v_items jsonb; v_prev uuid; v_name text;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp danh sách UID blocked'));
  end if;
  select array_agg(distinct btrim(w) order by btrim(w)) into v_wh
    from unnest(coalesce(p_warehouses, '{}'::text[])) as u(w)
   where nullif(btrim(w), '') is not null;
  if v_wh is null or cardinality(v_wh) > 10 or exists (select 1 from unnest(v_wh) as u(w) where length(w) > 200) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Chọn từ 1 đến 10 kho'));
  end if;

  perform pg_advisory_xact_lock(hashtext('public.uid_block_import'));
  select l.id into v_prev
    from public.uid_block_lists l
   order by l.imported_at desc, l.id desc
   limit 1;
  v_items := public._uid_block_build_wms(v_wh, v_prev);

  -- Không còn UID Blocked vẫn nạp (danh sách WMS rỗng thay danh sách Excel cũ — Codex vòng 2), thân nạp nhận 0 dòng khi source 'wms'.
  v_name := left('WMS Blocked · ' || array_to_string(v_wh, ' + ') || ' · '
                 || to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI'), 200);
  return public.uid_block_import(jsonb_build_object('fileName', v_name, 'sheets', to_jsonb(v_wh), 'source', 'wms'), v_items);
end $$;

-- pg_cron mỗi 30 phút. Chỉ đổi danh sách WMS; giống tập cũ thì không tạo danh sách (không đổi phiên bản trên máy).
create or replace function public.uid_block_refresh_wms()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_list public.uid_block_lists; v_wh text[]; v_items jsonb; v_same boolean; v_added integer; v_released integer;
        v_name text; v_res jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('public.uid_block_import'));
  select * into v_list from public.uid_block_lists order by imported_at desc, id desc limit 1;
  if not found or v_list.source <> 'wms' then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('changed',false,'reason','not_wms'),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;

  select array_agg(distinct btrim(u.w) order by btrim(u.w)) into v_wh
    from jsonb_array_elements_text(v_list.sheets) as u(w)
   where nullif(btrim(u.w), '') is not null;
  if v_wh is null then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('changed',false,'reason','no_warehouses','listId',v_list.id),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;

  v_items := public._uid_block_build_wms(v_wh, v_list.id);

  -- So tập hai chiều. Dòng còn Blocked: (mã, kho, vị trí, SKU, lot, roll, trạng thái) — UID đổi vị trí phải ra danh sách mới để
  -- người lựa tới đúng chỗ. Dòng hết Blocked: (mã, released, trạng thái WMS hiện tại); chi tiết của nó là bản cũ giữ lại. KHÔNG so
  -- addedAt / releasedAt (giờ phát sinh). Chuẩn hoá tập mới giống lúc ghi (nullif(btrim(...),'')).
  with new_set as (
    select btrim(e.v->>'groupUid') as code, (e.v->>'releasedAt') is not null as rel,
           case when e.v->>'releasedAt' is null then nullif(btrim(e.v->>'warehouse'),'') end as wh,
           case when e.v->>'releasedAt' is null then nullif(btrim(e.v->>'location'),'') end as loc,
           case when e.v->>'releasedAt' is null then nullif(btrim(e.v->>'sku'),'') end as sku,
           case when e.v->>'releasedAt' is null then nullif(btrim(e.v->>'lot'),'') end as lot,
           case when e.v->>'releasedAt' is null then nullif(btrim(e.v->>'roll'),'') end as roll,
           case when e.v->>'releasedAt' is not null then nullif(btrim(e.v->>'wmsStatus'),'') else nullif(btrim(e.v->>'fileStatus'),'') end as st
      from jsonb_array_elements(v_items) as e(v)
  ), old_set as (
    select i.group_uid_code as code, i.released_at is not null as rel,
           case when i.released_at is null then i.warehouse end as wh,
           case when i.released_at is null then i.location end as loc,
           case when i.released_at is null then i.sku end as sku,
           case when i.released_at is null then i.lot end as lot,
           case when i.released_at is null then i.roll end as roll,
           case when i.released_at is not null then i.wms_status else i.file_status end as st
      from public.uid_block_items i
     where i.list_id = v_list.id
  )
  select not exists (select x.code, x.rel, x.wh, x.loc, x.sku, x.lot, x.roll, x.st from new_set x
                     except select y.code, y.rel, y.wh, y.loc, y.sku, y.lot, y.roll, y.st from old_set y)
         and not exists (select y.code, y.rel, y.wh, y.loc, y.sku, y.lot, y.roll, y.st from old_set y
                         except select x.code, x.rel, x.wh, x.loc, x.sku, x.lot, x.roll, x.st from new_set x),
         (select count(*)::integer from new_set x
           where not x.rel and not exists (select 1 from old_set y where y.code = x.code and not y.rel)),
         (select count(*)::integer from new_set x
           where x.rel and not exists (select 1 from old_set y where y.code = x.code and y.rel))
    into v_same, v_added, v_released;

  -- Dựng ra rỗng mà danh sách đang dùng cũng rỗng → giống → không tạo; còn lại tạo danh sách WMS mới (có thể item_count = 0).
  if v_same then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('changed',false,'listId',v_list.id,'itemCount',v_list.item_count),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;

  v_name := left('WMS Blocked · ' || array_to_string(v_wh, ' + ') || ' · '
                 || to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI'), 200);
  v_res := public._uid_block_import_body(jsonb_build_object('fileName', v_name, 'sheets', to_jsonb(v_wh), 'source', 'wms'), v_items, null);
  if coalesce((v_res->>'ok')::boolean, false) is not true then
    return v_res;
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('changed',true,'listId',v_res#>'{data,listId}',
                                                                'itemCount',v_res#>'{data,itemCount}','added',v_added,'released',v_released,
                                                                'carriedScans',v_res#>'{data,carriedScans}'),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- uid_block_snapshot = bản group_uid_rfid_v1.sql + item addedAt/releasedAt/wmsStatus + list source.
create or replace function public.uid_block_snapshot(p_known_list_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_list public.uid_block_lists;
begin
  select * into v_list from public.uid_block_lists order by imported_at desc, id desc limit 1;
  if not found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',false,'list',null,'items','[]'::jsonb),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  if p_known_list_id is not null and v_list.id = p_known_list_id then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',true,'listId',v_list.id),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',false,
    'list', jsonb_build_object('id',v_list.id,'fileName',v_list.file_name,'sheets',v_list.sheets,'source',v_list.source,
                               'itemCount',v_list.item_count,'byWarehouse',v_list.by_warehouse,'importedAt',v_list.imported_at),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('groupUid',i.group_uid_code,'sku',i.sku,'productName',i.product_name,'lot',i.lot,'roll',i.roll,
                                          'warehouse',i.warehouse,'location',i.location,'fileStatus',i.file_status,
                                          'rfid',g.group_rfid_mapping,
                                          'addedAt',i.added_at,'releasedAt',i.released_at,'wmsStatus',i.wms_status) order by i.group_uid_code)
        from public.uid_block_items i
        left join public.group_uid_details g on g.group_uid_code = i.group_uid_code
       where i.list_id = v_list.id), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- uid_block_scan = bản uid_block_v1.sql (chữ ký, khoá máy, khoá chia sẻ, STALE_LIST, new/dup/mine giữ nguyên) + DB là cổng cuối cho
-- UID hết Blocked: dòng có released_at mà giờ quét (đã chuẩn hoá) SAU lúc hết Blocked → KHÔNG ghi, trả result 'not_blocked' (web cũ
-- bỏ hàng chờ an toàn) kèm released:true, wmsStatus, releasedAt (web mới hiện "HẾT BLOCKED"). Giờ quét ≤ released_at (lượt ngoại
-- tuyến xảy ra trước lúc hết Blocked) vẫn ghi như cũ.
create or replace function public.uid_block_scan(p_access_token text, p_list_id uuid, p_group_uid text, p_scanned_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text; v_code text; v_list uuid; v_dev uuid; v_dev_name text := ''; v_now timestamptz; v_at timestamptz;
        v_row public.uid_block_scans; v_result text; v_released_at timestamptz; v_wms_status text;
begin
  v_access := public.floor_access_check(p_access_token, 'uid_block_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;

  v_code := btrim(p_group_uid);
  if v_code is null or v_code !~ '^[0-9]{16}$' then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_GROUP_UID','message','Group UID phải đúng 16 chữ số')));
  end if;
  if p_list_id is null then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LIST','message','Thiếu mã danh sách UID blocked')));
  end if;

  perform pg_advisory_xact_lock_shared(hashtext('public.uid_block_import'));
  select l.id into v_list
    from public.uid_block_lists l
   order by l.imported_at desc, l.id desc
   limit 1;
  if v_list is null then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_LIST','message','Chưa có danh sách UID blocked')));
  end if;
  if v_list <> p_list_id then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','STALE_LIST',
      'message','Danh sách UID blocked đã đổi, đang tải danh sách mới','data',jsonb_build_object('listId',v_list))));
  end if;
  select i.released_at, i.wms_status into v_released_at, v_wms_status
    from public.uid_block_items i where i.list_id = v_list and i.group_uid_code = v_code;
  if not found then
    return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object('result','not_blocked','groupUid',v_code),
      'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
  end if;

  v_now := clock_timestamp();
  v_at := case when p_scanned_at between v_now - interval '2 days' and v_now + interval '5 minutes'
               then least(p_scanned_at, v_now) else v_now end;

  if v_released_at is not null and v_at > v_released_at then
    return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object(
      'result','not_blocked','groupUid',v_code,'released',true,'wmsStatus',v_wms_status,'releasedAt',v_released_at),
      'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
  end if;

  v_dev := public.print_device_by_token(p_access_token);
  if v_dev is not null then
    select left(d.name, 60) into v_dev_name from public.print_devices d where d.id = v_dev;
    v_dev_name := coalesce(v_dev_name, '');
  end if;

  insert into public.uid_block_scans(list_id, group_uid_code, scanned_at, device_id, device_name)
  values (v_list, v_code, v_at, v_dev, v_dev_name)
  on conflict (list_id, group_uid_code) do nothing
  returning * into v_row;
  if found then
    v_result := 'new';
  else
    v_result := 'dup';
    select * into v_row from public.uid_block_scans s where s.list_id = v_list and s.group_uid_code = v_code;
  end if;

  return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object(
    'result',v_result,'groupUid',v_code,'scannedAt',v_row.scanned_at,'deviceName',coalesce(v_row.device_name,''),
    'mine',(v_row.device_id is not null and v_dev is not null and v_row.device_id = v_dev)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
end$$;

-- Quyền: thân nạp, hàm dựng, refresh chỉ chủ sở hữu (pg_cron chạy bằng chủ sở hữu); ba hàm công khai giữ quyền cũ.
revoke all on function public._uid_block_import_body(jsonb,jsonb,uuid) from public, anon, authenticated;
revoke all on function public._uid_block_build_wms(text[],uuid) from public, anon, authenticated;
revoke all on function public.uid_block_refresh_wms() from public, anon, authenticated;
revoke all on function public.uid_block_import(jsonb,jsonb) from public, anon;
grant execute on function public.uid_block_import(jsonb,jsonb) to authenticated;
revoke all on function public.uid_block_import_wms(text[]) from public, anon;
grant execute on function public.uid_block_import_wms(text[]) to authenticated;
revoke all on function public.uid_block_snapshot(uuid) from public;
grant execute on function public.uid_block_snapshot(uuid) to anon, authenticated;
revoke all on function public.uid_block_scan(text,uuid,text,timestamptz) from public;
grant execute on function public.uid_block_scan(text,uuid,text,timestamptz) to anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
-- Mỗi 30 phút (giờ :00 và :30). Cùng tên thì pg_cron cập nhật lịch cũ.
select cron.schedule('uid-block-refresh-wms', '*/30 * * * *', $$select public.uid_block_refresh_wms()$$);

commit;
notify pgrst, 'reload schema';
