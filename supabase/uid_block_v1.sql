-- LỰA UID BLOCKED (#uid-block, 20/10/2026): Admin nạp tệp Excel danh sách Group UID bị Blocked, nhân viên kho quét để lựa ra.
--
-- Vì sao: người dùng chốt nguồn danh sách là TỆP EXCEL (không lấy trạng thái đồng bộ WMS làm danh sách), áp mọi kho, kết quả quét
-- giữ trên máy (không ghi lượt quét lên Supabase). Web đọc Excel trên trình duyệt, lọc dòng Status = Blocked, gửi lên một lần;
-- mọi máy tải danh sách về (kiểm phiên bản như Kiểm kê: trùng id → {unchanged:true}) để quét báo ngay, mất mạng vẫn báo.
-- Đối chiếu lại tệp với group_uid_details (bản đồng bộ WMS): trạng thái + qc_status hiện tại của từng mã, mã không có, và UID đang
-- Blocked trên WMS mà tệp không có.
--
-- Mô hình giống uid_temp_snapshot_v1 / fabric_issue_v1: bảng chỉ cấp service_role (RLS bật, không policy); ghi qua hàm kiểm
-- public.group_uid_admin_allowed() chỉ cấp authenticated (uid_block_import); đọc qua hai hàm chỉ-đọc cấp anon + authenticated
-- (uid_block_snapshot, uid_block_compare). Một danh sách đang dùng = lần nạp mới nhất; giữ 5 lần nạp gần nhất, cũ hơn bị xoá
-- (DELETE dòng, cascade sang uid_block_items) trong cùng giao dịch.
--
-- Tác động: chỉ THÊM 2 bảng + 3 hàm, không đổi bảng/hàm cũ, không drop gì: không cần --allow-destructive.
-- uid_block_compare cho anon thấy status/qc_status/kho/vị trí của Group UID (group_uid_lookup cũ không trả status) và tối đa 500
-- UID đang Blocked — người dùng chốt ai cũng quét/đối chiếu được.
-- Chạy migration TRƯỚC khi push index.html (web mới gọi ba hàm này).
-- Chạy: python scripts/apply_supabase_sql.py supabase/uid_block_v1.sql
begin;

create table if not exists public.uid_block_lists (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check (length(btrim(file_name)) between 1 and 200),
  sheets jsonb not null default '[]'::jsonb check (jsonb_typeof(sheets) = 'array'),
  item_count integer not null default 0 check (item_count >= 0),
  by_warehouse jsonb not null default '{}'::jsonb check (jsonb_typeof(by_warehouse) = 'object'),
  imported_by uuid,
  imported_at timestamptz not null default now()
);
create index if not exists uid_block_lists_imported_idx on public.uid_block_lists (imported_at desc, id desc);

create table if not exists public.uid_block_items (
  list_id uuid not null references public.uid_block_lists(id) on delete cascade,
  group_uid_code text not null check (group_uid_code ~ '^[0-9]{16}$'),
  sku text check (sku is null or length(sku) <= 300),
  product_name text check (product_name is null or length(product_name) <= 300),
  lot text check (lot is null or length(lot) <= 300),
  roll text check (roll is null or length(roll) <= 300),
  warehouse text check (warehouse is null or length(warehouse) <= 300),
  location text check (location is null or length(location) <= 300),
  file_status text check (file_status is null or length(file_status) <= 300),
  primary key (list_id, group_uid_code)
);

alter table public.uid_block_lists enable row level security;
alter table public.uid_block_items enable row level security;
revoke all on public.uid_block_lists from public, anon, authenticated;
revoke all on public.uid_block_items from public, anon, authenticated;
grant select, insert, update, delete on public.uid_block_lists to service_role;
grant select, insert, update, delete on public.uid_block_items to service_role;

-- Admin nạp một danh sách. p_list = {fileName, sheets:[text]}; p_items = [{groupUid, sku, productName, lot, roll, warehouse,
-- location, fileStatus}] (1..20.000 dòng). groupUid là chuỗi đúng 16 chữ số sau btrim; trường khác chuỗi hoặc null, ≤ 300 ký tự.
-- Trùng groupUid giữ dòng xuất hiện đầu tiên. byWarehouse = {tên kho: số UID}; dòng không có kho đếm vào khoá "".
-- Nạp tuần tự bằng advisory lock; giờ nạp lấy clock_timestamp() SAU khi khoá: hai Admin nạp chồng nhau thì lần ghi sau luôn là
-- danh sách mới nhất (now() là giờ đầu giao dịch, lần chờ khoá sẽ mang giờ cũ hơn).
create or replace function public.uid_block_import(p_list jsonb, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_bad integer; v_count integer; v_by jsonb;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp danh sách UID blocked'));
  end if;
  perform pg_advisory_xact_lock(hashtext('public.uid_block_import'));

  if p_list is null or jsonb_typeof(p_list) <> 'object'
     or jsonb_typeof(p_list->'fileName') is distinct from 'string'
     or length(btrim(p_list->>'fileName')) not between 1 and 200
     or jsonb_typeof(p_list->'sheets') is distinct from 'array'
     or jsonb_array_length(case when jsonb_typeof(p_list->'sheets') = 'array' then p_list->'sheets' else '[]'::jsonb end) > 100
     or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_list->'sheets') = 'array' then p_list->'sheets' else '[]'::jsonb end) as s(v)
                 where jsonb_typeof(s.v) <> 'string' or length(s.v #>> '{}') > 200) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Thông tin tệp không hợp lệ (tên tệp 1–200 ký tự, danh sách sheet là chuỗi)'));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) not between 1 and 20000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần nạp từ 1 đến 20.000 UID'));
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_items) as e(v)
   where jsonb_typeof(e.v) <> 'object'
      or jsonb_typeof(e.v->'groupUid') is distinct from 'string'
      or btrim(e.v->>'groupUid') !~ '^[0-9]{16}$'
      or coalesce(jsonb_typeof(e.v->'sku'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'productName'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'lot'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'roll'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'warehouse'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'location'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'fileStatus'),'null') not in ('string','null')
      or length(coalesce(e.v->>'sku','')) > 300
      or length(coalesce(e.v->>'productName','')) > 300
      or length(coalesce(e.v->>'lot','')) > 300
      or length(coalesce(e.v->>'roll','')) > 300
      or length(coalesce(e.v->>'warehouse','')) > 300
      or length(coalesce(e.v->>'location','')) > 300
      or length(coalesce(e.v->>'fileStatus','')) > 300;
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT',
      'message','Có ' || v_bad || ' dòng sai dữ liệu (Group UID phải đúng 16 chữ số, các cột khác là chữ tối đa 300 ký tự)'));
  end if;

  begin
    insert into public.uid_block_lists(file_name, sheets, item_count, imported_by, imported_at)
    values (btrim(p_list->>'fileName'), p_list->'sheets', 0, (select auth.uid()), clock_timestamp())
    returning id into v_id;

    insert into public.uid_block_items(list_id, group_uid_code, sku, product_name, lot, roll, warehouse, location, file_status)
    select distinct on (btrim(e.v->>'groupUid'))
           v_id, btrim(e.v->>'groupUid'), nullif(btrim(e.v->>'sku'),''), nullif(btrim(e.v->>'productName'),''),
           nullif(btrim(e.v->>'lot'),''), nullif(btrim(e.v->>'roll'),''), nullif(btrim(e.v->>'warehouse'),''),
           nullif(btrim(e.v->>'location'),''), nullif(btrim(e.v->>'fileStatus'),'')
      from jsonb_array_elements(p_items) with ordinality as e(v, o)
     order by btrim(e.v->>'groupUid'), e.o;
    get diagnostics v_count = row_count;

    select coalesce(jsonb_object_agg(w.k, w.n), '{}'::jsonb) into v_by
      from (select coalesce(i.warehouse, '') as k, count(*) as n
              from public.uid_block_items i where i.list_id = v_id group by 1) w;

    update public.uid_block_lists set item_count = v_count, by_warehouse = v_by where id = v_id;
  exception when others then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Không lưu được danh sách: ' || left(sqlerrm, 200)));
  end;

  delete from public.uid_block_lists
   where id not in (select id from public.uid_block_lists order by imported_at desc, id desc limit 5);

  return jsonb_build_object('ok',true,'data',jsonb_build_object('listId',v_id,'itemCount',v_count,'byWarehouse',v_by),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Mọi máy tải danh sách đang dùng (lần nạp mới nhất). Web truyền id danh sách đang giữ: trùng → {unchanged:true, listId},
-- khác → toàn bộ danh sách; chưa nạp lần nào → {list:null, items:[]}.
create or replace function public.uid_block_snapshot(p_known_list_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_list public.uid_block_lists;
begin
  select * into v_list from public.uid_block_lists order by imported_at desc, id desc limit 1;
  if not found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',false,'list',null,'items','[]'::jsonb),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  if p_known_list_id is not null and v_list.id = p_known_list_id then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',true,'listId',v_list.id),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',false,
    'list', jsonb_build_object('id',v_list.id,'fileName',v_list.file_name,'sheets',v_list.sheets,'itemCount',v_list.item_count,
                               'byWarehouse',v_list.by_warehouse,'importedAt',v_list.imported_at),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('groupUid',i.group_uid_code,'sku',i.sku,'productName',i.product_name,'lot',i.lot,'roll',i.roll,
                                          'warehouse',i.warehouse,'location',i.location,'fileStatus',i.file_status) order by i.group_uid_code)
        from public.uid_block_items i where i.list_id = v_list.id), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Đối chiếu danh sách (tệp đang xem trước hoặc danh sách đã lưu) với bản đồng bộ WMS group_uid_details.
