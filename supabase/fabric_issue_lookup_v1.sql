-- TRỢ LÝ IN → PACKING LIST CẤP VẢI: tra một loạt Group UID (24/10/2026, đợt 1 — docs/plans/2026-10-24-tro-ly-in-tao-pl.md).
-- Vì sao: Trợ lý in dựng Packing List cấp vải từ danh sách Group UID (Excel/CSV/chữ dán). Số liệu (SKU, lot, roll, số lượng,
--   vị trí, trạng thái) phải lấy từ group_uid_details chứ không lấy từ chữ dán; thẻ xem trước cần biết cuộn đã thuộc đợt cấp vải
--   nào (đã quét cấp chưa) và đợt đang mở có cùng SKU (gợi ý tên đợt bổ sung / style / PO).
-- Tác động: thêm 1 hàm chỉ đọc public.fabric_issue_lookup_uids(text[]) — chỉ Admin (group_uid_admin_allowed), không bảng mới,
--   không đổi hàm cũ. Tạo đợt vẫn đi qua fabric_issue_import có sẵn.
-- Chạy: python scripts/apply_supabase_sql.py supabase/fabric_issue_lookup_v1.sql
begin;

create or replace function public.fabric_issue_lookup_uids(p_codes text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_codes text[];
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được tra Group UID cho Packing List'));
  end if;
  if p_codes is null or cardinality(p_codes) not between 1 and 1000
     or exists (select 1 from unnest(p_codes) c where c is null or c !~ '^[0-9]{10,40}$') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Cần 1–1.000 Group UID, mỗi mã 10–40 chữ số'));
  end if;
  select array_agg(distinct c) into v_codes from unnest(p_codes) c;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    -- Group UID có trên hệ thống (bản đồng bộ WMS); qty theo đơn vị của SKU (đuôi tên sản phẩm, vd. "/mm")
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uid', g.group_uid_code, 'sku', g.sku, 'lot', g.batch_code, 'roll', g.roll_code, 'qty', g.qty,
               'warehouse', g.warehouse, 'location', g.location, 'status', g.status, 'qcStatus', g.qc_status, 'po', g.purchase_order)
             order by g.group_uid_code)
        from public.group_uid_details g
       where g.group_uid_code = any(v_codes)), '[]'::jsonb),
    'missing', coalesce((
      select jsonb_agg(c order by c)
        from unnest(v_codes) c
       where not exists (select 1 from public.group_uid_details g where g.group_uid_code = c)), '[]'::jsonb),
    'products', coalesce((
      select jsonb_object_agg(s.sku, s.product_name)
        from public."SKU_Name" s
       where s.sku in (select g.sku from public.group_uid_details g where g.group_uid_code = any(v_codes))), '{}'::jsonb),
    -- Cuộn đã được ghép vào đợt cấp vải nào (scannedAt khác null = đã quét cấp)
    'inPlans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uid', l.group_uid_code, 'planId', p.id, 'planName', p.name, 'planStatus', p.status, 'scannedAt', l.scanned_at)
             order by p.created_at desc)
        from public.fabric_issue_lines l
        join public.fabric_issue_plans p on p.id = l.plan_id
       where l.group_uid_code = any(v_codes)), '[]'::jsonb),
    -- Đợt đang mở có cùng SKU: gợi ý tên đợt bổ sung, style, PO
    'openPlans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'styleNo', p.style_no, 'poNo', p.po_no, 'createdAt', p.created_at,
               'skus', (select jsonb_agg(distinct l.sku) from public.fabric_issue_lines l
                         where l.plan_id = p.id
                           and l.sku in (select g.sku from public.group_uid_details g where g.group_uid_code = any(v_codes))))
             order by p.created_at desc)
        from public.fabric_issue_plans p
       where p.status = 'open'
         and exists (select 1 from public.fabric_issue_lines l
                      where l.plan_id = p.id
                        and l.sku in (select g.sku from public.group_uid_details g where g.group_uid_code = any(v_codes)))), '[]'::jsonb)
  ));
end$$;

revoke all on function public.fabric_issue_lookup_uids(text[]) from public, anon, authenticated;
grant execute on function public.fabric_issue_lookup_uids(text[]) to authenticated;

commit;
notify pgrst, 'reload schema';
