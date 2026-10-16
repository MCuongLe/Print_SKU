-- LAY MAU CAT / QC theo PO (16/10/2026): Admin doc Group UID cua PO tu WMS (Extension), trinh duyet chia mau
-- (20% cay nho nhat de CAT, 10% cay lon nhat de QC, con lai chuyen kho luu tru; moi lot cat + QC phai >= 30% so cay)
-- roi luu thanh mot "phien" o day. Ham cut_sample_create tu kiem rule 30% theo tung (SKU + Lot), khong tin rieng trinh duyet.
-- Nhan vien kho quet Group UID: ham cut_sample_scan danh dau "da quet" va bao UID thuoc nhom nao.
-- Quet xong cac UID cat thi cut_sample_confirm day chung sang luong CAT GROUP UID cu (cut_group_uids, trang thai pending),
-- dung du lieu cua phien (SKU, Lot, Roll, ten SP tu SKU_Name) nen khong phu thuoc group_uid_details da dong bo hay chua.
--
-- Mo hinh giong CAP VAI (fabric_issue_v1.sql): xem/quet = anon qua ham security definer; tao/xoa/bo quet = Admin kiem
-- group_uid_admin_allowed(). Bang chi cap cho service_role, web chi di qua ham.
-- Mot PO = mot phien (po unique). Tao lai cho cung PO thi THAY phien, giu dau da quet cua UID con cung nhom.
-- Moi UID chi thuoc mot phien (group_uid_code unique).
--
-- Chi them bang va ham moi, khong drop gi: khong can --allow-destructive. Chay TRUOC khi cap nhat index.html.
begin;

