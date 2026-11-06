-- Xoá dòng mục "Ngoài đợt xả" (06/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md mục "Đợt 6").
--
-- Vì sao: người dùng (06/11) "Ngoài đợt xả có nút xóa giúp tôi." — bảng xa_vai_it_reports (UID khác SKU bị chặn khi có đợt mở) chưa có đường dọn
-- nào từ xa_vai_it_v2 (xoá / đóng đợt không đụng tới), số đếm mục Bất thường chỉ tăng.
--
-- Tác động:
--   * Hàm mới xa_vai_it_report_delete(p_uids text[]) — Admin (print_admin_allowed): xoá các dòng xa_vai_it_reports theo mã Group UID (1–2.000 mã,
--     bỏ trùng, mỗi mã ≤ 40 ký tự). Trả { deleted, requested }. UID bị quét lại khi còn đợt mở thì máy chủ ghi lại dòng mới như lần đầu.
--     Không đụng xa_vai_it_uids (mục "Ngoài phiếu · gắn vào đợt"), xa_vai_measures.
--   Phân loại: thêm hàm (không đổi hàm / bảng có sẵn).
-- Không DROP / DELETE ở cấp cao nhất → không cần --allow-destructive. Chạy lại được (create or replace).
-- Thứ tự lên: commit (chưa push) → migration này → push web (nút Xoá ở mục Ngoài đợt xả; web cũ không gọi hàm này).
-- Kiểm cục bộ: node tests/xa_vai_it_report_delete_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_it_report_delete_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_it_report_delete_v1.sql
-- kiem: select to_regprocedure('public.xa_vai_it_report_delete(text[])') is not null and has_function_privilege('authenticated', 'public.xa_vai_it_report_delete(text[])', 'execute') and not has_function_privilege('anon', 'public.xa_vai_it_report_delete(text[])', 'execute') and position('print_admin_allowed' in pg_get_functiondef('public.xa_vai_it_report_delete(text[])'::regprocedure)) > 0
-- Rút lui (kèm --allow-destructive): drop function if exists public.xa_vai_it_report_delete(text[]);
begin;

create or replace function public.xa_vai_it_report_delete(p_uids text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uids text[];
  v_n integer;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xoá mục Ngoài đợt xả'));
  end if;
  if p_uids is null or exists (select 1 from unnest(p_uids) x where nullif(btrim(coalesce(x, '')), '') is null or length(btrim(x)) > 40) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Danh sách Group UID không hợp lệ'));
  end if;
  select coalesce(array_agg(distinct btrim(x)), '{}'::text[]) into v_uids from unnest(p_uids) x;
  if cardinality(v_uids) not between 1 and 2000 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Mỗi lần xoá 1 đến 2.000 dòng'));
  end if;
  with d as (delete from public.xa_vai_it_reports r where r.group_uid_code = any(v_uids) returning 1)
  select count(*)::integer into v_n from d;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('deleted', v_n, 'requested', cardinality(v_uids)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public.xa_vai_it_report_delete(text[]) from public, anon, authenticated;
grant execute on function public.xa_vai_it_report_delete(text[]) to authenticated;

commit;

notify pgrst, 'reload schema';
