-- TRẢ NHÀ CUNG CẤP (#tra-ncc trong TÌM GROUP UID, 24/10/2026, kế hoạch docs/plans/2026-10-24-tra-nha-cung-cap.md).
--
-- Vì sao: người dùng cần lựa các Group UID trả nhà cung cấp theo tệp Excel họ đưa (sheet "navy" / "black"; màu lấy theo tên
-- sheet). Admin nạp tệp ngay trên màn (web đọc Excel trên trình duyệt, gửi lên một lần); nhân viên kho quét, UID đã quét được
-- đánh dấu, mọi máy xem chung tiến độ (đã quét / tổng theo màu). Lượt quét là nhóm ghi xưởng → KHOÁ MÁY như uid_block_scan
-- (floor_access_v1): chỉ máy đã kích hoạt ghi được; ai cũng xem. Quét UID ngoài danh sách → not_in_list (không ghi); quét trùng
-- (kể cả máy khác, kể cả hai máy cùng lúc) → dup kèm máy + giờ lượt đầu, giữ lượt đầu. "Danh sách tạm thời lưu trên database,
-- tôi sẽ báo dọn dẹp sau" (người dùng 24/10/2026): tệp này KHÔNG xoá danh sách nào và không có cron dọn.
--
-- Mô hình giống uid_block_v1: bảng chỉ service_role (RLS bật, không policy); nạp qua vendor_return_import kiểm
-- public.group_uid_admin_allowed(), chỉ cấp authenticated; quét qua vendor_return_scan (anon + authenticated, kiểm
-- floor_access_check); đọc qua vendor_return_snapshot (stable, anon + authenticated). Khác uid_block: danh sách đang dùng là dòng
-- active = true (index unique một phần → luôn tối đa một), nạp mới tắt danh sách cũ (active = false, KHÔNG xoá) và chép lượt
-- quét của danh sách đang dùng cho UID còn có (carriedScans); Group UID trùng trong tệp → lỗi DUPLICATE_UID (không tự bỏ trùng).
-- Nạp và quét dùng chung một advisory lock (nạp: độc quyền, quét: chia sẻ) nên không lượt quét nào rơi giữa hai danh sách.
--
-- Tác động: chỉ THÊM 3 bảng + 3 hàm, không đổi bảng/hàm cũ, không drop/xoá gì: không cần --allow-destructive.
-- vendor_return_snapshot cho anon thấy mã + SKU + tên + lot/roll/vị trí/số lượng + máy/giờ quét của danh sách trả — người dùng
-- chốt ai cũng xem tiến độ. Nhãn Admin cho hàm khoá máy mới 'vendor_return_scan' (FLOOR_FN trên web) do lead thêm ở index.html.
-- Cần có trước: print_devices_v1 (print_devices, print_device_by_token), floor_access_v1 (floor_access_check/denied/result),
-- group_uid_v4_admin_import (group_uid_admin_allowed).
-- Chạy migration TRƯỚC khi push index.html (web gọi 3 hàm).
-- Kiểm cục bộ: node tests/vendor_return_sql.cjs; python scripts/apply_supabase_sql.py supabase/vendor_return_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/vendor_return_v1.sql
begin;

create table if not exists public.vendor_return_lists (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check (length(btrim(file_name)) between 1 and 200),
  item_count integer not null default 0 check (item_count >= 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  active boolean not null default false
);
-- Tối đa một danh sách đang dùng.
create unique index if not exists vendor_return_lists_one_active on public.vendor_return_lists ((true)) where active;

create table if not exists public.vendor_return_items (
  list_id uuid not null references public.vendor_return_lists(id) on delete cascade,
  group_uid_code text not null check (group_uid_code ~ '^[0-9]{10,40}$'),
  color text not null check (color in ('navy', 'black')),
  sku text check (sku is null or length(sku) <= 300),
  product_name text check (product_name is null or length(product_name) <= 300),
  lot text check (lot is null or length(lot) <= 300),
  roll text check (roll is null or length(roll) <= 300),
  location text check (location is null or length(location) <= 300),
  qty numeric check (qty is null or qty >= 0),
  primary key (list_id, group_uid_code)
);

-- Lượt quét chung: một dòng cho mỗi (danh sách, mã), chỉ cho mã có trong danh sách (khoá ngoại tới items). device_name chép lúc
-- quét (máy bị xoá/đổi tên vẫn còn tên cũ). Khoá chính (list_id, group_uid_code) phủ cả hai khoá ngoại theo danh sách.
create table if not exists public.vendor_return_scans (
  list_id uuid not null references public.vendor_return_lists(id) on delete cascade,
  group_uid_code text not null,
  device_id uuid references public.print_devices(id) on delete set null,
  device_name text not null default '' check (char_length(device_name) <= 60),
  scanned_at timestamptz not null default clock_timestamp(),
  primary key (list_id, group_uid_code),
  foreign key (list_id, group_uid_code) references public.vendor_return_items(list_id, group_uid_code) on delete cascade
);
create index if not exists vendor_return_scans_device_idx on public.vendor_return_scans (device_id) where device_id is not null;

alter table public.vendor_return_lists enable row level security;
alter table public.vendor_return_items enable row level security;
alter table public.vendor_return_scans enable row level security;
revoke all on public.vendor_return_lists from public, anon, authenticated;
revoke all on public.vendor_return_items from public, anon, authenticated;
revoke all on public.vendor_return_scans from public, anon, authenticated;
grant select, insert, update, delete on public.vendor_return_lists to service_role;
grant select, insert, update, delete on public.vendor_return_items to service_role;
grant select, insert, update, delete on public.vendor_return_scans to service_role;

-- Admin nạp một danh sách. p_file_name 1–200 ký tự (sau btrim); p_items = [{groupUid, color, sku, productName, lot, roll,
-- location, qty}] (1..2.000 dòng). groupUid là chuỗi 10–40 chữ số sau btrim; color đúng 'navy' | 'black'; sku/productName/lot/
-- roll/location là chuỗi hoặc null, ≤ 300 ký tự (chuỗi rỗng sau btrim → null); qty là số ≥ 0 hoặc null (web đổi sang Number).
-- Trùng groupUid (cùng sheet hoặc khác sheet) → DUPLICATE_UID, error.data = {duplicates: tối đa 20 mã, count}.
-- Nạp tuần tự bằng advisory lock; giờ nạp lấy clock_timestamp() SAU khi khoá. Danh sách đang dùng (v_prev, đọc SAU khoá) bị tắt
-- (active = false, giữ nguyên dữ liệu), danh sách mới active; lượt quét của v_prev chép sang danh sách mới cho mã còn có, giữ
-- nguyên giờ quét và máy. Tắt cũ + chèn + chép nằm trong một khối exception: lỗi → không đổi gì, trả INVALID_INPUT.
create or replace function public.vendor_return_import(p_file_name text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_prev uuid; v_bad integer; v_dup jsonb; v_dup_count integer; v_count integer;
        v_navy integer := 0; v_black integer := 0; v_carried integer := 0;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp danh sách trả nhà cung cấp'));
  end if;
  perform pg_advisory_xact_lock(hashtext('public.vendor_return_import'));

  if p_file_name is null or length(btrim(p_file_name)) not between 1 and 200 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Tên tệp phải từ 1 đến 200 ký tự'));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) not between 1 and 2000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần nạp từ 1 đến 2.000 Group UID'));
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_items) as e(v)
   where jsonb_typeof(e.v) <> 'object'
      or jsonb_typeof(e.v->'groupUid') is distinct from 'string'
      or btrim(e.v->>'groupUid') !~ '^[0-9]{10,40}$'
      or jsonb_typeof(e.v->'color') is distinct from 'string'
      or e.v->>'color' not in ('navy','black')
      or jsonb_typeof(e.v->'sku') is distinct from 'string' or btrim(e.v->>'sku') = ''   -- dòng hàng thật luôn có SKU (bảng pivot thì không)
      or coalesce(jsonb_typeof(e.v->'productName'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'lot'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'roll'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'location'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(e.v->'qty'),'null') not in ('number','null')
      or length(coalesce(e.v->>'sku','')) > 300
      or length(coalesce(e.v->>'productName','')) > 300
      or length(coalesce(e.v->>'lot','')) > 300
      or length(coalesce(e.v->>'roll','')) > 300
      or length(coalesce(e.v->>'location','')) > 300
      or case when jsonb_typeof(e.v->'qty') = 'number' then (e.v->>'qty')::numeric < 0 else false end;
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT',
      'message','Có ' || v_bad || ' dòng sai dữ liệu (Group UID 10–40 chữ số, màu navy hoặc black, số lượng là số không âm, các cột khác là chữ tối đa 300 ký tự)'));
  end if;

  with d as (
    select btrim(e.v->>'groupUid') as code
      from jsonb_array_elements(p_items) as e(v)
     group by btrim(e.v->>'groupUid')
    having count(*) > 1
  )
  select (select count(*)::integer from d),
         coalesce((select jsonb_agg(x.code order by x.code) from (select d.code from d order by d.code limit 20) x), '[]'::jsonb)
    into v_dup_count, v_dup;
  if v_dup_count > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','DUPLICATE_UID',
      'message','Có ' || v_dup_count || ' Group UID bị trùng trong tệp (ví dụ ' || (v_dup->>0) || ')',
      'data',jsonb_build_object('duplicates',v_dup,'count',v_dup_count)));
  end if;

  select l.id into v_prev
    from public.vendor_return_lists l
   where l.active
   limit 1;

  begin
    update public.vendor_return_lists set active = false where active;

    insert into public.vendor_return_lists(file_name, item_count, active, created_by, created_at)
    values (btrim(p_file_name), 0, true, (select auth.uid()), clock_timestamp())
    returning id into v_id;

    insert into public.vendor_return_items(list_id, group_uid_code, color, sku, product_name, lot, roll, location, qty)
    select v_id, btrim(e.v->>'groupUid'), e.v->>'color', nullif(btrim(e.v->>'sku'),''), nullif(btrim(e.v->>'productName'),''),
           nullif(btrim(e.v->>'lot'),''), nullif(btrim(e.v->>'roll'),''), nullif(btrim(e.v->>'location'),''),
           (e.v->>'qty')::numeric
      from jsonb_array_elements(p_items) as e(v);
    get diagnostics v_count = row_count;

    select (count(*) filter (where i.color = 'navy'))::integer, (count(*) filter (where i.color = 'black'))::integer
      into v_navy, v_black
      from public.vendor_return_items i where i.list_id = v_id;

    update public.vendor_return_lists set item_count = v_count where id = v_id;

    insert into public.vendor_return_scans(list_id, group_uid_code, device_id, device_name, scanned_at)
    select v_id, s.group_uid_code, s.device_id, s.device_name, s.scanned_at
      from public.vendor_return_scans s
      join public.vendor_return_items i on i.list_id = v_id and i.group_uid_code = s.group_uid_code
     where s.list_id = v_prev;
    get diagnostics v_carried = row_count;
  exception when others then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Không lưu được danh sách: ' || left(sqlerrm, 200)));
  end;

  return jsonb_build_object('ok',true,'data',jsonb_build_object('listId',v_id,'itemCount',v_count,'navy',v_navy,'black',v_black,'carriedScans',v_carried),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Mọi máy đọc danh sách đang dùng kèm lượt quét. Chưa có danh sách → {list:null, items:[]}. items sắp theo màu (black trước
-- navy), vị trí (null cuối), mã; chưa quét → scannedAt = null, device = null.
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
    'list', jsonb_build_object('id',v_list.id,'fileName',v_list.file_name,'createdAt',v_list.created_at,'itemCount',v_list.item_count),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('groupUid',i.group_uid_code,'color',i.color,'sku',i.sku,'productName',i.product_name,'lot',i.lot,
                                          'roll',i.roll,'location',i.location,'qty',i.qty,'scannedAt',s.scanned_at,'device',s.device_name)
                       order by i.color, i.location, i.group_uid_code)
        from public.vendor_return_items i
        left join public.vendor_return_scans s on s.list_id = i.list_id and s.group_uid_code = i.group_uid_code
       where i.list_id = v_list.id), '[]'::jsonb)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Ghi một lượt quét (nhóm ghi xưởng → khoá máy như uid_block_scan): 'deny' → ACCESS_DENIED; 'warn' (mode log) gộp