create table if not exists public.cut_sample_sessions (
  id uuid primary key default gen_random_uuid(),
  po text not null unique check (po ~ '^[0-9]{6,40}$'),
  asns jsonb not null default '[]'::jsonb check (jsonb_typeof(asns) = 'array'),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cut_sample_items (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.cut_sample_sessions(id) on delete cascade,
  group_uid_code text not null unique check (group_uid_code ~ '^[0-9]{6,40}$'),
  sku text not null check (length(btrim(sku)) between 1 and 40),
  lot text not null default '' check (length(lot) <= 120),
  roll text not null default '' check (length(roll) <= 120),
  qty numeric not null check (qty > 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  role text not null check (role in ('cut','qc','store')),
  scanned_at timestamptz,
  scanned_by text check (scanned_by is null or length(scanned_by) <= 60),
  pushed_at timestamptz
);
create index if not exists cut_sample_items_session_idx on public.cut_sample_items (session_id, role);

alter table public.cut_sample_sessions enable row level security;
alter table public.cut_sample_items enable row level security;
revoke all on public.cut_sample_sessions from public, anon, authenticated;
revoke all on public.cut_sample_items from public, anon, authenticated;
grant select, insert, update, delete on public.cut_sample_sessions to service_role;
grant select, insert, update, delete on public.cut_sample_items to service_role;

create or replace function public.cut_sample_counts(p_session uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'total', count(*),
    'cut', count(*) filter (where role = 'cut'), 'cutScanned', count(*) filter (where role = 'cut' and scanned_at is not null),
    'qc', count(*) filter (where role = 'qc'), 'qcScanned', count(*) filter (where role = 'qc' and scanned_at is not null),
    'store', count(*) filter (where role = 'store'), 'storeScanned', count(*) filter (where role = 'store' and scanned_at is not null),
    'pushed', count(*) filter (where pushed_at is not null))
  from public.cut_sample_items where session_id = p_session
$$;

create or replace function public.cut_sample_item_json(i public.cut_sample_items)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('groupUid', i.group_uid_code, 'sku', i.sku, 'lot', i.lot, 'roll', i.roll, 'qty', i.qty, 'role', i.role,
    'scannedAt', i.scanned_at, 'scannedBy', i.scanned_by, 'pushedAt', i.pushed_at)
$$;

create or replace function public.cut_sample_session_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'po', s.po, 'asns', s.asns, 'createdAt', s.created_at, 'updatedAt', s.updated_at,
    'counts', public.cut_sample_counts(s.id))
  from public.cut_sample_sessions s where s.id = p_id
$$;

create or replace function public.cut_sample_list()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'data', jsonb_build_object('sessions',
    coalesce((select jsonb_agg(public.cut_sample_session_json(s.id) order by s.updated_at desc)
              from (select id, updated_at from public.cut_sample_sessions order by updated_at desc limit 200) s), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1))
$$;

create or replace function public.cut_sample_get(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.cut_sample_sessions where id = p_session) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu không còn tồn tại'));
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'session', public.cut_sample_session_json(p_session),
    'items', coalesce((select jsonb_agg(public.cut_sample_item_json(i) order by i.sku, i.lot,
        case i.role when 'cut' then 0 when 'qc' then 1 else 2 end, i.qty, i.group_uid_code)
      from public.cut_sample_items i where i.session_id = p_session), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Quet: tick "da quet" cho moi UID cua phien (cat / QC / luu tru). Quet lai khong doi gio quet dau tien.
create or replace function public.cut_sample_scan(p_session uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(coalesce(p_group_uid, '')), ''); v_item public.cut_sample_items; v_other text; v_result text;
begin
  if v_code is null or length(v_code) > 40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  if not exists(select 1 from public.cut_sample_sessions where id = p_session) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu đã bị xóa'));
  end if;
  select i.* into v_item from public.cut_sample_items i where i.group_uid_code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_SESSION', 'message', 'UID không thuộc phiên lấy mẫu nào'));
  end if;
  if v_item.session_id <> p_session then
    select s.po into v_other from public.cut_sample_sessions s where s.id = v_item.session_id;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'OTHER_SESSION', 'message', 'UID thuộc phiên của PO khác',
      'data', jsonb_build_object('po', v_other, 'sessionId', v_item.session_id, 'item', public.cut_sample_item_json(v_item))));
  end if;
  update public.cut_sample_items i set scanned_at = now(), scanned_by = nullif(left(btrim(coalesce(p_by, '')), 60), '')
   where i.id = v_item.id and i.scanned_at is null returning i.* into v_item;
  if found then v_result := 'scanned';
  else
    v_result := 'already';
    select i.* into v_item from public.cut_sample_items i where i.group_uid_code = v_code;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('result', v_result, 'item', public.cut_sample_item_json(v_item),
    'counts', public.cut_sample_counts(p_session)), 'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Admin: tao (hoac thay) phien cua mot PO. p_items: [{groupUid, sku, lot, roll, qty, role}], p_asns: [{asn_number, status, ...}].
