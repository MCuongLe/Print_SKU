-- LỊCH SỬ GROUP UID · file Excel tải xuống thêm Lot và Roll (27/10/2026, người dùng: "file excel tải xuống tôi cần thêm số roll số lot").
-- Vì sao: bảng lượt chuyển (group_uid_moves) chỉ có mã UID, kho, vị trí, người chuyển; lot / roll nằm ở group_uid_details
--   (batch_code, roll_code) mà group_uid_moves_lookup đã LEFT JOIN sẵn để lấy SKU.
-- Tác động:
--   * group_uid_moves_lookup (bản đang chạy = backend_hygiene_v1.sql, đã che email người chuyển cho người ngoài Admin; đối chiếu
--     với pg_get_functiondef trên Supabase 27/10/2026) trả thêm hai khoá mỗi dòng: lot (batch_code) và roll (roll_code); null khi
--     UID chưa có trong group_uid_details. Mọi khoá cũ, quyền Admin / che email, bộ lọc, thứ tự, giới hạn giữ nguyên.
--   * create or replace cùng chữ ký (không DROP); quyền ghi lại đúng như đang chạy: anon + authenticated thực thi (hàm chỉ đọc).
--     Chạy lại nhiều lần được.
-- Thứ tự lên: migration này → push web (web mới lên trước migration vẫn chạy, hai cột Lot / Roll trong file Excel để trống).
-- Kiểm cục bộ: node tests/group_uid_moves_lot_roll_sql.cjs; python scripts/apply_supabase_sql.py supabase/group_uid_moves_lot_roll_v1.sql --dry-run
-- Lệnh: python scripts/apply_supabase_sql.py supabase/group_uid_moves_lot_roll_v1.sql
-- kiem: select position('batch_code' in pg_get_functiondef('public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure)) > 0 and position('roll_code' in pg_get_functiondef('public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure)) > 0 and position('group_uid_admin_allowed' in pg_get_functiondef('public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure)) > 0 and has_function_privilege('anon', 'public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure, 'execute') and has_function_privilege('authenticated', 'public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure, 'execute') and not has_function_privilege('public', 'public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)'::regprocedure, 'execute') as ok
-- Rút lui (web vẫn chạy, chỉ mất hai cột Lot / Roll trong file Excel):
--   chỉ chép hàm group_uid_moves_lookup (dòng 489–532) trong supabase/backend_hygiene_v1.sql rồi chạy; KHÔNG chạy cả tệp đó (sẽ lùi cut_group_uid_reconcile và uid_temp_overview đã được cut_source_v1 / uid_temp_origin_v1 đổi)
begin;

create or replace function public.group_uid_moves_lookup(
  p_warehouse text default '', p_location text default '', p_match text default 'to', p_sku text default '',
  p_from timestamptz default null, p_to timestamptz default null, p_limit integer default 1000
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_wh text := btrim(coalesce(p_warehouse,'')); v_loc text := btrim(coalesce(p_location,'')); v_sku text := btrim(coalesce(p_sku,''));
  v_match text := case when p_match in ('to','from','any') then p_match else 'to' end;
  v_limit integer := least(greatest(coalesce(p_limit,1000),1),5000);
  v_loc_like text; v_sku_like text; v_total integer; v_items jsonb;
  v_admin boolean := public.group_uid_admin_allowed();
begin
  v_loc_like := '%' || replace(replace(replace(v_loc, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  v_sku_like := '%' || replace(replace(replace(v_sku, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  with ranked as (
    select m.*, lead(m.to_location) over w as next_location, lead(m.moved_at) over w as next_at
      from public.group_uid_moves m
    window w as (partition by m.group_uid_code order by m.moved_at, m.history_id)
  ), hit as (
    select r.history_id, r.group_uid_code, r.warehouse, r.from_location, r.to_location, r.moved_by, r.moved_at,
           r.next_location, r.next_at, count(*) over () as total_rows
      from ranked r
     where (v_wh = '' or r.warehouse = v_wh)
       and (p_from is null or r.moved_at >= p_from)
       and (p_to is null or r.moved_at < p_to)
       and (v_loc = '' or (v_match in ('to','any') and r.to_location ilike v_loc_like)
                       or (v_match in ('from','any') and r.from_location ilike v_loc_like))
       and (v_sku = '' or exists (select 1 from public.group_uid_details d where d.group_uid_code = r.group_uid_code and d.sku ilike v_sku_like)
                       or exists (select 1 from public.group_uid_products p where p.group_uid_code = r.group_uid_code and p.sku ilike v_sku_like))
  ), page as (
    select * from hit order by moved_at desc, history_id desc limit v_limit
  )
  select coalesce(max(q.total_rows),0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id',q.history_id,'uid',q.group_uid_code,'warehouse',q.warehouse,'from',q.from_location,'to',q.to_location,
           'by',case when v_admin then q.moved_by else split_part(q.moved_by,'@',1) end,'at',q.moved_at,'nextLocation',q.next_location,'nextAt',q.next_at,
           'sku',coalesce(d.sku,(select string_agg(s.sku,', ' order by s.sku) from (select p.sku from public.group_uid_products p where p.group_uid_code = q.group_uid_code order by p.sku limit 3) s)),
           'skuCount',case when d.sku is not null then 1 else (select count(*) from public.group_uid_products p where p.group_uid_code = q.group_uid_code) end,
           'lot',d.batch_code,'roll',d.roll_code,
           'product',(select p.product_name from public.group_uid_products p where p.group_uid_code = q.group_uid_code order by p.sku limit 1)
         ) order by q.moved_at desc, q.history_id desc),'[]'::jsonb)
    into v_total, v_items
    from page q left join public.group_uid_details d on d.group_uid_code = q.group_uid_code;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items,'total',v_total,'limit',v_limit,'truncated',v_total > v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
