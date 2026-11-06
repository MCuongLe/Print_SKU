-- Xoá dòng mục "Ngoài đợt xả" (06/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md mục "Đợt 6").
--
-- Vì sao: người dùng (06/11) "Ngoài đợt xả có nút xóa giúp tôi." — bảng xa_vai_it_reports (UID khác SKU bị chặn khi có đợt mở) chưa có đường dọn
-- nào từ xa_vai_it_v2 (xoá / đóng đợt không đụng tới), số đếm mục Bất thường chỉ tăng.
--
-- Tác động:
--   * Hàm mới xa_vai_it_report_delete(p_items jsonb) — Admin (print_admin_allowed): p_items = [{ groupUid, lastAt }] (1–2.000 dòng, lastAt = giờ quét
--     cuối web đang thấy, nguyên văn từ xa_vai_it_outside). Chỉ xoá dòng có last_at KHỚP: UID vừa được quét lại sau khi Admin tải danh sách (upsert
--     đổi last_at / scan_count) thì giữ nguyên để Admin xem lượt mới (review 06/11: Codex + Claude A/BC). timestamptz qua JSON giữ đủ micro giây
--     (đo 06/11: to_jsonb → ::timestamptz bằng nhau). Trả { deleted, requested, stale } — stale = dòng đã đổi hoặc đã bị xoá trước.
--     Bản nháp p_uids text[] (commit a6caf8f) CHƯA từng chạy (kiểm pg_proc 06/11: không có hàm) → không cần drop; -- kiem xác nhận không có overload.
--     Không đụng xa_vai_it_uids (mục "Ngoài phiếu · gắn vào đợt"), xa_vai_measures. UID quét lại sau khi xoá thì máy chủ ghi dòng mới như lần đầu.
--   Phân loại: thêm hàm (không đổi hàm / bảng có sẵn).
-- Không DROP / DELETE ở cấp cao nhất → không cần --allow-destructive. Chạy lại được (create or replace).
-- Thứ tự lên: commit (chưa push) → migration này → push web (nút Xoá ở mục Ngoài đợt xả; web cũ không gọi hàm này).
-- Kiểm cục bộ: node tests/xa_vai_it_report_delete_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_it_report_delete_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_it_report_delete_v1.sql
-- kiem: select to_regprocedure('public.xa_vai_it_report_delete(jsonb)') is not null and has_function_privilege('authenticated', 'public.xa_vai_it_report_delete(jsonb)', 'execute') and not has_function_privilege('anon', 'public.xa_vai_it_report_delete(jsonb)', 'execute') and position('print_admin_allowed' in pg_get_functiondef('public.xa_vai_it_report_delete(jsonb)'::regprocedure)) > 0 and position('r.last_at = w.seen_at' in pg_get_functiondef('public.xa_vai_it_report_delete(jsonb)'::regprocedure)) > 0 and to_regprocedure('public.xa_vai_it_report_delete(text[])') is null
-- Rút lui (kèm --allow-destructive): drop function if exists public.xa_vai_it_report_delete(jsonb);
begin;

create or replace function public.xa_vai_it_report_delete(p_items jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_req integer;
  v_n integer;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xoá mục Ngoài đợt xả'));
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 2000
     or exists (select 1 from jsonb_array_elements(p_items) e
                 where jsonb_typeof(e) <> 'object' or nullif(btrim(coalesce(e->>'groupUid', '')), '') is null or length(btrim(e->>'groupUid')) > 40
                    or coalesce(e->>'lastAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Danh sách dòng cần xoá không hợp lệ (1 đến 2.000 dòng)'));
  end if;
  begin
    with want as (
      select distinct on (btrim(e->>'groupUid')) btrim(e->>'groupUid') as code, (e->>'lastAt')::timestamptz as seen_at
        from jsonb_array_elements(p_items) e
       order by btrim(e->>'groupUid')
    ), d as (
      delete from public.xa_vai_it_reports r using want w
       where r.group_uid_code = w.code and r.last_at = w.seen_at
      returning 1
    )
    select (select count(*)::integer from want), (select count(*)::integer from d) into v_req, v_n;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Giờ quét cuối không hợp lệ'));
  end;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('deleted', v_n, 'requested', v_req, 'stale', v_req - v_n),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public.xa_vai_it_report_delete(jsonb) from public, anon, authenticated;
grant execute on function public.xa_vai_it_report_delete(jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';