create or replace function public.cut_sample_create(p_po text, p_asns jsonb, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_po text := btrim(coalesce(p_po, '')); v_id uuid; v_exists boolean; v_bad integer; v_dup integer; v_n integer; v_short integer;
        v_old jsonb; v_old_scanned integer := 0; v_new_scanned integer := 0; v_asns jsonb := coalesce(p_asns, '[]'::jsonb);
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được tạo phiên lấy mẫu'));
  end if;
  if v_po !~ '^[0-9]{6,40}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PO', 'message', 'Mã PO không hợp lệ'));
  end if;
  if jsonb_typeof(v_asns) <> 'array' or jsonb_array_length(v_asns) > 200 or length(v_asns::text) > 60000 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ASNS', 'message', 'Danh sách ASN không hợp lệ'));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 5000 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEMS', 'message', 'Phiên cần từ 1 đến 5.000 Group UID'));
  end if;
  v_n := jsonb_array_length(p_items);
  select count(*) filter (where q.bad), count(*) - count(distinct q.code) into v_bad, v_dup
    from (select btrim(coalesce(x."groupUid", '')) as code,
                 (coalesce(btrim(x."groupUid"), '') !~ '^[0-9]{6,40}$' or coalesce(btrim(x.sku), '') = '' or length(btrim(x.sku)) > 40
                  or x.qty is null or x.qty <= 0 or x.qty = 'NaN'::numeric or x.qty = 'Infinity'::numeric
                  or x.role is null or x.role not in ('cut', 'qc', 'store')
                  or length(coalesce(x.lot, '')) > 120 or length(coalesce(x.roll, '')) > 120) as bad
            from jsonb_to_recordset(p_items) as x("groupUid" text, sku text, lot text, roll text, qty numeric, role text)) q;
  if v_bad > 0 or v_dup > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEMS',
      'message', 'Có Group UID sai dữ liệu hoặc bị trùng trong phiên', 'data', jsonb_build_object('invalid', v_bad, 'duplicate', v_dup)));
  end if;

  -- Rule bat buoc: moi (SKU + Lot) co cat + QC >= 30% so cay (10 * mau >= 3 * tong).
  select count(*) into v_short from (
    select 1 from jsonb_to_recordset(p_items) as x("groupUid" text, sku text, lot text, roll text, qty numeric, role text)
     group by btrim(x.sku), btrim(coalesce(x.lot, ''))
    having count(*) filter (where x.role in ('cut', 'qc')) * 10 < 3 * count(*)) g;
  if v_short > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SAMPLE_BELOW_MIN',
      'message', 'Có Lot chưa đủ 30% UID cắt + QC', 'data', jsonb_build_object('lots', v_short)));
  end if;

  select s.id into v_id from public.cut_sample_sessions s where s.po = v_po for update;
  v_exists := found;
  if v_exists then
    v_old := coalesce((select jsonb_agg(jsonb_build_object('code', i.group_uid_code, 'role', i.role, 'scanned_at', i.scanned_at,
                                                           'scanned_by', i.scanned_by, 'pushed_at', i.pushed_at))
                         from public.cut_sample_items i where i.session_id = v_id), '[]'::jsonb);
    select count(*) into v_old_scanned from public.cut_sample_items where session_id = v_id and scanned_at is not null;
    delete from public.cut_sample_items where session_id = v_id;
    update public.cut_sample_sessions set asns = v_asns, updated_at = now() where id = v_id;
  else
    insert into public.cut_sample_sessions(po, asns, created_by) values (v_po, v_asns, (select auth.uid())) returning id into v_id;
  end if;

  insert into public.cut_sample_items(session_id, group_uid_code, sku, lot, roll, qty, role)
  select v_id, btrim(x."groupUid"), btrim(x.sku), btrim(coalesce(x.lot, '')), btrim(coalesce(x.roll, '')), x.qty, x.role
    from jsonb_to_recordset(p_items) as x("groupUid" text, sku text, lot text, roll text, qty numeric, role text);

  if v_exists then
    -- Giu dau da quet khi UID van cung nhom; dau da day sang luong Cat luon giu (viec da xay ra).
    update public.cut_sample_items n
       set scanned_at = case when o.role = n.role then o.scanned_at end,
           scanned_by = case when o.role = n.role then o.scanned_by end,
           pushed_at = o.pushed_at
      from jsonb_to_recordset(v_old) as o(code text, role text, scanned_at timestamptz, scanned_by text, pushed_at timestamptz)
     where n.session_id = v_id and n.group_uid_code = o.code;
    select count(*) into v_new_scanned from public.cut_sample_items where session_id = v_id and scanned_at is not null;
  end if;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('session', public.cut_sample_session_json(v_id), 'replaced', v_exists,
    'carried', v_new_scanned, 'dropped', greatest(v_old_scanned - v_new_scanned, 0)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'UID_IN_OTHER_SESSION', 'message', 'Có Group UID đã thuộc phiên của PO khác'));
end $$;