-- accessWarning:true vào mọi nhánh. p_list_id = danh sách web đang giữ; không phải danh sách active → STALE_LIST + listId hiện
-- hành (web tải lại rồi quét lại). Mã không thuộc danh sách → not_in_list (không ghi). Lượt đầu → 'new'; đã có (kể cả máy khác,
-- kể cả hai máy cùng lúc: on conflict do nothing) → 'dup' kèm giờ + máy của lượt đầu. Giờ quét = giờ máy chủ.
-- Khoá chia sẻ với vendor_return_import: lần nạp chờ các lượt quét đang chạy xong rồi mới chép, lượt quét đến sau lần nạp thấy
-- danh sách mới (STALE_LIST).
create or replace function public.vendor_return_scan(p_access_token text, p_list_id uuid, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text; v_code text; v_list uuid; v_color text; v_dev uuid; v_dev_name text := '';
        v_row public.vendor_return_scans; v_result text;
begin
  v_access := public.floor_access_check(p_access_token, 'vendor_return_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;

  v_code := btrim(p_group_uid);
  if v_code is null or v_code !~ '^[0-9]{10,40}$' then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_GROUP_UID','message','Group UID phải là 10–40 chữ số')));
  end if;
  if p_list_id is null then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LIST','message','Thiếu mã danh sách trả nhà cung cấp')));
  end if;

  perform pg_advisory_xact_lock_shared(hashtext('public.vendor_return_import'));
  select l.id into v_list
    from public.vendor_return_lists l
   where l.active
   limit 1;
  if v_list is null then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_LIST','message','Chưa có danh sách trả nhà cung cấp')));
  end if;
  if v_list <> p_list_id then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','STALE_LIST',
      'message','Danh sách trả nhà cung cấp đã đổi, đang tải danh sách mới','data',jsonb_build_object('listId',v_list))));
  end if;
  select i.color into v_color
    from public.vendor_return_items i where i.list_id = v_list and i.group_uid_code = v_code;
  if not found then
    return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object('result','not_in_list','groupUid',v_code),
      'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
  end if;

  v_dev := public.print_device_by_token(p_access_token);
  if v_dev is not null then
    select left(d.name, 60) into v_dev_name from public.print_devices d where d.id = v_dev;
    v_dev_name := coalesce(v_dev_name, '');
  end if;

  insert into public.vendor_return_scans(list_id, group_uid_code, device_id, device_name, scanned_at)
  values (v_list, v_code, v_dev, v_dev_name, clock_timestamp())
  on conflict (list_id, group_uid_code) do nothing
  returning * into v_row;
  if found then
    v_result := 'new';
  else
    v_result := 'dup';
    select * into v_row from public.vendor_return_scans s where s.list_id = v_list and s.group_uid_code = v_code;
  end if;

  return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object(
    'result',v_result,'groupUid',v_code,'color',v_color,'scannedAt',v_row.scanned_at,'device',coalesce(v_row.device_name,'')),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
end$$;

revoke all on function public.vendor_return_import(text,jsonb) from public, anon, authenticated;
grant execute on function public.vendor_return_import(text,jsonb) to authenticated;
revoke all on function public.vendor_return_snapshot() from public, anon, authenticated;
grant execute on function public.vendor_return_snapshot() to anon, authenticated;
revoke all on function public.vendor_return_scan(text,uuid,text) from public, anon, authenticated;
grant execute on function public.vendor_return_scan(text,uuid,text) to anon, authenticated;

commit;
notify pgrst,'reload schema';
