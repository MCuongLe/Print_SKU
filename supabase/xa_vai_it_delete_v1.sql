-- Xoá đợt xả theo phiếu IT (06/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md mục "Đợt 5").
--
-- Vì sao: người dùng (06/11) "SWSH02 IT 1007261104006916 xóa giúp tôi đợt xả vải này và build tính năng xóa phiếu IT."
--
-- Tác động:
--   * Hàm mới xa_vai_it_delete(p_it_number) — Admin (print_admin_allowed): khoá dòng đợt (cùng khoá với _xa_vai_it_attach_core, nên lượt gắn UID
--     đang chạy xong trước hoặc thấy đợt đã mất), xoá đợt; danh sách UID của đợt (xa_vai_it_uids, cả UID gắn khi quét) xoá theo FK on delete cascade.
--     KHÔNG đụng xa_vai_measures (mét đã đo, trạng thái in, lệnh in) — UID đã đo thành UID tự do; nạp lại phiếu IT tạo đợt mới như lần đầu.
--     Trả { itNumber, itemCode, uidCount, measuredCount } để web báo.
--   Phân loại: thêm hàm (không đổi hàm / bảng có sẵn).
-- Không DROP / DELETE ở cấp cao nhất → không cần --allow-destructive. Chạy lại được (create or replace).
-- Thứ tự lên: commit (chưa push) → migration này → push web (nút Xoá ở tab Phiếu IT; web cũ không gọi hàm này).
-- Kiểm cục bộ: node tests/xa_vai_it_delete_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_it_delete_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_it_delete_v1.sql
-- kiem: select to_regprocedure('public.xa_vai_it_delete(text)') is not null and has_function_privilege('authenticated', 'public.xa_vai_it_delete(text)', 'execute') and not has_function_privilege('anon', 'public.xa_vai_it_delete(text)', 'execute') and position('print_admin_allowed' in pg_get_functiondef('public.xa_vai_it_delete(text)'::regprocedure)) > 0 and position('on delete cascade' in lower((select pg_get_constraintdef(k.oid) from pg_constraint k where k.conname = 'xa_vai_it_uids_it_number_fkey'))) > 0
-- Rút lui (kèm --allow-destructive): drop function if exists public.xa_vai_it_delete(text);
begin;

create or replace function public.xa_vai_it_delete(p_it_number text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_it text := btrim(coalesce(p_it_number, ''));
  v_row public.xa_vai_it_batches;
  v_uids integer;
  v_measured integer;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xoá đợt xả'));
  end if;
  if v_it !~ '^[0-9]{16}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Số phiếu IT không hợp lệ'));
  end if;
  select b.* into v_row from public.xa_vai_it_batches b where b.it_number = v_it for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Không có đợt xả của phiếu IT này'));
  end if;
  select count(*)::integer, count(m.group_uid_code)::integer into v_uids, v_measured
    from public.xa_vai_it_uids u left join public.xa_vai_measures m on m.group_uid_code = u.group_uid_code
   where u.it_number = v_it;
  delete from public.xa_vai_it_batches where it_number = v_it;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('itNumber', v_row.it_number, 'itemCode', v_row.item_code,
    'uidCount', v_uids, 'measuredCount', v_measured),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public.xa_vai_it_delete(text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_delete(text) to authenticated;

commit;

notify pgrst, 'reload schema';