-- Admin: xoa phien (cac UID da day sang luong Cat van nam o cut_group_uids).
create or replace function public.cut_sample_delete(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_po text;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xóa phiên lấy mẫu'));
  end if;
  delete from public.cut_sample_sessions where id = p_session returning po into v_po;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu không còn tồn tại'));
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('po', v_po), 'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Admin: bo dau da quet cua mot UID (quet nham). Khong bo duoc UID da day sang luong Cat.
create or replace function public.cut_sample_unscan(p_session uuid, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_item public.cut_sample_items;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được bỏ dấu đã quét'));
  end if;
  select i.* into v_item from public.cut_sample_items i where i.session_id = p_session and i.group_uid_code = btrim(coalesce(p_group_uid, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_SESSION', 'message', 'UID không thuộc phiên này'));
  end if;
  if v_item.pushed_at is not null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ALREADY_PUSHED', 'message', 'UID đã chuyển sang luồng Cắt UID, không bỏ dấu quét được'));
  end if;
  update public.cut_sample_items i set scanned_at = null, scanned_by = null where i.id = v_item.id returning i.* into v_item;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('item', public.cut_sample_item_json(v_item), 'counts', public.cut_sample_counts(p_session)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Xac nhan: day cac UID CAT da quet (chua day) sang luong Cat Group UID cu. Giong cut_group_uid_scan: chup SKU, Lot, Roll (toi da
-- 20 ky tu), ten SP tu SKU_Name, trang thai in 'pending'; UID da co o Cat UID thi chi danh dau da day. Khong co ten SP thi KHONG day
-- (bao lai de bo sung SKU_Name) va van de cho lan xac nhan sau.
create or replace function public.cut_sample_confirm(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pushed integer; v_marked integer; v_missing text[]; v_left integer;
begin
  if not exists(select 1 from public.cut_sample_sessions where id = p_session) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu đã bị xóa'));
  end if;
  with todo as (
    select i.id, i.group_uid_code, i.sku, i.lot, i.roll, btrim(coalesce(s.product_name, '')) as product_name
      from public.cut_sample_items i left join public."SKU_Name" s on s.sku = i.sku
     where i.session_id = p_session and i.role = 'cut' and i.scanned_at is not null and i.pushed_at is null
  ), ins as (
    insert into public.cut_group_uids(group_uid_code, sku, product_name, lot, roll)
    select t.group_uid_code, t.sku, t.product_name, left(t.lot, 20), left(t.roll, 20) from todo t where t.product_name <> ''
    on conflict (group_uid_code) do nothing returning group_uid_code
  ), mark as (
    update public.cut_sample_items i set pushed_at = now() from todo t where i.id = t.id and t.product_name <> '' returning i.group_uid_code
  )
  select (select count(*) from ins), (select count(*) from mark),
         coalesce((select array_agg(t.group_uid_code order by t.group_uid_code) from todo t where t.product_name = ''), '{}'::text[])
    into v_pushed, v_marked, v_missing;
  select count(*) into v_left from public.cut_sample_items where session_id = p_session and role = 'cut' and scanned_at is null;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('pushed', v_pushed, 'alreadyCut', greatest(v_marked - v_pushed, 0),
    'missingName', to_jsonb(v_missing), 'cutUnscanned', v_left, 'counts', public.cut_sample_counts(p_session)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

revoke all on function public.cut_sample_counts(uuid) from public, anon, authenticated;
revoke all on function public.cut_sample_item_json(public.cut_sample_items) from public, anon, authenticated;
revoke all on function public.cut_sample_session_json(uuid) from public, anon, authenticated;
revoke all on function public.cut_sample_list() from public, anon, authenticated;
revoke all on function public.cut_sample_get(uuid) from public, anon, authenticated;
revoke all on function public.cut_sample_scan(uuid, text, text) from public, anon, authenticated;
revoke all on function public.cut_sample_confirm(uuid) from public, anon, authenticated;
revoke all on function public.cut_sample_create(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.cut_sample_delete(uuid) from public, anon, authenticated;
revoke all on function public.cut_sample_unscan(uuid, text) from public, anon, authenticated;
grant execute on function public.cut_sample_list() to anon, authenticated;
grant execute on function public.cut_sample_get(uuid) to anon, authenticated;
grant execute on function public.cut_sample_scan(uuid, text, text) to anon, authenticated;
grant execute on function public.cut_sample_confirm(uuid) to anon, authenticated;
grant execute on function public.cut_sample_create(text, jsonb, jsonb) to authenticated;
grant execute on function public.cut_sample_delete(uuid) to authenticated;
grant execute on function public.cut_sample_unscan(uuid, text) to authenticated;

commit;
notify pgrst, 'reload schema';
