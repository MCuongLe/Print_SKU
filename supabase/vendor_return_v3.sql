-- Trả nhà cung cấp v3 (26/10/2026, docs/plans/2026-10-24-tra-nha-cung-cap.md): Admin XOÁ đợt đang dùng.
-- Vì sao: người dùng "đăng nhập admin cho phép xóa đợt return vendor" (26/10/2026). Trước đó danh sách tạm chỉ được lead dọn tay
-- khi người dùng báo; nay Admin tự xoá ngay trên màn #tra-ncc. "Đợt" = một danh sách Admin nạp bằng Excel; màn chỉ hiện đợt
-- ĐANG DÙNG (active = true) nên hàm chỉ xoá đợt đó.
--   * vendor_return_delete(p_list_id) — chỉ Admin (group_uid_admin_allowed): p_list_id phải đúng là đợt đang dùng (web đang hiện).
--     Đợt đã đổi (Admin khác vừa nạp danh sách mới) → STALE_LIST + listId hiện hành, KHÔNG xoá gì; không còn đợt nào → NO_LIST.
--   * Dữ liệu quét xoá THEO đợt (có chủ ý): vendor_return_items và vendor_return_scans đều tham chiếu vendor_return_lists
--     ON DELETE CASCADE, lượt quét cũng không thể tồn tại nếu thiếu dòng danh sách (khoá ngoại tới items); không có màn nào xem lại
--     đợt đã tắt hay lượt quét mồ côi. Hàm trả số dòng + số lượt quét đã xoá để web báo kết quả.
--   * Cùng advisory lock độc quyền với vendor_return_import: chờ các lượt quét / đối chiếu đang chạy (khoá chia sẻ) xong rồi mới xoá;
--     lượt quét đến sau đó thấy NO_LIST (web tải lại, hiện "Chưa có danh sách").
--   * Chỉ authenticated (phiên đăng nhập Admin) được gọi; anon (máy quét, khách) không có quyền thực thi. Máy kích hoạt không
--     thành Admin: nếu có phiên đăng nhập nhưng không phải Admin → FORBIDDEN từ group_uid_admin_allowed().
-- Tác động: thêm MỘT hàm, không đổi bảng / hàm cũ, không drop. Hàm chứa delete from nhưng chỉ chạy khi Admin gọi; apply_supabase_sql.py
-- bỏ qua thân hàm nên không cần --allow-destructive. Danh sách tắt từ các lần nạp thay thế (active = false) không bị đụng.
-- Chạy migration TRƯỚC khi push index.html (web gọi vendor_return_delete). Cần có trước: vendor_return_v1.
-- Kiểm cục bộ: node tests/vendor_return_v3_sql.cjs; python scripts/apply_supabase_sql.py supabase/vendor_return_v3.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/vendor_return_v3.sql
begin;

create or replace function public.vendor_return_delete(p_list_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_active uuid; v_items integer; v_scans integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xoá đợt trả nhà cung cấp'));
  end if;
  if p_list_id is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LIST','message','Thiếu mã danh sách trả nhà cung cấp'));
  end if;
  -- Khoá độc quyền chung với vendor_return_import: quét / đối chiếu đang chạy (khoá chia sẻ) xong rồi mới xoá.
  perform pg_advisory_xact_lock(hashtext('public.vendor_return_import'));
  select l.id into v_active from public.vendor_return_lists l where l.active limit 1;
  if v_active is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_LIST','message','Chưa có danh sách trả nhà cung cấp (có thể đã bị xoá)'));
  end if;
  if p_list_id <> v_active then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','STALE_LIST','message','Danh sách trả nhà cung cấp đã đổi, chưa xoá gì',
                                                                    'data',jsonb_build_object('listId',v_active)));
  end if;

  select count(*)::integer into v_items from public.vendor_return_items i where i.list_id = v_active;
  select count(*)::integer into v_scans from public.vendor_return_scans s where s.list_id = v_active;
  delete from public.vendor_return_lists where id = v_active;   -- dòng + lượt quét xoá theo (ON DELETE CASCADE)

  return jsonb_build_object('ok',true,'data',jsonb_build_object('deleted',true,'listId',v_active,'items',v_items,'scans',v_scans),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;
revoke all on function public.vendor_return_delete(uuid) from public, anon, authenticated;
grant execute on function public.vendor_return_delete(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
