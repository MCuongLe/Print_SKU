-- Cắt lại Group UID đã cắt để retest (09/11/2026, người dùng yêu cầu "UID đã cắt rồi có thể cắt lại để retest").
-- Vì sao: cut_group_uids khoá chính group_uid_code, _cut_group_uid_scan_body trả ALREADY_CUT cho UID đã có dòng nên UID cắt test
--   lần 2 (retest) không ghi được lần cắt mới, không in lại tem theo lần cắt mới và Đối chiếu ADJ vẫn so với giờ cắt lần đầu.
-- Tác động:
--   * Bảng mới cut_group_uid_recuts: mỗi lần cắt lại chép nguyên dòng cũ (row_data jsonb) + máy (print_device_id) + giờ cắt lại.
--     Chỉ service_role đọc / ghi (như cut_group_uid_deletions).
--   * Hàm mới cut_group_uid_recut(p_access_token, p_group_uid, p_cut_at): kiểm khoá máy (floor_access_check, nhãn
--     'cut_group_uid_recut') rồi gọi thân _cut_group_uid_recut_body. Thân khoá dòng (for update), chỉ cắt lại khi cut_at hiện tại
--     đúng bằng p_cut_at web vừa thấy (bấm hai lần / hai máy cùng bấm → RECUT_STALE, không cắt lại hai lần); tem đang queued → PRINT_QUEUED;
--     đọc lại SKU / tên / Lot / Roll / PO từ group_uid_details như lúc quét (thiếu → GROUP_UID_NOT_READY); ghi lịch sử rồi đặt lại dòng:
--     cut_at = now(), print_status = 'pending' (tem chờ chọn in lại ở Tra cứu), xoá print_job_id / queued_at / printed_at và trạng thái
--     ADJ (adj_exported_at, adj_resolved_at, adj_resolved_state) vì lần cắt mới cần tick ADJ mới; Đối chiếu ADJ tự so Cut WMS từ giờ mới.
--   * Không đổi hàm cũ, không đổi khoá chính; _cut_group_uid_scan_body vẫn trả ALREADY_CUT (web hiện nút Cắt lại). Phiên Theo PO giữ nguyên.
--   * Không DROP / DELETE → không cần --allow-destructive; chạy lại được.
-- Thứ tự lên: migration này → push web (web gọi cut_group_uid_recut). Không đụng Extension / Edge.
-- Kiểm cục bộ: node tests/cut_group_uid_recut_sql.cjs; python scripts/apply_supabase_sql.py supabase/cut_group_uid_recut_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/cut_group_uid_recut_v1.sql
-- kiem: select to_regclass('public.cut_group_uid_recuts') is not null and to_regprocedure('public.cut_group_uid_recut(text,text,timestamptz)') is not null and has_function_privilege('anon', 'public.cut_group_uid_recut(text,text,timestamptz)', 'execute') and not has_function_privilege('anon', 'public._cut_group_uid_recut_body(text,text,timestamptz)', 'execute') and not has_table_privilege('anon', 'public.cut_group_uid_recuts', 'select') as ok
-- Rút lui (web mới gọi hàm thiếu thì báo lỗi ở nút Cắt lại, quét cắt thường vẫn chạy):
--   drop function if exists public.cut_group_uid_recut(text, text, timestamptz); drop function if exists public._cut_group_uid_recut_body(text, text, timestamptz);
--   Bảng lịch sử giữ lại được; muốn bỏ hẳn: drop table if exists public.cut_group_uid_recuts;
begin;

create table if not exists public.cut_group_uid_recuts (
  id bigint generated always as identity primary key,
  group_uid_code text not null,
  row_data jsonb not null,
  print_device_id uuid,
  recut_at timestamptz not null default now()
);
create index if not exists cut_group_uid_recuts_code_idx on public.cut_group_uid_recuts (group_uid_code, recut_at desc);
alter table public.cut_group_uid_recuts enable row level security;
revoke all on public.cut_group_uid_recuts from public, anon, authenticated;
grant select, insert on public.cut_group_uid_recuts to service_role;

create or replace function public._cut_group_uid_recut_body(p_access_token text, p_group_uid text, p_cut_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text; v_source record; v_existing public.cut_group_uids; v_row public.cut_group_uids;
begin
  v_code := nullif(btrim(p_group_uid), '');
  if v_code is null or length(v_code) > 40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_GROUP_UID', 'message', 'Group UID cần từ 1 đến 40 ký tự'));
  end if;
  select c.* into v_existing from public.cut_group_uids c where c.group_uid_code = v_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_CUT', 'message', 'Group UID chưa cắt. Quét lại để cắt.'));
  end if;
  if p_cut_at is null or v_existing.cut_at is distinct from p_cut_at then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'RECUT_STALE', 'message', 'Group UID này vừa được cắt lại trên thiết bị khác',
      'data', jsonb_build_object('groupUid', v_existing.group_uid_code, 'sku', v_existing.sku, 'status', v_existing.print_status, 'cutAt', v_existing.cut_at)));
  end if;
  if v_existing.print_status = 'queued' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PRINT_QUEUED', 'message', 'Tem của Group UID này đang chờ máy in. Chờ in xong rồi cắt lại.'));
  end if;
  select g.group_uid_code, btrim(coalesce(g.sku, '')) sku,
         btrim(coalesce(s.product_name, '')) product_name,
         btrim(coalesce(g.batch_code, '')) lot, btrim(coalesce(g.roll_code, '')) roll,
         (s.sku is not null and s.status is distinct from '1') as sku_inactive,
         g.purchase_order as po
    into v_source
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku = g.sku
   where g.group_uid_code = v_code;
  if not found or v_source.sku = '' or v_source.product_name = '' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'GROUP_UID_NOT_READY', 'message', 'Group UID chưa có đủ dữ liệu. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  insert into public.cut_group_uid_recuts (group_uid_code, row_data, print_device_id)
  values (v_existing.group_uid_code, to_jsonb(v_existing), public.print_device_by_token(p_access_token));
  update public.cut_group_uids c
     set sku = v_source.sku, product_name = v_source.product_name,
         lot = left(v_source.lot, 20), roll = left(v_source.roll, 20), po = v_source.po,
         print_status = 'pending', print_job_id = null, cut_at = now(), queued_at = null, printed_at = null,
         adj_exported_at = null, adj_resolved_at = null, adj_resolved_state = null, updated_at = now()
   where c.group_uid_code = v_code
  returning c.* into v_row;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'groupUid', v_row.group_uid_code, 'sku', v_row.sku, 'productName', v_row.product_name,
    'lot', v_row.lot, 'roll', v_row.roll, 'printStatus', v_row.print_status, 'cutAt', v_row.cut_at,
    'skuInactive', v_source.sku_inactive, 'previousCutAt', v_existing.cut_at,
    'recutCount', (select count(*) from public.cut_group_uid_recuts r where r.group_uid_code = v_code)),
    'meta', jsonb_build_object('updatedAt', v_row.updated_at, 'schemaVersion', 1));
end $$;

create or replace function public.cut_group_uid_recut(p_access_token text, p_group_uid text, p_cut_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_recut');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_recut_body(p_access_token, p_group_uid, p_cut_at));
end $$;

revoke all on function public._cut_group_uid_recut_body(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.cut_group_uid_recut(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cut_group_uid_recut(text, text, timestamptz) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
