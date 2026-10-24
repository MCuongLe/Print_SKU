-- Trả nhà cung cấp v2 (24/10/2026, docs/plans/2026-10-24-tra-nha-cung-cap.md): chia theo VỊ TRÍ HIỆN TẠI + nút Đối chiếu (đọc WMS).
-- Vì sao: người dùng "cần phân theo vị trí hiện tại của group" và "có nút đối chiếu… mục đích làm tất cả các group được chuyển về
-- F0-VR-00-00-00-00". Vị trí trong file Excel là lúc xuất; hàng được chuyển dần về F0-VR.
--   * vendor_return_items thêm wms_location / wms_status / wms_updated_at: vị trí + trạng thái Admin vừa đọc trực tiếp WMS (nút Đối
--     chiếu, qua Extension). Vị trí rỗng là dữ liệu thật (UID đã rời kho), không lùi về vị trí cũ.
--   * vendor_return_lists thêm reconciled_at / reconciled_by: lần đối chiếu gần nhất.
--   * vendor_return_reconcile(p_list_id, p_rows) — chỉ Admin: ghi vị trí đọc từ WMS cho mã thuộc danh sách đang dùng (giữ bản mới hơn).
--   * vendor_return_snapshot: nguồn = bản MỚI HƠN giữa lần đối chiếu (wms_updated_at) và Group UID đồng bộ tự động
--     (group_uid_details.updated_date); không có cả hai thì Excel. Trả currentLocation + status của đúng nguồn đó (rỗng giữ rỗng),
--     locationSource (wms / sync / file), warehouse, reconciledAt; sắp theo vị trí hiện tại. Web: status Canceled / Closed /
--     Transferred hoặc nguồn WMS không còn vị trí → nhóm "Đã rời kho" (người dùng chọn 24/10/2026), không tính "Về F0-VR".
-- Chỉ thêm cột (add column if not exists) và create or replace (giữ ACL hàm cũ). Không DROP, không xoá dữ liệu.
-- Chạy: python scripts/apply_supabase_sql.py supabase/vendor_return_v2.sql
begin;

alter table public.vendor_return_items
  add column if not exists wms_location text check (wms_location is null or length(wms_location) <= 300),
  add column if not exists wms_status text check (wms_status is null or length(wms_status) <= 100),
  add column if not exists wms_updated_at timestamptz;
alter table public.vendor_return_lists
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by uuid;

