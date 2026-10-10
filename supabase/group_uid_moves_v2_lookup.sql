-- Man LICH SU GROUP UID tren trang chu: moi nhan vien kho xem duoc, khong can dang nhap.
--
-- group_uid_moves_overview / group_uid_moves_lookup chi DOC (stable), cap cho anon nhu bang Tra cuu UID.
-- Viec nap du lieu tu WMS van chi danh cho Admin: group_uid_moves_import / _mark_read / _state
-- (group_uid_moves_v1.sql) kiem group_uid_admin_allowed() va chi cap cho authenticated.
-- group_uid_moves_search (ban Admin cua v1) khong con duoc dung nhung giu nguyen, khong drop gi.
--
-- WMS KHONG loc endpoint lich su theo company-ids: ngay 10/10/2026 ca 3 cong ty (1001, 1002, 1005) cung tra
-- 5.072 dong, nen chi doc MOT luong va p_company_id = 0 nghia la "moi cong ty" (cot company_id de NULL).
-- Cac dong da nap truoc do mang company_id cua lan doc cuoi cung (khong co nghia) nen duoc dua ve NULL.
--
-- Chay migration TRUOC khi cap nhat index.html.
begin;

create or replace function public.group_uid_moves_import(p_company_id integer, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bad integer; v_total integer; v_new integer := 0; v_changed integer := 0;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp lịch sử Group UID'));
  end if;
  if p_company_id is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần nạp tối đa 1.000 dòng lịch sử'));
  end if;
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as x(history_id bigint,group_uid_code text,warehouse_id integer,warehouse text,action_code integer,action_name text,from_location text,to_location text,moved_by text,moved_at timestamptz)
   where history_id is null or history_id <= 0 or nullif(btrim(group_uid_code),'') is null or length(btrim(group_uid_code)) > 40
      or moved_at is null or action_code is null or nullif(btrim(action_name),'') is null;
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng lịch sử thiếu hoặc sai dữ liệu'));
  end if;
  v_total := jsonb_array_length(p_rows);
  with src as (
    select distinct on (history_id) history_id, btrim(group_uid_code) as group_uid_code, warehouse_id,
           nullif(btrim(warehouse),'') as warehouse, action_code::smallint as action_code, btrim(action_name) as action_name,
           nullif(btrim(from_location),'') as from_location, nullif(btrim(to_location),'') as to_location,
           nullif(btrim(moved_by),'') as moved_by, moved_at
      from jsonb_to_recordset(p_rows) as x(history_id bigint,group_uid_code text,warehouse_id integer,warehouse text,action_code integer,action_name text,from_location text,to_location text,moved_by text,moved_at timestamptz)
     order by history_id
  ), written as (
    insert into public.group_uid_moves as m(history_id,group_uid_code,company_id,warehouse_id,warehouse,action_code,action_name,from_location,to_location,moved_by,moved_at)
    select history_id,group_uid_code,nullif(p_company_id,0),warehouse_id,warehouse,action_code,action_name,from_location,to_location,moved_by,moved_at from src
    on conflict (history_id) do update
      set group_uid_code=excluded.group_uid_code, company_id=excluded.company_id, warehouse_id=excluded.warehouse_id,
          warehouse=excluded.warehouse, action_code=excluded.action_code, action_name=excluded.action_name,
          from_location=excluded.from_location, to_location=excluded.to_location, moved_by=excluded.moved_by, moved_at=excluded.moved_at
      where (m.group_uid_code,m.company_id,m.warehouse_id,m.warehouse,m.action_code,m.action_name,m.from_location,m.to_location,m.moved_by,m.moved_at)
            is distinct from (excluded.group_uid_code,excluded.company_id,excluded.warehouse_id,excluded.warehouse,excluded.action_code,excluded.action_name,excluded.from_location,excluded.to_location,excluded.moved_by,excluded.moved_at)
    returning (xmax = 0) as inserted
  )
  select coalesce(count(*) filter (where inserted),0), coalesce(count(*) filter (where not inserted),0)
    into v_new, v_changed from written;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('rows',v_total,'newRows',v_new,'changedRows',v_changed,
      'unchangedRows',greatest(v_total-v_new-v_changed,0)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
exception when others then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','IMPORT_ERROR','message',left(sqlerrm,300)));
end $$;

update public.group_uid_moves set company_id = null where company_id is not null;

create or replace function public.group_uid_moves_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'total',(select count(*) from public.group_uid_moves),
    'firstAt',(select min(moved_at) from public.group_uid_moves),
    'lastAt',(select max(moved_at) from public.group_uid_moves),
    'lastReadAt',(select max(created_at) from public.group_uid_move_reads),
    'warehouses',coalesce((select jsonb_agg(jsonb_build_object('name',w.warehouse,'count',w.n) order by w.warehouse)
      from (select warehouse, count(*) as n from public.group_uid_moves where warehouse is not null group by warehouse) w),'[]'::jsonb)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- Tim lich su: kho (khop chinh xac), vi tri (den / tu / ca hai), SKU hien tai cua UID, khoang thoi gian.
create or replace function public.group_uid_moves_lookup(
  p_warehouse text default '', p_location text default '', p_match text default 'to', p_sku text default '',
  p_from timestamptz default null, p_to timestamptz default null, p_limit integer default 1000
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_wh text := btrim(coalesce(p_warehouse,'')); v_loc text := btrim(coalesce(p_location,'')); v_sku text := btrim(coalesce(p_sku,''));
  v_match text := case when p_match in ('to','from','any') then p_match else 'to' end;
  v_limit integer := least(greatest(coalesce(p_limit,1000),1),5000);
  v_loc_like text; v_sku_like text; v_total integer; v_items jsonb;
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
           'by',q.moved_by,'at',q.moved_at,'nextLocation',q.next_location,'nextAt',q.next_at,
           'sku',coalesce(d.sku,(select string_agg(s.sku,', ' order by s.sku) from (select p.sku from public.group_uid_products p where p.group_uid_code = q.group_uid_code order by p.sku limit 3) s)),
           'skuCount',case when d.sku is not null then 1 else (select count(*) from public.group_uid_products p where p.group_uid_code = q.group_uid_code) end,
           'product',(select p.product_name from public.group_uid_products p where p.group_uid_code = q.group_uid_code order by p.sku limit 1)
         ) order by q.moved_at desc, q.history_id desc),'[]'::jsonb)
    into v_total, v_items
    from page q left join public.group_uid_details d on d.group_uid_code = q.group_uid_code;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items,'total',v_total,'limit',v_limit,'truncated',v_total > v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.group_uid_moves_overview() from public;
revoke all on function public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer) from public;
grant execute on function public.group_uid_moves_overview() to anon, authenticated;
grant execute on function public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
