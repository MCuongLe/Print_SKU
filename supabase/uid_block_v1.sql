-- LỰA UID BLOCKED (#uid-block, 20/10/2026): Admin nạp tệp Excel danh sách Group UID bị Blocked, nhân viên kho quét để lựa ra.
--
-- Vì sao: người dùng chốt nguồn danh sách là TỆP EXCEL (không lấy trạng thái đồng bộ WMS làm danh sách), áp mọi kho. Web đọc
-- Excel trên trình duyệt, lọc dòng Status = Blocked, gửi lên một lần; mọi máy tải danh sách về (kiểm phiên bản như Kiểm kê: trùng
-- id → {unchanged:true}) để quét báo ngay, mất mạng vẫn báo. Đối chiếu lại tệp với group_uid_details (bản đồng bộ WMS): trạng thái
-- + qc_status hiện tại của từng mã, mã không có, và UID đang Blocked trên WMS mà tệp không có.
-- Lượt quét LƯU SUPABASE (người dùng 20/10/2026: "dữ liệu này cần lưu trên supabase, 3 người dùng sẽ trực tiếp scan"): mỗi mã chỉ
-- một lượt trong một danh sách, dùng chung giữa các máy; quét trùng (kể cả máy khác) báo đã scan kèm máy + giờ lần đầu. Ghi lượt
-- quét là nhóm ghi xưởng → KHOÁ MÁY như fabric_issue_scan (floor_access_v1): máy chưa kích hoạt bị chặn khi mode 'enforce'.
--
-- Mô hình giống uid_temp_snapshot_v1 / fabric_issue_v1: bảng chỉ cấp service_role (RLS bật, không policy); nạp qua hàm kiểm
-- public.group_uid_admin_allowed() chỉ cấp authenticated (uid_block_import); quét qua uid_block_scan (anon + authenticated, kiểm
-- floor_access_check); đọc qua ba hàm chỉ-đọc cấp anon + authenticated (uid_block_snapshot, uid_block_scans, uid_block_compare).
-- Một danh sách đang dùng = lần nạp mới nhất; giữ 5 lần nạp gần nhất, cũ hơn bị xoá (DELETE dòng, cascade sang uid_block_items và
-- uid_block_scans) trong cùng giao dịch. Nạp danh sách mới chép lượt quét của danh sách trước cho mã còn có (carriedScans).
--
-- Tác động: chỉ THÊM 3 bảng + 5 hàm, không đổi bảng/hàm cũ, không drop gì: không cần --allow-destructive.
-- uid_block_compare cho anon thấy status/qc_status/kho/vị trí của Group UID (group_uid_lookup cũ không trả status) và tối đa 500
-- UID đang Blocked; uid_block_scans cho anon thấy mã đã quét + tên máy + giờ — người dùng chốt ai cũng quét/đối chiếu được.
-- Chạy migration TRƯỚC khi push index.html (web gọi 5 hàm).
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

-- Lượt quét chung: một dòng cho mỗi (danh sách, mã). Không bao giờ xoá lẻ — chỉ cascade theo danh sách — nên số dòng của một
-- danh sách chỉ tăng (uid_block_scans so số đếm để trả unchanged). device_name chép lúc quét (máy bị xoá/đổi tên vẫn còn tên cũ).
create table if not exists public.uid_block_scans (
  list_id uuid not null references public.uid_block_lists(id) on delete cascade,
  group_uid_code text not null check (group_uid_code ~ '^[0-9]{16}$'),
  scanned_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  device_id uuid references public.print_devices(id) on delete set null,
  device_name text not null default '' check (char_length(device_name) <= 60),
  primary key (list_id, group_uid_code)
);

alter table public.uid_block_lists enable row level security;
alter table public.uid_block_items enable row level security;
alter table public.uid_block_scans enable row level security;
revoke all on public.uid_block_lists from public, anon, authenticated;
revoke all on public.uid_block_items from public, anon, authenticated;
revoke all on public.uid_block_scans from public, anon, authenticated;
grant select, insert, update, delete on public.uid_block_lists to service_role;
grant select, insert, update, delete on public.uid_block_items to service_role;
grant select, insert, update, delete on public.uid_block_scans to service_role;

-- Admin nạp một danh sách. p_list = {fileName, sheets:[text]}; p_items = [{groupUid, sku, productName, lot, roll, warehouse,
-- location, fileStatus}] (1..20.000 dòng). groupUid là chuỗi đúng 16 chữ số sau btrim; trường khác chuỗi hoặc null, ≤ 300 ký tự.
-- Trùng groupUid giữ dòng xuất hiện đầu tiên. byWarehouse = {tên kho: số UID}; dòng không có kho đếm vào khoá "".
-- Nạp tuần tự bằng advisory lock; giờ nạp lấy clock_timestamp() SAU khi khoá: hai Admin nạp chồng nhau thì lần ghi sau luôn là
-- danh sách mới nhất (now() là giờ đầu giao dịch, lần chờ khoá sẽ mang giờ cũ hơn).
-- Lượt quét của danh sách đang dùng (v_prev, đọc SAU khoá) được chép sang danh sách mới cho mã còn có, giữ nguyên giờ quét, giờ ghi
-- và máy; chép TRƯỚC khi xoá danh sách cũ quá 5 (cascade). uid_block_scan giữ khoá chia sẻ cùng khoá này nên không có lượt quét nào
-- ghi vào v_prev sau khi đã chép.
create or replace function public.uid_block_import(p_list jsonb, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_prev uuid; v_bad integer; v_count integer; v_by jsonb; v_carried integer := 0;
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

  select l.id into v_prev
    from public.uid_block_lists l
   order by l.imported_at desc, l.id desc
   limit 1;

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

    insert into public.uid_block_scans(list_id, group_uid_code, scanned_at, recorded_at, device_id, device_name)
    select v_id, s.group_uid_code, s.scanned_at, s.recorded_at, s.device_id, s.device_name
      from public.uid_block_scans s
      join public.uid_block_items i on i.list_id = v_id and i.group_uid_code = s.group_uid_code
     where s.list_id = v_prev;
    get diagnostics v_carried = row_count;
  exception when others then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Không lưu được danh sách: ' || left(sqlerrm, 200)));
  end;

  delete from public.uid_block_lists
   where id not in (select id from public.uid_block_lists order by imported_at desc, id desc limit 5);

  return jsonb_build_object('ok',true,'data',jsonb_build_object('listId',v_id,'itemCount',v_count,'byWarehouse',v_by,
                                                                'carriedScans',v_carried),
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

  -- "Blocked ngoài danh sách" quét group_uid_details MỘT lần: CTE materialized dùng chung cho tổng và 500 dòng đầu.
  with o as materialized (
    select g.group_uid_code, g.warehouse, g.sku
      from public.group_uid_details g
     where g.status = 'Blocked'
       and not exists (select 1 from unnest(v_codes) as c(code) where c.code = g.group_uid_code)
  )
  select (select count(*)::integer from o),
         (select coalesce(jsonb_agg(jsonb_build_object('groupUid',b.group_uid_code,'warehouse',b.warehouse,'sku',b.sku)
                                    order by b.warehouse, b.group_uid_code), '[]'::jsonb)
            from (select o.group_uid_code, o.warehouse, o.sku from o order by o.warehouse, o.group_uid_code limit 500) b)
    into v_outside_total, v_outside;

  return jsonb_build_object('ok',true,'data',jsonb_build_object('rows',v_rows,'missing',v_missing,
                                                                'blockedOutside',v_outside,'blockedOutsideTotal',v_outside_total),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Ghi một lượt quét (nhóm ghi xưởng → khoá máy như fabric_issue_scan): 'deny' → ACCESS_DENIED; 'warn' (mode log) gộp
-- accessWarning:true vào mọi nhánh. p_list_id = danh sách web đang giữ; khác danh sách hiện hành → STALE_LIST + listId mới (web
-- tải lại rồi quét lại). Mã không thuộc danh sách → not_blocked (không ghi). Mã thuộc danh sách: lượt đầu → 'new'; đã có (kể cả
-- máy khác) → 'dup' kèm giờ + máy của lượt đầu, mine = lượt đầu do chính máy này. p_scanned_at = giờ quét thật web gửi khi gửi
-- lại hàng chờ lúc mất mạng: chỉ nhận trong [−2 ngày, +5 phút] so với giờ máy chủ (không lấy giờ tương lai), ngoài khoảng → giờ
-- máy chủ. Khoá chia sẻ với uid_block_import: lần nạp chờ các lượt quét đang chạy xong rồi mới chép, lượt quét đến sau lần nạp
-- thấy danh sách mới (STALE_LIST) — không lượt quét nào rơi giữa hai danh sách.
create or replace function public.uid_block_scan(p_access_token text, p_list_id uuid, p_group_uid text, p_scanned_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text; v_code text; v_list uuid; v_dev uuid; v_dev_name text := ''; v_now timestamptz; v_at timestamptz;
        v_row public.uid_block_scans; v_result text;
begin
  v_access := public.floor_access_check(p_access_token, 'uid_block_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;

  v_code := btrim(p_group_uid);
  if v_code is null or v_code !~ '^[0-9]{16}$' then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_GROUP_UID','message','Group UID phải đúng 16 chữ số')));
  end if;
  if p_list_id is null then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LIST','message','Thiếu mã danh sách UID blocked')));
  end if;

  perform pg_advisory_xact_lock_shared(hashtext('public.uid_block_import'));
  select l.id into v_list
    from public.uid_block_lists l
   order by l.imported_at desc, l.id desc
   limit 1;
  if v_list is null then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_LIST','message','Chưa có danh sách UID blocked')));
  end if;
  if v_list <> p_list_id then
    return public.floor_access_result(v_access, jsonb_build_object('ok',false,'error',jsonb_build_object('code','STALE_LIST',
      'message','Danh sách UID blocked đã đổi, đang tải danh sách mới','data',jsonb_build_object('listId',v_list))));
  end if;
  if not exists (select 1 from public.uid_block_items i where i.list_id = v_list and i.group_uid_code = v_code) then
    return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object('result','not_blocked','groupUid',v_code),
      'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
  end if;

  v_dev := public.print_device_by_token(p_access_token);
  if v_dev is not null then
    select left(d.name, 60) into v_dev_name from public.print_devices d where d.id = v_dev;
    v_dev_name := coalesce(v_dev_name, '');
  end if;

  v_now := clock_timestamp();
  v_at := case when p_scanned_at between v_now - interval '2 days' and v_now + interval '5 minutes'
               then least(p_scanned_at, v_now) else v_now end;

  insert into public.uid_block_scans(list_id, group_uid_code, scanned_at, device_id, device_name)
  values (v_list, v_code, v_at, v_dev, v_dev_name)
  on conflict (list_id, group_uid_code) do nothing
  returning * into v_row;
  if found then
    v_result := 'new';
  else
    v_result := 'dup';
    select * into v_row from public.uid_block_scans s where s.list_id = v_list and s.group_uid_code = v_code;
  end if;

  return public.floor_access_result(v_access, jsonb_build_object('ok',true,'data',jsonb_build_object(
    'result',v_result,'groupUid',v_code,'scannedAt',v_row.scanned_at,'deviceName',coalesce(v_row.device_name,''),
    'mine',(v_row.device_id is not null and v_dev is not null and v_row.device_id = v_dev)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)));
end$$;

-- Mọi máy đọc lượt quét chung của một danh sách (web gọi định kỳ khi màn mở). Lượt quét chỉ thêm (không xoá lẻ) nên web gửi số
-- lượt đang giữ: trùng → {unchanged:true, count}; khác → toàn bộ rows theo giờ quét. Hàm stable: đếm và rows cùng một snapshot.
create or replace function public.uid_block_scans(p_list_id uuid, p_known_count integer default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_list_id is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LIST','message','Thiếu mã danh sách UID blocked'));
  end if;
  select count(*)::integer into v_count from public.uid_block_scans s where s.list_id = p_list_id;
  if p_known_count is not null and p_known_count = v_count then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('listId',p_list_id,'unchanged',true,'count',v_count),
                              'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('listId',p_list_id,'unchanged',false,'count',v_count,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('groupUid',s.group_uid_code,'scannedAt',s.scanned_at,'deviceName',s.device_name) order by s.scanned_at, s.group_uid_code)
        from public.uid_block_scans s where s.list_id = p_list_id), '[]'::jsonb)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.uid_block_import(jsonb,jsonb) from public, anon;
revoke all on function public.uid_block_snapshot(uuid) from public;
revoke all on function public.uid_block_compare(text[]) from public;
grant execute on function public.uid_block_import(jsonb,jsonb) to authenticated;
grant execute on function public.uid_block_snapshot(uuid) to anon, authenticated;
grant execute on function public.uid_block_compare(text[]) to anon, authenticated;
revoke all on function public.uid_block_scan(text,uuid,text,timestamptz) from public;
grant execute on function public.uid_block_scan(text,uuid,text,timestamptz) to anon, authenticated;
revoke all on function public.uid_block_scans(uuid,integer) from public;
grant execute on function public.uid_block_scans(uuid,integer) to anon, authenticated;

commit;
notify pgrst,'reload schema';