create or replace function public.vendor_return_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_list public.vendor_return_lists;
begin
  select * into v_list from public.vendor_return_lists l where l.active limit 1;
  if not found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('list',null,'items','[]'::jsonb),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'list', jsonb_build_object('id',v_list.id,'fileName',v_list.file_name,'createdAt',v_list.created_at,'itemCount',v_list.item_count,
                               'reconciledAt',v_list.reconciled_at),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('groupUid',x.group_uid_code,'color',x.color,'sku',x.sku,'productName',x.product_name,'lot',x.lot,
                                          'roll',x.roll,'location',x.location,'qty',x.qty,'scannedAt',x.scanned_at,'device',x.device_name,
                                          'currentLocation',x.cur,'status',x.cur_status,'locationSource',x.src,'warehouse',x.warehouse)
                       order by x.color, x.cur, x.group_uid_code)
        from (select y.*,
                     case y.src when 'wms' then y.wms_location when 'sync' then nullif(btrim(y.d_location),'') else y.location end as cur,
                     case y.src when 'wms' then y.wms_status when 'sync' then y.d_status end as cur_status
                from (select i.group_uid_code, i.color, i.sku, i.product_name, i.lot, i.roll, i.location, i.qty, s.scanned_at, s.device_name,
                             d.warehouse, i.wms_location, i.wms_status, d.location as d_location, d.status as d_status,
                             case when i.wms_updated_at is not null and (d.updated_date is null or i.wms_updated_at >= d.updated_date) then 'wms'
                                  when d.group_uid_code is not null then 'sync' else 'file' end as src
                        from public.vendor_return_items i
                        left join public.vendor_return_scans s on s.list_id = i.list_id and s.group_uid_code = i.group_uid_code
                        left join public.group_uid_details d on d.group_uid_code = i.group_uid_code
                       where i.list_id = v_list.id) y) x), '[]'::jsonb)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Admin ghi vị trí đọc trực tiếp WMS cho danh sách đang dùng. p_rows = [{groupUid, location, status, updatedAt}] (≤ 5.000; mã không
-- thuộc danh sách bị bỏ qua; location / status rỗng = WMS không có → lưu null). Giữ bản mới hơn theo updatedAt (đối chiếu chậm không đè
-- bản mới). updatedAt phải đọc được thành timestamptz và không quá 1 ngày sau giờ máy chủ (không để mốc tương lai chặn bản thật).
create or replace function public.vendor_return_reconcile(p_list_id uuid, p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_active uuid; v_bad integer; v_matched integer; v_at timestamptz := now();
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đối chiếu'));
  end if;
  -- Khoá chia sẻ như vendor_return_scan (v1): nạp danh sách (khoá độc quyền) không đổi danh sách đang dùng giữa lúc ghi đối chiếu.
  perform pg_advisory_xact_lock_shared(hashtext('public.vendor_return_import'));
  select l.id into v_active from public.vendor_return_lists l where l.active limit 1;
  if v_active is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_LIST','message','Chưa có danh sách trả'));
  end if;
  if p_list_id is distinct from v_active then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','STALE_LIST','message','Danh sách đã đổi, tải lại rồi đối chiếu','data',jsonb_build_object('listId',v_active)));
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Dữ liệu đối chiếu không hợp lệ (tối đa 5.000 dòng)'));
  end if;
  select count(*) into v_bad from jsonb_array_elements(p_rows) e(v)
   where jsonb_typeof(e.v) <> 'object'
      or jsonb_typeof(e.v->'groupUid') is distinct from 'string' or btrim(e.v->>'groupUid') !~ '^[0-9]{10,40}$'
      or not (e.v ? 'location') or not (e.v ? 'status')
      or jsonb_typeof(e.v->'location') not in ('string','null') or length(coalesce(e.v->>'location','')) > 300
      or jsonb_typeof(e.v->'status') not in ('string','null') or length(coalesce(e.v->>'status','')) > 100
      or jsonb_typeof(e.v->'updatedAt') is distinct from 'string' or (e.v->>'updatedAt') !~ '^\d{4}-\d{2}-\d{2}T'
      or case when pg_input_is_valid(e.v->>'updatedAt', 'timestamptz') then (e.v->>'updatedAt')::timestamptz > v_at + interval '1 day' else true end;
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message',format('Có %s dòng đối chiếu sai dạng',v_bad)));
  end if;
  with r as (
    select distinct on (btrim(e.v->>'groupUid')) btrim(e.v->>'groupUid') as code, nullif(btrim(e.v->>'location'),'') as loc,
           nullif(btrim(e.v->>'status'),'') as st, (e.v->>'updatedAt')::timestamptz as at
      from jsonb_array_elements(p_rows) e(v)
     order by btrim(e.v->>'groupUid'), (e.v->>'updatedAt')::timestamptz desc
  ), u as (
    update public.vendor_return_items i set wms_location = r.loc, wms_status = r.st, wms_updated_at = r.at
      from r
     where i.list_id = v_active and i.group_uid_code = r.code
       and (i.wms_updated_at is null or r.at > i.wms_updated_at
            or (r.at = i.wms_updated_at and (i.wms_location, i.wms_status) is distinct from (r.loc, r.st)))
    returning 1
  )
  select count(*) into v_matched from u;
  update public.vendor_return_lists set reconciled_at = greatest(reconciled_at, v_at), reconciled_by = (select auth.uid()) where id = v_active;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('updated',v_matched,'reconciledAt',v_at),
                            'meta',jsonb_build_object('updatedAt',v_at,'schemaVersion',1));
end$$;
revoke all on function public.vendor_return_reconcile(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vendor_return_reconcile(uuid, jsonb) to authenticated;

commit;
notify pgrst, 'reload schema';
