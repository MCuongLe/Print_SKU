-- LỰA UID BLOCKED: lấy danh sách từ dữ liệu Group UID đã đồng bộ WMS (21/10/2026).
--
-- Vì sao: người dùng 21/10 — "Cập nhật lại dữ liệu group UID bị blocked của 2 kho WH-Material-MTG và Garment, dữ liệu file excel
-- bỏ qua". Tệp Excel 19/10 chỉ có kho MTG (727 UID) nên 24 UID Blocked của kho Garment bị sót. Nguồn mới = public.group_uid_details
-- (đồng bộ WMS qua Extension, lượt toàn bộ mỗi đêm + gia tăng 30 phút): mọi UID có status Blocked ở các kho được chọn.
--
-- uid_block_import_wms(p_warehouses text[]) — chỉ Admin (kiểm ngay đầu và lại trong uid_block_import): dựng danh sách
-- (Group UID, SKU, tên hàng theo "SKU_Name", Lot = batch_code, Roll = roll_code, kho, vị trí, trạng thái WMS) rồi nạp qua
-- public.uid_block_import — giữ nguyên mọi quy tắc đã có: khoá nạp tuần tự, giữ 5 danh sách, chép lượt đã quét của UID còn trong
-- danh sách mới (carriedScans). Tên danh sách: "WMS Blocked · <kho> · dd/mm HH:MI" (giờ Việt Nam).
--
-- Tác động: chỉ THÊM 1 hàm, không đổi bảng/hàm cũ, không drop. Cần có trước: uid_block_v1, group_uid_rfid_v1 (không bắt buộc).
-- Chạy migration TRƯỚC khi push index.html (nút "Lấy từ WMS" gọi hàm này).
-- Chạy: python scripts/apply_supabase_sql.py supabase/uid_block_wms_v1.sql
begin;

create or replace function public.uid_block_import_wms(p_warehouses text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_wh text[]; v_items jsonb; v_count integer; v_name text;
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'groupUid', g.group_uid_code,
           'sku', left(g.sku, 300),
           'productName', left(n.product_name, 300),
           'lot', left(g.batch_code, 300),
           'roll', left(g.roll_code, 300),
           'warehouse', left(g.warehouse, 300),
           'location', left(g.location, 300),
           'fileStatus', left(g.status, 300))
         order by g.warehouse, g.location, g.group_uid_code), '[]'::jsonb),
         count(*)
    into v_items, v_count
    from public.group_uid_details g
    left join lateral (select s.product_name from public."SKU_Name" s where s.sku = g.sku limit 1) n on true
   where g.status ilike 'blocked'
     and g.warehouse = any(v_wh)
     and g.group_uid_code ~ '^[0-9]{16}$';

  if v_count = 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_ROWS','message','Không có Group UID Blocked ở kho đã chọn'));
  end if;

  v_name := left('WMS Blocked · ' || array_to_string(v_wh, ' + ') || ' · '
                 || to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI'), 200);
  return public.uid_block_import(jsonb_build_object('fileName', v_name, 'sheets', to_jsonb(v_wh)), v_items);
end $$;

revoke all on function public.uid_block_import_wms(text[]) from public, anon;
grant execute on function public.uid_block_import_wms(text[]) to authenticated;

commit;
notify pgrst, 'reload schema';