-- p_codes tối đa 20.000 mã (btrim, bỏ rỗng, bỏ trùng; mỗi mã ≤ 64 ký tự). Trả:
--   rows: [{groupUid, status, qcStatus, warehouse, location}] cho mã có trong group_uid_details;
--   missing: [mã không có trong group_uid_details];
--   blockedOutside: tối đa 500 UID đang status 'Blocked' mà không thuộc p_codes [{groupUid, warehouse, sku}]; blockedOutsideTotal: tổng.
create or replace function public.uid_block_compare(p_codes text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_codes text[]; v_rows jsonb; v_missing jsonb; v_outside jsonb; v_outside_total integer;
begin
  if p_codes is null then
    p_codes := '{}'::text[];
  end if;
  if cardinality(p_codes) > 20000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần đối chiếu tối đa 20.000 UID'));
  end if;
  if exists (select 1 from unnest(p_codes) as u(code) where length(u.code) > 64) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Có mã Group UID dài bất thường'));
  end if;

  select coalesce(array_agg(distinct btrim(u.code)), '{}'::text[]) into v_codes
    from unnest(p_codes) as u(code)
   where nullif(btrim(u.code), '') is not null;

  select coalesce(jsonb_agg(jsonb_build_object('groupUid',g.group_uid_code,'status',g.status,'qcStatus',g.qc_status,
                                               'warehouse',g.warehouse,'location',g.location) order by g.group_uid_code), '[]'::jsonb)
    into v_rows
    from public.group_uid_details g
   where g.group_uid_code = any(v_codes);

  select coalesce(jsonb_agg(c.code order by c.code), '[]'::jsonb) into v_missing
    from unnest(v_codes) as c(code)
   where not exists (select 1 from public.group_uid_details g where g.group_uid_code = c.code);

  select count(*)::integer into v_outside_total
    from public.group_uid_details g
   where g.status = 'Blocked'
     and not exists (select 1 from unnest(v_codes) as c(code) where c.code = g.group_uid_code);

  select coalesce(jsonb_agg(jsonb_build_object('groupUid',b.group_uid_code,'warehouse',b.warehouse,'sku',b.sku)
                            order by b.warehouse, b.group_uid_code), '[]'::jsonb)
    into v_outside
    from (select g.group_uid_code, g.warehouse, g.sku
            from public.group_uid_details g
           where g.status = 'Blocked'
             and not exists (select 1 from unnest(v_codes) as c(code) where c.code = g.group_uid_code)
           order by g.warehouse, g.group_uid_code
           limit 500) b;

  return jsonb_build_object('ok',true,'data',jsonb_build_object('rows',v_rows,'missing',v_missing,
                                                                'blockedOutside',v_outside,'blockedOutsideTotal',v_outside_total),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.uid_block_import(jsonb,jsonb) from public, anon;
revoke all on function public.uid_block_snapshot(uuid) from public;
revoke all on function public.uid_block_compare(text[]) from public;
grant execute on function public.uid_block_import(jsonb,jsonb) to authenticated;
grant execute on function public.uid_block_snapshot(uuid) to anon, authenticated;
grant execute on function public.uid_block_compare(text[]) to anon, authenticated;

commit;
notify pgrst,'reload schema';
