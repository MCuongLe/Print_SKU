-- LỊCH SỬ GROUP UID · tiến độ dán mã RFID A5000 theo bin (28/10/2026, người dùng: "modul tiến độ dán mã A5000 của kho MTG và Garment,
--   tiến độ thể hiện % theo bin, sắp xếp theo dãy kệ"; chốt: % = A5000 / UID đang tồn, mã RFID khác (A3000) hiện riêng, không tính là xong).
-- Hàm mới group_uid_rfid_progress() chỉ ĐỌC group_uid_details (bản chụp WMS trên Supabase) + group_uid_sync_state (mốc đồng bộ):
--   * kho: WH - MATERIAL - MTG → "MTG", WH - MATERIAL - GARMENT → "GARMENT" (luôn trả cả hai, kho chưa có UID thì racks rỗng);
--   * UID tồn = status Available / Blocked / Editing và qty > 0 (cuộn đã hết vải không cần dán; cùng phạm vi "Qty > 0" của trang
--     Tiến độ dán RFID của app kho vật tư may, dò 28/10/2026 — trang đó còn lọc Type = Fabric Roll, group_uid_details không lưu Type nên chưa lọc được);
--     chỉ vị trí dạng <tầng>-KHO-<dãy kệ>-<khoang>-<tầng kệ>-<ô> (đoạn thứ 3 = dãy kệ, cả vị trí là bin; web tách khoang / tầng kệ để vẽ lưới);
--     UID ở vị trí ngoài kệ (A0, VR, BAIXE, CAT-QC, XV…) không vào tiến độ;
--   * done = group_rfid_mapping đúng dạng A5000 + 7 số (12 ký tự, 1 chữ + 11 số); other = có RFID mà không phải A5000;
--   * dãy kệ xếp số tăng dần (501, 507, 507A) rồi dãy chữ (BD, HM); bin xếp theo mã vị trí;
--   * không trả mã UID, SKU, tên người; chỉ số đếm theo kho / dãy / bin.
-- Hàm thứ hai group_uid_rfid_bin_uids(p_warehouse, p_locations) — pop-up khi bấm một bin: liệt kê Group UID tồn của bin (cùng phạm vi trên) CHƯA có A5000:
--   * state 'none' = chưa có RFID mapping (chưa dán), 'old' = còn mã RFID khác (A3000, phải tháo và dán lại); chưa dán xếp trước;
--   * p_warehouse 'MTG' | 'GARMENT'; p_locations 1–20 mã bin (ô lưới gộp nhiều bin cùng khoang + tầng); tối đa 500 dòng, `truncated` báo còn nữa;
--   * trả mã Group UID, SKU, lot, roll, qty, status, RFID (mã cũ), giờ cập nhật; không trả người cập nhật / email (cùng mức với group_uid_moves_lookup cho người ngoài Admin).
-- Quyền: anon + authenticated thực thi (màn xem, mọi người; cùng nhóm với group_uid_moves_lookup). Không đổi bảng, không DROP; chạy lại nhiều lần được.
-- Thứ tự lên: migration này → push web (web lên trước migration thì phần Tiến độ A5000 báo lỗi tải, phần lịch sử chuyển vị trí vẫn chạy).
-- Kiểm cục bộ: node tests/rfid_progress_sql.cjs; python scripts/apply_supabase_sql.py supabase/rfid_progress_v1.sql --dry-run
-- Lệnh: python scripts/apply_supabase_sql.py supabase/rfid_progress_v1.sql
-- kiem: select to_regprocedure('public.group_uid_rfid_progress()') is not null and has_function_privilege('anon', 'public.group_uid_rfid_progress()'::regprocedure, 'execute') and has_function_privilege('authenticated', 'public.group_uid_rfid_progress()'::regprocedure, 'execute') and not has_function_privilege('public', 'public.group_uid_rfid_progress()'::regprocedure, 'execute') and position('group_uid_details' in pg_get_functiondef('public.group_uid_rfid_progress()'::regprocedure)) > 0 and to_regprocedure('public.group_uid_rfid_bin_uids(text,text[])') is not null and has_function_privilege('anon', 'public.group_uid_rfid_bin_uids(text,text[])'::regprocedure, 'execute') and has_function_privilege('authenticated', 'public.group_uid_rfid_bin_uids(text,text[])'::regprocedure, 'execute') and not has_function_privilege('public', 'public.group_uid_rfid_bin_uids(text,text[])'::regprocedure, 'execute')
-- Rút lui (web vẫn chạy, chỉ phần Tiến độ A5000 và pop-up bin báo lỗi tải):
--   drop function if exists public.group_uid_rfid_progress();
--   drop function if exists public.group_uid_rfid_bin_uids(text, text[]);
begin;

create or replace function public.group_uid_rfid_progress()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_synced timestamptz; v_full timestamptz; v_other jsonb; v_warehouses jsonb;
begin
  select greatest(s.last_successful_incremental_at, s.last_successful_full_at), s.last_successful_full_at
    into v_synced, v_full from public.group_uid_sync_state s where s.singleton = true;

  with wh(name, label, ord) as (
    values ('WH - MATERIAL - MTG'::text, 'MTG'::text, 1), ('WH - MATERIAL - GARMENT'::text, 'GARMENT'::text, 2)
  ), base as (
    select d.warehouse, d.location, split_part(d.location, '-', 3) as rack,
           (d.group_rfid_mapping ~ '^A5000[0-9]{7}$') as is_done,
           (btrim(coalesce(d.group_rfid_mapping, '')) <> '' and d.group_rfid_mapping !~ '^A5000[0-9]{7}$') as is_other,
           left(d.group_rfid_mapping, 5) as prefix
      from public.group_uid_details d
     where d.warehouse in (select w.name from wh w)
       and d.status in ('Available', 'Blocked', 'Editing') and d.qty > 0
       and split_part(d.location, '-', 2) = 'KHO' and split_part(d.location, '-', 3) <> ''
  ), bins as (
    select b.warehouse, b.rack, b.location, count(*) as n_total, count(*) filter (where b.is_done) as n_done, count(*) filter (where b.is_other) as n_other
      from base b group by b.warehouse, b.rack, b.location
  ), racks as (
    select s.warehouse, s.rack, nullif(substring(s.rack from '^[0-9]+'), '')::integer as rack_no,
           sum(s.n_total)::integer as n_total, sum(s.n_done)::integer as n_done, sum(s.n_other)::integer as n_other,
           jsonb_agg(jsonb_build_object('location', s.location, 'total', s.n_total, 'done', s.n_done, 'other', s.n_other) order by s.location) as bins
      from bins s group by s.warehouse, s.rack
  ), per_wh as (
    select r.warehouse, sum(r.n_total)::integer as n_total, sum(r.n_done)::integer as n_done, sum(r.n_other)::integer as n_other,
           jsonb_agg(jsonb_build_object('rack', r.rack, 'total', r.n_total, 'done', r.n_done, 'other', r.n_other, 'bins', r.bins)
                     order by r.rack_no nulls last, r.rack) as racks
      from racks r group by r.warehouse
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', w.label, 'warehouse', w.name, 'total', coalesce(p.n_total, 0), 'done', coalesce(p.n_done, 0),
                                               'other', coalesce(p.n_other, 0), 'racks', coalesce(p.racks, '[]'::jsonb)) order by w.ord), '[]'::jsonb),
         (select coalesce(jsonb_agg(x.prefix order by x.prefix), '[]'::jsonb) from (select distinct b2.prefix from base b2 where b2.is_other) x)
    into v_warehouses, v_other
    from wh w left join per_wh p on p.warehouse = w.name;

  return jsonb_build_object('ok', true,
    'data', jsonb_build_object('prefix', 'A5000', 'otherPrefixes', v_other, 'syncedAt', v_synced, 'fullAt', v_full, 'warehouses', v_warehouses),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

revoke all on function public.group_uid_rfid_progress() from public, anon, authenticated;
grant execute on function public.group_uid_rfid_progress() to anon, authenticated;

create or replace function public.group_uid_rfid_bin_uids(p_warehouse text, p_locations text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_wh text := case upper(btrim(coalesce(p_warehouse, ''))) when 'MTG' then 'WH - MATERIAL - MTG' when 'GARMENT' then 'WH - MATERIAL - GARMENT' else null end;
  v_locs text[]; v_total integer; v_done integer; v_open integer; v_items jsonb; v_limit constant integer := 500;
begin
  select coalesce(array_agg(distinct btrim(x)) filter (where btrim(x) <> ''), '{}'::text[]) into v_locs from unnest(coalesce(p_locations, '{}'::text[])) x;
  if v_wh is null or cardinality(v_locs) < 1 or cardinality(v_locs) > 20 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Kho hoặc vị trí không hợp lệ'));
  end if;

  with scope as (
    select d.group_uid_code, d.location, d.sku, d.batch_code, d.roll_code, d.qty, d.status, d.updated_date,
           nullif(btrim(coalesce(d.group_rfid_mapping, '')), '') as rfid,
           coalesce(d.group_rfid_mapping ~ '^A5000[0-9]{7}$', false) as is_done
      from public.group_uid_details d
     where d.warehouse = v_wh and d.location = any(v_locs)
       and d.status in ('Available', 'Blocked', 'Editing') and d.qty > 0
       and split_part(d.location, '-', 2) = 'KHO' and split_part(d.location, '-', 3) <> ''
  ), open_rows as (
    select s.* from scope s where not s.is_done
  ), page as (
    select o.* from open_rows o order by (o.rfid is not null), o.location, o.group_uid_code limit v_limit
  )
  select (select count(*) from scope)::integer, (select count(*) from scope s where s.is_done)::integer, (select count(*) from open_rows)::integer,
         coalesce((select jsonb_agg(jsonb_build_object('groupUid', p.group_uid_code, 'location', p.location, 'sku', p.sku, 'lot', p.batch_code, 'roll', p.roll_code,
                                                       'qty', p.qty, 'status', p.status, 'rfid', p.rfid, 'state', case when p.rfid is null then 'none' else 'old' end,
                                                       'updatedAt', p.updated_date) order by (p.rfid is not null), p.location, p.group_uid_code) from page p), '[]'::jsonb)
    into v_total, v_done, v_open, v_items;

  return jsonb_build_object('ok', true,
    'data', jsonb_build_object('warehouse', upper(btrim(p_warehouse)), 'locations', to_jsonb(v_locs), 'total', v_total, 'done', v_done, 'open', v_open,
                               'items', v_items, 'limit', v_limit, 'truncated', v_open > v_limit),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

revoke all on function public.group_uid_rfid_bin_uids(text, text[]) from public, anon, authenticated;
grant execute on function public.group_uid_rfid_bin_uids(text, text[]) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
