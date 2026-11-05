-- Xả vải theo phiếu IT bản 2 (05/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md mục "Đợt 2: UID ngoài phiếu").
--
-- Vì sao: người dùng chốt (05/11, "Chốt, build"): quét Group UID CÙNG SKU với một đợt đang xả nhưng không có trong danh sách UID của phiếu →
-- tự gắn vào đợt (nhãn "ngoài phiếu", tính tiến độ; nhiều đợt thì chọn) + báo vận hành kho; KHÁC SKU (không thuộc đợt đang xả nào) → pop-up
-- cảnh báo, KHÔNG lưu, chỉ báo vận hành kho; Admin đóng đợt (Đang xả / Xong). Báo cáo = danh sách trong app (không dịch vụ ngoài). Chỉ chặn
-- khi đang có ít nhất một đợt mở (không có đợt nào → đo tự do như chốt 04/11).
--
-- Tác động:
--   * xa_vai_it_batches: cột status ('open' | 'done', mặc định open), closed_at, closed_by. xa_vai_it_uids: cột source ('it' = từ WMS, 'scan' = gắn khi
--     quét), added_device. Bảng mới xa_vai_it_reports (UID khác SKU bị chặn: một dòng / UID, số lần quét, máy quét cuối). RLS bật, không policy.
--   * Hàm mới: _xa_vai_it_state, _xa_vai_it_attach_core (nội bộ; khoá theo Group UID, một UID một đợt), xa_vai_it_check (anon), xa_vai_it_attach + xa_vai_it_report (khoá máy xưởng, floor_access_check),
--     xa_vai_it_set_status (JWT Admin), xa_vai_it_outside (anon: UID gắn ngoài phiếu + UID khác SKU bị chặn).
--   * Thay (create or replace, cùng chữ ký): xa_vai_it_save (nạp lại thấy UID trong WMS → source = 'it'), _xa_vai_it_json (+ batchStatus,
--     closedAt, outsideCount), xa_vai_it_list (đợt mở trước), xa_vai_it_get (+ source, addedAt), _xa_vai_measure_save_body (bản đang chạy =
--     supabase/xa_vai_a4_v1.sql, so pg_get_functiondef 05/11: khớp; thêm: UID mới khác SKU khi có đợt mở → OUTSIDE_BATCH; cùng SKU chưa gắn →
--     tự gắn khi một đợt khớp, NEED_BATCH khi nhiều đợt). xa_vai_it_save còn gỡ dòng 'scan' ở đợt khác của UID mà WMS trả cho phiếu đang nạp.
--   Phân loại: web cũ vẫn chạy (khoá OUTSIDE_BATCH chỉ báo lỗi chung "Không lưu được" ở web cũ).
-- Không DROP / DELETE ở cấp cao nhất (alter table chỉ add column / add constraint khi chưa có) → không cần --allow-destructive. Chạy lại được.
-- Thứ tự lên: commit (chưa push) → migration này → push web. Không đổi Extension.
-- Kiểm cục bộ: node tests/xa_vai_it_v2_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_it_v2.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_it_v2.sql
-- kiem: select to_regclass('public.xa_vai_it_reports') is not null and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.xa_vai_it_reports')), false) and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'xa_vai_it_batches' and column_name = 'status') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'xa_vai_it_uids' and column_name = 'source') and has_function_privilege('anon', 'public.xa_vai_it_check(text)', 'execute') and has_function_privilege('anon', 'public.xa_vai_it_attach(text,text,text)', 'execute') and has_function_privilege('anon', 'public.xa_vai_it_report(text,text)', 'execute') and not has_function_privilege('anon', 'public.xa_vai_it_set_status(text,text)', 'execute') and has_function_privilege('anon', 'public.xa_vai_it_outside(integer)', 'execute') and not has_function_privilege('anon', 'public._xa_vai_it_state(text,text)', 'execute') and not has_table_privilege('anon', 'public.xa_vai_it_reports', 'select')
-- Rút lui (web mới báo lỗi ở phần ngoài phiếu; chạy kèm --allow-destructive; rồi chạy lại xa_vai_it_v1.sql + khối _xa_vai_measure_save_body của xa_vai_a4_v1.sql để trả hàm về bản cũ):
--   drop function if exists public.xa_vai_it_outside(integer);
--   drop function if exists public.xa_vai_it_set_status(text, text);
--   drop function if exists public.xa_vai_it_report(text, text);
--   drop function if exists public._xa_vai_it_report_body(text, text);
--   drop function if exists public.xa_vai_it_attach(text, text, text);
--   drop function if exists public._xa_vai_it_attach_body(text, text, text);
--   drop function if exists public._xa_vai_it_attach_core(text, text, uuid);
--   drop function if exists public.xa_vai_it_check(text);
--   drop table if exists public.xa_vai_it_reports;
begin;

-- ---------- Cột + bảng ----------
alter table public.xa_vai_it_batches add column if not exists status text not null default 'open';
alter table public.xa_vai_it_batches add column if not exists closed_at timestamptz;
alter table public.xa_vai_it_batches add column if not exists closed_by uuid;
alter table public.xa_vai_it_uids add column if not exists source text not null default 'it';
alter table public.xa_vai_it_uids add column if not exists added_device uuid references public.print_devices(id) on delete set null;
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'xa_vai_it_batches_status_check') then
    alter table public.xa_vai_it_batches add constraint xa_vai_it_batches_status_check check (status in ('open', 'done'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'xa_vai_it_uids_source_check') then
    alter table public.xa_vai_it_uids add constraint xa_vai_it_uids_source_check check (source in ('it', 'scan'));
  end if;
end $do$;
comment on column public.xa_vai_it_batches.status is 'open = Đang xả (nhận UID cùng SKU gắn thêm, tính vào điều kiện chặn UID khác SKU); done = Xong (Admin đóng).';
comment on column public.xa_vai_it_uids.source is 'it = UID của phiếu (WMS); scan = UID cùng SKU gắn khi quét xả vải ("ngoài phiếu").';
create index if not exists xa_vai_it_batches_open_idx on public.xa_vai_it_batches (loaded_at desc) where status = 'open';
create index if not exists xa_vai_it_uids_scan_idx on public.xa_vai_it_uids (added_at desc) where source = 'scan';
-- FK added_device: xoá máy (on delete set null) quét theo cột này.
create index if not exists xa_vai_it_uids_device_idx on public.xa_vai_it_uids (added_device) where added_device is not null;

create table if not exists public.xa_vai_it_reports (
  group_uid_code text primary key check (group_uid_code ~ '^[0-9]{16}$'),
  sku text not null check (length(sku) between 1 and 40),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  scan_count integer not null default 1 check (scan_count >= 1),
  device_id uuid references public.print_devices(id) on delete set null,
  open_items text check (open_items is null or length(open_items) <= 400)
);
comment on table public.xa_vai_it_reports is
  'Báo vận hành kho: Group UID KHÁC SKU với mọi đợt xả theo phiếu IT đang mở, bị chặn không lưu mét (một dòng / UID; quét lại cộng scan_count). open_items = mã hàng các đợt mở lúc quét gần nhất.';
create index if not exists xa_vai_it_reports_last_idx on public.xa_vai_it_reports (last_at desc);
create index if not exists xa_vai_it_reports_device_idx on public.xa_vai_it_reports (device_id) where device_id is not null;
alter table public.xa_vai_it_reports enable row level security;
revoke all on table public.xa_vai_it_reports from public, anon, authenticated;
grant select, insert, update, delete on table public.xa_vai_it_reports to service_role;

-- ---------- Trạng thái một UID với các đợt ----------
-- in_batch: UID có trong danh sách của một đợt (mọi trạng thái đợt). same_sku: SKU có trong dòng của ít nhất một đợt MỞ → batches (đợt nạp gần
-- nhất trước). other_sku: không thuộc đợt mở nào nhưng có đợt mở → openItems (mã hàng). free: không có đợt mở nào.
create or replace function public._xa_vai_it_state(p_code text, p_sku text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_batches jsonb;
  v_items jsonb;
begin
  if exists (select 1 from public.xa_vai_it_uids x where x.group_uid_code = p_code) then
    return jsonb_build_object('state', 'in_batch');
  end if;
  select jsonb_agg(jsonb_build_object('itNumber', b.it_number, 'itemCode', b.item_code) order by b.loaded_at desc, b.it_number) into v_batches
    from public.xa_vai_it_batches b
   where b.status = 'open' and exists (select 1 from jsonb_array_elements(b.lines) as l where l->>'sku' = p_sku);
  if v_batches is not null then
    return jsonb_build_object('state', 'same_sku', 'batches', v_batches);
  end if;
  select jsonb_agg(distinct b.item_code) into v_items from public.xa_vai_it_batches b where b.status = 'open';
  if v_items is not null then
    return jsonb_build_object('state', 'other_sku', 'openItems', v_items);
  end if;
  return jsonb_build_object('state', 'free');
end $$;
revoke all on function public._xa_vai_it_state(text, text) from public, anon, authenticated;

-- SKU của UID: dòng đo (nếu đã đo) rồi group_uid_details. Trả { groupUid, sku, state, batches?, openItems? }.
create or replace function public.xa_vai_it_check(p_group_uid text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := btrim(coalesce(p_group_uid, ''));
  v_sku text;
begin
  if v_code !~ '^[0-9]{16}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  select m.sku into v_sku from public.xa_vai_measures m where m.group_uid_code = v_code;
  if v_sku is null then
    select btrim(g.sku) into v_sku from public.group_uid_details g where g.group_uid_code = v_code;
  end if;
  if coalesce(v_sku, '') = '' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'GROUP_UID_NOT_READY', 'message', 'Group UID chưa có dữ liệu SKU'));
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('groupUid', v_code, 'sku', v_sku) || public._xa_vai_it_state(v_code, v_sku),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- ---------- Gắn UID cùng SKU vào đợt ----------
-- Lõi dùng chung cho xa_vai_it_attach (web gắn trước khi lưu) và _xa_vai_measure_save_body (máy chủ tự gắn khi web không gắn được — review vòng 1:
-- check lỗi / web cũ thì UID cùng SKU bị lưu mà không vào đợt). Khoá giao dịch theo Group UID rồi xét lại: một UID chỉ thuộc MỘT đợt
-- (đã ở chính đợt này → idempotent; đã ở đợt khác → ALREADY_IN_BATCH kèm đợt đó). Thứ tự khoá: Group UID → dòng đợt (FOR UPDATE).
create or replace function public._xa_vai_it_attach_core(p_code text, p_it text, p_device uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_gd public.group_uid_details;
  v_sku text;
  v_batch public.xa_vai_it_batches;
  v_other record;
  v_name text;
  v_added boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('xa_vai_it_uid:' || p_code, 0));
  select x.it_number, b.item_code into v_other
    from public.xa_vai_it_uids x join public.xa_vai_it_batches b on b.it_number = x.it_number
   where x.group_uid_code = p_code
   order by (x.it_number = p_it) desc, x.added_at desc limit 1;
  if found then
    if v_other.it_number = p_it then
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('itNumber', p_it, 'itemCode', v_other.item_code, 'attached', false));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ALREADY_IN_BATCH', 'message', 'Group UID đã thuộc đợt xả khác',
      'itNumber', v_other.it_number, 'itemCode', v_other.item_code));
  end if;
  select g.* into v_gd from public.group_uid_details g where g.group_uid_code = p_code;
  v_sku := btrim(coalesce(v_gd.sku, ''));
  if v_gd.group_uid_code is null or v_sku = '' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'GROUP_UID_NOT_READY', 'message', 'Group UID chưa có dữ liệu SKU'));
  end if;
  select b.* into v_batch from public.xa_vai_it_batches b where b.it_number = p_it for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Chưa nạp phiếu IT này'));
  end if;
  if v_batch.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'BATCH_DONE', 'message', 'Đợt xả này đã đóng'));
  end if;
  select l->>'name' into v_name from jsonb_array_elements(v_batch.lines) as l where l->>'sku' = v_sku limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SKU_NOT_IN_BATCH', 'message', 'SKU của Group UID không có trong phiếu IT này'));
  end if;
  insert into public.xa_vai_it_uids (it_number, group_uid_code, sku, batch_code, roll_code, wms_qty, wms_mm, rfid, source, added_device)
  values (p_it, p_code, v_sku, left(btrim(coalesce(v_gd.batch_code, '')), 120), left(btrim(coalesce(v_gd.roll_code, '')), 120), v_gd.qty,
          public.xa_vai_system_mm(v_name, v_gd.qty), left(nullif(btrim(coalesce(v_gd.group_rfid_mapping, '')), ''), 40), 'scan', p_device)
  on conflict (it_number, group_uid_code) do nothing;
  v_added := found;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('itNumber', p_it, 'itemCode', v_batch.item_code, 'attached', v_added));
end $$;
revoke all on function public._xa_vai_it_attach_core(text, text, uuid) from public, anon, authenticated;

create or replace function public._xa_vai_it_attach_body(p_access_token text, p_group_uid text, p_it_number text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := btrim(coalesce(p_group_uid, ''));
  v_it text := btrim(coalesce(p_it_number, ''));
begin
  if v_code !~ '^[0-9]{16}$' or v_it !~ '^[0-9]{16}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Mã Group UID hoặc số phiếu IT không hợp lệ'));
  end if;
  return public._xa_vai_it_attach_core(v_code, v_it, public.print_device_by_token(p_access_token))
    || jsonb_build_object('meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public._xa_vai_it_attach_body(text, text, text) from public, anon, authenticated;

create or replace function public.xa_vai_it_attach(p_access_token text, p_group_uid text, p_it_number text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_it_attach');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_it_attach_body(p_access_token, p_group_uid, p_it_number));
end $$;

-- ---------- Báo vận hành kho: UID khác SKU bị chặn ----------
-- Máy chủ xét lại trạng thái; chỉ ghi khi other_sku (đợt vừa đóng / UID vừa được gắn thì không ghi nhầm).
create or replace function public._xa_vai_it_report_body(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := btrim(coalesce(p_group_uid, ''));
  v_sku text;
  v_state jsonb;
begin
  if v_code !~ '^[0-9]{16}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  select btrim(g.sku) into v_sku from public.group_uid_details g where g.group_uid_code = v_code;
  if coalesce(v_sku, '') = '' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'GROUP_UID_NOT_READY', 'message', 'Group UID chưa có dữ liệu SKU'));
  end if;
  v_state := public._xa_vai_it_state(v_code, v_sku);
  if v_state->>'state' <> 'other_sku' then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('reported', false, 'state', v_state->>'state'));
  end if;
  insert into public.xa_vai_it_reports as r (group_uid_code, sku, device_id, open_items)
  values (v_code, left(v_sku, 40), public.print_device_by_token(p_access_token),
          left((select string_agg(x, ', ' order by x) from jsonb_array_elements_text(v_state->'openItems') as t(x)), 400))
  on conflict (group_uid_code) do update set
    sku = excluded.sku, last_at = now(), scan_count = least(r.scan_count, 1000000) + 1,
    device_id = coalesce(excluded.device_id, r.device_id), open_items = excluded.open_items;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('reported', true, 'state', 'other_sku'),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public._xa_vai_it_report_body(text, text) from public, anon, authenticated;

create or replace function public.xa_vai_it_report(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_it_report');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_it_report_body(p_access_token, p_group_uid));
end $$;

-- ---------- Admin đóng / mở lại đợt ----------
create or replace function public.xa_vai_it_set_status(p_it_number text, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_it text := btrim(coalesce(p_it_number, ''));
  v_status text := btrim(coalesce(p_status, ''));
  v_row public.xa_vai_it_batches;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được đóng / mở đợt xả'));
  end if;
  if v_it !~ '^[0-9]{16}$' or v_status not in ('open', 'done') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Số phiếu IT hoặc trạng thái không hợp lệ'));
  end if;
  update public.xa_vai_it_batches set status = v_status,
         closed_at = case when v_status = 'done' then coalesce(closed_at, now()) end,
         closed_by = case when v_status = 'done' then coalesce(closed_by, (select auth.uid())) end
   where it_number = v_it
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Chưa nạp phiếu IT này'));
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('itNumber', v_row.it_number, 'status', v_row.status, 'closedAt', v_row.closed_at),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- ---------- Báo cáo "Ngoài phiếu" cho vận hành kho ----------
-- attached = UID cùng SKU gắn khi quét (source 'scan'); outside = UID khác SKU bị chặn. Mới nhất trước, mỗi loại tối đa p_limit (1–2000).
create or replace function public.xa_vai_it_outside(p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_attached jsonb;
  v_outside jsonb;
begin
  select coalesce(jsonb_agg(q.j order by q.added_at desc, q.group_uid_code), '[]'::jsonb) into v_attached
    from (select x.added_at, x.group_uid_code,
                 jsonb_build_object('groupUid', x.group_uid_code, 'sku', x.sku, 'itNumber', x.it_number, 'itemCode', b.item_code, 'batchStatus', b.status,
                   'addedAt', x.added_at, 'device', d.name, 'state', coalesce(m.status, 'new'), 'actualMm', m.actual_mm, 'wmsMm', x.wms_mm) as j
            from public.xa_vai_it_uids x
            join public.xa_vai_it_batches b on b.it_number = x.it_number
            left join public.xa_vai_measures m on m.group_uid_code = x.group_uid_code
            left join public.print_devices d on d.id = x.added_device
           where x.source = 'scan'
           order by x.added_at desc, x.group_uid_code limit v_limit) q;
  select coalesce(jsonb_agg(q.j order by q.last_at desc, q.group_uid_code), '[]'::jsonb) into v_outside
    from (select r.last_at, r.group_uid_code,
                 jsonb_build_object('groupUid', r.group_uid_code, 'sku', r.sku, 'firstAt', r.first_at, 'lastAt', r.last_at, 'scanCount', r.scan_count,
                   'device', d.name, 'openItems', r.open_items) as j
            from public.xa_vai_it_reports r
            left join public.print_devices d on d.id = r.device_id
           order by r.last_at desc, r.group_uid_code limit v_limit) q;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('attached', v_attached, 'outside', v_outside,
      'attachedTotal', (select count(*) from public.xa_vai_it_uids x where x.source = 'scan'), 'outsideTotal', (select count(*) from public.xa_vai_it_reports)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- ---------- Thay hàm v1 (cùng chữ ký) ----------
create or replace function public.xa_vai_it_save(p_batch jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_it text := btrim(coalesce(p_batch->>'itNumber', ''));
  v_code text := public._xa_vai_item_code(p_batch->>'itemCode');
  v_lines jsonb := p_batch->'lines';
  v_uids jsonb := p_batch->'uids';
  v_clean jsonb;
  v_n integer;
  v_bad integer;
  v_delivered numeric;
  v_created boolean;
  v_added integer;
  v_total integer;
  v_at timestamptz;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được nạp phiếu IT'));
  end if;
  if jsonb_typeof(p_batch) is distinct from 'object' or v_it !~ '^[0-9]{16}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Số phiếu IT không hợp lệ'));
  end if;
  if v_code is null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEM_CODE', 'message', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)'));
  end if;
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Phiếu IT phải có 1–200 dòng SKU'));
  end if;
  if jsonb_typeof(v_uids) is distinct from 'array' or jsonb_array_length(v_uids) > 3000 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Danh sách Group UID không hợp lệ (tối đa 3.000)'));
  end if;

  -- Dòng: SKU hợp lệ, không trùng; deliveredQty là số ≥ 0; requestedQty là số ≥ 0 hoặc trống.
  select count(*) filter (where jsonb_typeof(l) <> 'object'
            or coalesce(btrim(l->>'sku'), '') !~ '^[A-Za-z0-9._-]{1,40}$'
            or case when jsonb_typeof(l->'deliveredQty') = 'number' then (l->>'deliveredQty')::numeric < 0 else true end
            or case when jsonb_typeof(l->'requestedQty') = 'number' then (l->>'requestedQty')::numeric < 0
                    else jsonb_typeof(l->'requestedQty') is distinct from 'null' and l ? 'requestedQty' end),
         count(*) - count(distinct btrim(l->>'sku'))
    into v_bad, v_n
    from jsonb_array_elements(v_lines) as t(l);
  if v_bad > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Dòng SKU của phiếu IT không hợp lệ'));
  end if;
  if v_n > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'SKU lặp ở nhiều dòng của phiếu IT; hãy Reload Extension rồi đọc lại'));
  end if;
  select coalesce(sum((l->>'deliveredQty')::numeric), 0) into v_delivered from jsonb_array_elements(v_lines) as t(l);

  -- UID: 16 chữ số, SKU nằm trong các dòng, qty là số ≥ 0 hoặc trống.
  select count(*) into v_bad
    from jsonb_array_elements(v_uids) as t(u)
   where jsonb_typeof(u) <> 'object'
      or coalesce(btrim(u->>'groupUid'), '') !~ '^[0-9]{16}$'
      or not exists (select 1 from jsonb_array_elements(v_lines) as x(l) where btrim(l->>'sku') = btrim(u->>'sku'))
      or case when jsonb_typeof(u->'qty') = 'number' then (u->>'qty')::numeric < 0
              else jsonb_typeof(u->'qty') is distinct from 'null' and u ? 'qty' end;
  if v_bad > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Group UID của phiếu IT không hợp lệ'));
  end if;
  if v_delivered <= 0 or jsonb_array_length(v_uids) = 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_DELIVERED', 'message', 'Phiếu IT chưa xuất hoặc chưa có Group UID'));
  end if;

  -- Dòng chuẩn hoá: mm theo tên SKU của WMS (trường cuối sau '/': m / mm / g) — cùng hàm với mét hệ thống của xa_vai_measures.
  select jsonb_agg(jsonb_build_object(
           'sku', btrim(l->>'sku'),
           'name', left(nullif(btrim(coalesce(l->>'name', '')), ''), 300),
           'unit', left(nullif(btrim(coalesce(l->>'unit', '')), ''), 20),
           'requestedQty', case when jsonb_typeof(l->'requestedQty') = 'number' then (l->>'requestedQty')::numeric end,
           'deliveredQty', (l->>'deliveredQty')::numeric,
           'deliveredMm', public.xa_vai_system_mm(l->>'name', (l->>'deliveredQty')::numeric)) order by n)
    into v_clean
    from jsonb_array_elements(v_lines) with ordinality as t(l, n);

  begin
    v_at := nullif(btrim(coalesce(p_batch->>'createdAt', '')), '')::timestamptz;
  exception when others then
    v_at := null;
  end;

  insert into public.xa_vai_it_batches as b (it_number, it_id, mapping_id, item_code, description, it_status, from_warehouse, to_warehouse, it_created_at, lines, loaded_at, loaded_by)
  values (v_it,
          case when coalesce(p_batch->>'itId', '') ~ '^[0-9]{1,18}$' then (p_batch->>'itId')::bigint end,
          case when coalesce(p_batch->>'mappingId', '') ~ '^[0-9]{6,40}$' then p_batch->>'mappingId' end,
          v_code,
          left(nullif(btrim(coalesce(p_batch->>'description', '')), ''), 500),
          left(nullif(btrim(coalesce(p_batch->>'status', '')), ''), 60),
          left(nullif(btrim(coalesce(p_batch->>'fromWarehouse', '')), ''), 240),
          left(nullif(btrim(coalesce(p_batch->>'toWarehouse', '')), ''), 240),
          v_at, v_clean, now(), v_actor)
  on conflict (it_number) do update set
    it_id = coalesce(excluded.it_id, b.it_id), mapping_id = coalesce(excluded.mapping_id, b.mapping_id), item_code = excluded.item_code,
    description = excluded.description, it_status = excluded.it_status, from_warehouse = excluded.from_warehouse,
    to_warehouse = excluded.to_warehouse, it_created_at = coalesce(excluded.it_created_at, b.it_created_at), lines = excluded.lines,
    loaded_at = now(), loaded_by = excluded.loaded_by
  returning (xmax = 0) into v_created;

  -- Thêm / cập nhật UID (không gỡ UID của lần nạp trước). Trùng mã trong cùng lần gửi: giữ dòng đầu. UID gắn khi quét (source 'scan')
  -- mà nay WMS trả cho phiếu → thành UID của phiếu (source 'it'; v2).
  with src as (
    select distinct on (btrim(u->>'groupUid')) btrim(u->>'groupUid') as code, btrim(u->>'sku') as sku,
           left(btrim(coalesce(u->>'lot', '')), 120) as lot, left(btrim(coalesce(u->>'roll', '')), 120) as roll,
           case when jsonb_typeof(u->'qty') = 'number' then (u->>'qty')::numeric end as qty,
           left(nullif(btrim(coalesce(u->>'rfid', '')), ''), 40) as rfid, n
      from jsonb_array_elements(v_uids) with ordinality as t(u, n)
     order by btrim(u->>'groupUid'), n
  ), up as (
    insert into public.xa_vai_it_uids as x (it_number, group_uid_code, sku, batch_code, roll_code, wms_qty, wms_mm, rfid)
    select v_it, s.code, s.sku, s.lot, s.roll, s.qty,
           public.xa_vai_system_mm((select l->>'name' from jsonb_array_elements(v_clean) as c(l) where l->>'sku' = s.sku limit 1), s.qty),
           s.rfid
      from src s
    on conflict (it_number, group_uid_code) do update set
      sku = excluded.sku, batch_code = excluded.batch_code, roll_code = excluded.roll_code, wms_qty = excluded.wms_qty,
      wms_mm = excluded.wms_mm, rfid = coalesce(excluded.rfid, x.rfid), source = 'it'
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_added from up;
  delete from public.xa_vai_it_uids x
   where x.source = 'scan' and x.it_number <> v_it
     and x.group_uid_code in (select btrim(u->>'groupUid') from jsonb_array_elements(v_uids) as t(u));
  select count(*) into v_total from public.xa_vai_it_uids u where u.it_number = v_it;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('itNumber', v_it, 'itemCode', v_code, 'created', v_created,
    'uidsAdded', v_added, 'uidsTotal', v_total), 'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Tiến độ (v2): + batchStatus, closedAt, outsideCount (UID gắn khi quét) tổng và từng dòng.
create or replace function public._xa_vai_it_json(p_batch public.xa_vai_it_batches)
returns jsonb language sql stable set search_path = '' as $$
  with agg as (
    select x.sku, count(*) as uid_count, sum(x.wms_mm) as uid_mm, count(m.group_uid_code) as measured_count,
           count(*) filter (where m.status = 'printed') as printed_count, sum(m.actual_mm) as actual_mm, sum(m.system_mm) as system_mm,
           count(*) filter (where x.source = 'scan') as scan_count
      from public.xa_vai_it_uids x
      left join public.xa_vai_measures m on m.group_uid_code = x.group_uid_code
     where x.it_number = p_batch.it_number
     group by x.sku
  ), per as (
    select t.l, t.n, coalesce(a.uid_count, 0) as uid_count, a.uid_mm, coalesce(a.measured_count, 0) as measured_count,
           coalesce(a.printed_count, 0) as printed_count, a.actual_mm, a.system_mm, coalesce(a.scan_count, 0) as scan_count
      from jsonb_array_elements(p_batch.lines) with ordinality as t(l, n)
      left join agg a on a.sku = t.l->>'sku'
  )
  select jsonb_build_object(
    'itNumber', p_batch.it_number, 'itemCode', p_batch.item_code, 'description', p_batch.description, 'status', p_batch.it_status,
    'fromWarehouse', p_batch.from_warehouse, 'toWarehouse', p_batch.to_warehouse, 'itCreatedAt', p_batch.it_created_at,
    'loadedAt', p_batch.loaded_at, 'batchStatus', p_batch.status, 'closedAt', p_batch.closed_at,
    'outsideCount', (select coalesce(sum(per.scan_count), 0) from per),
    'uidCount', (select coalesce(sum(per.uid_count), 0) from per), 'measuredCount', (select coalesce(sum(per.measured_count), 0) from per),
    'printedCount', (select coalesce(sum(per.printed_count), 0) from per),
    'lines', coalesce((select jsonb_agg(per.l || jsonb_build_object('uidCount', per.uid_count, 'uidMm', per.uid_mm, 'measuredCount', per.measured_count,
               'printedCount', per.printed_count, 'actualMm', per.actual_mm, 'systemMm', per.system_mm, 'outsideCount', per.scan_count) order by per.n) from per), '[]'::jsonb))
$$;
revoke all on function public._xa_vai_it_json(public.xa_vai_it_batches) from public, anon, authenticated;

-- Danh sách (v2): đợt Đang xả trước, rồi mới nạp trước.
create or replace function public.xa_vai_it_list(p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_total integer;
  v_items jsonb;
begin
  select count(*) into v_total from public.xa_vai_it_batches;
  select coalesce(jsonb_agg(public._xa_vai_it_json(q.b) order by q.open desc, q.loaded_at desc, q.it_number), '[]'::jsonb) into v_items
    from (select b, b.status = 'open' as open, b.loaded_at, b.it_number from public.xa_vai_it_batches b
           order by b.status = 'open' desc, b.loaded_at desc, b.it_number limit v_limit) q;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', v_items, 'total', v_total),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Chi tiết (v2): + source ('it' | 'scan'), addedAt của từng UID.
create or replace function public.xa_vai_it_get(p_it_number text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_it text := btrim(coalesce(p_it_number, ''));
  v_batch public.xa_vai_it_batches;
  v_uids jsonb;
begin
  if v_it !~ '^[0-9]{16}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Số phiếu IT không hợp lệ'));
  end if;
  select b.* into v_batch from public.xa_vai_it_batches b where b.it_number = v_it;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Chưa nạp phiếu IT này'));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('groupUid', x.group_uid_code, 'sku', x.sku, 'lot', x.batch_code, 'roll', x.roll_code,
           'wmsMm', x.wms_mm, 'rfid', x.rfid, 'state', coalesce(m.status, 'new'), 'actualMm', m.actual_mm, 'systemMm', m.system_mm,
           'measuredAt', m.measured_at, 'printedItemCode', m.item_code, 'source', x.source, 'addedAt', x.added_at)
           order by x.sku, x.batch_code, x.roll_code, x.group_uid_code), '[]'::jsonb)
    into v_uids
    from public.xa_vai_it_uids x
    left join public.xa_vai_measures m on m.group_uid_code = x.group_uid_code
   where x.it_number = v_it;
  return jsonb_build_object('ok', true, 'data', public._xa_vai_it_json(v_batch) || jsonb_build_object('uids', v_uids),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Lưu mét (v2): bản đang chạy (xa_vai_a4_v1.sql, khớp pg_get_functiondef 05/11/2026) + chặn OUTSIDE_BATCH.
create or replace function public._xa_vai_measure_save_body(p_access_token text, p_group_uid text, p_actual_mm numeric, p_replace boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(coalesce(p_group_uid, '')), '');
  v_mm numeric;
  v_gd public.group_uid_details;
  v_sku text;
  v_name text;
  v_sys numeric;
  v_row public.xa_vai_measures;
  v_try integer := 0;
  v_it_state jsonb;
  v_attach jsonb;
begin
  if v_code is null or length(v_code) > 40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  -- p_actual_mm: mm (web đổi mét người dùng nhập × 1000); tối đa 100000000 mm = 100.000 m.
  if p_actual_mm is null or p_actual_mm = 'NaN'::numeric or p_actual_mm <= 0 or p_actual_mm > 100000000 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_QTY', 'message', 'Mét thực tế phải lớn hơn 0 và không quá 100.000 m'));
  end if;
  v_mm := round(p_actual_mm, 0);
  if v_mm <= 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_QTY', 'message', 'Mét thực tế phải lớn hơn 0 và không quá 100.000 m'));
  end if;
  select g.* into v_gd from public.group_uid_details g where g.group_uid_code = v_code;
  v_sku := btrim(coalesce(v_gd.sku, ''));
  if v_gd.group_uid_code is null or v_sku = '' or length(v_sku) > 40 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'GROUP_UID_NOT_READY', 'message', 'Group UID chưa có dữ liệu SKU. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  -- Xả vải theo phiếu IT (xa_vai_it_v2, 05/11/2026): UID CHƯA có mét, khác SKU với mọi đợt đang xả (có ít nhất một đợt mở) → không lưu
  -- (web đã báo vận hành kho qua xa_vai_it_report). Sửa mét UID đã có dòng vẫn được. Không có đợt mở → đo tự do như trước.
  -- UID CÙNG SKU với đợt mở mà chưa gắn (web không kiểm được: mạng / web cũ): một đợt → tự gắn trong cùng giao dịch; nhiều đợt → NEED_BATCH.
  if not exists (select 1 from public.xa_vai_measures m where m.group_uid_code = v_code) then
    v_it_state := public._xa_vai_it_state(v_code, v_sku);
    if v_it_state->>'state' = 'other_sku' then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'OUTSIDE_BATCH', 'message', 'Group UID nằm ngoài đợt xả vải đang mở'));
    end if;
    if v_it_state->>'state' = 'same_sku' then
      if jsonb_array_length(v_it_state->'batches') > 1 then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NEED_BATCH', 'message', 'Chọn phiếu IT cho Group UID này', 'batches', v_it_state->'batches'));
      end if;
      v_attach := public._xa_vai_it_attach_core(v_code, v_it_state->'batches'->0->>'itNumber', public.print_device_by_token(p_access_token));
      if not coalesce((v_attach->>'ok')::boolean, false) and v_attach->'error'->>'code' <> 'ALREADY_IN_BATCH' then
        return v_attach;
      end if;
    end if;
  end if;
  select btrim(coalesce(s.product_name, '')) into v_name from public."SKU_Name" s where s.sku = v_sku;
  v_sys := public.xa_vai_system_mm(v_name, v_gd.qty);
  if v_sys >= 100000000000 then
    v_sys := null; -- ≥ 1e11 mm: tên SKU ghi gsm / khổ bất thường, coi như không quy đổi được (hàm đã chặn, giữ phòng khi hàm đổi)
  end if;
  -- Chống đua: chèn nếu chưa có; có rồi (kể cả máy khác vừa chèn) thì khoá dòng và xét trạng thái.
  loop
    insert into public.xa_vai_measures(group_uid_code, sku, batch_code, roll_code, system_qty, system_mm, actual_mm, device_id)
    values (v_code, v_sku, btrim(coalesce(v_gd.batch_code, '')), btrim(coalesce(v_gd.roll_code, '')), v_gd.qty, v_sys, v_mm,
            public.print_device_by_token(p_access_token))
    on conflict (group_uid_code) do nothing
    returning * into v_row;
    if found then
      return jsonb_build_object('ok', true, 'data', jsonb_build_object('item', public._xa_vai_item_json(v_row), 'replaced', false),
        'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
    end if;
    select m.* into v_row from public.xa_vai_measures m where m.group_uid_code = v_code for update;
    exit when found;
    v_try := v_try + 1;
    if v_try >= 3 then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'RETRY', 'message', 'Dữ liệu vừa thay đổi, hãy lưu lại'));
    end if;
  end loop;
  if v_row.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_PENDING',
      'message', case when v_row.status = 'printed' then 'Group UID này đã in phiếu' else 'Group UID này đang in phiếu' end,
      'state', v_row.status));
  end if;
  if not coalesce(p_replace, false) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ALREADY_MEASURED',
      'message', 'Group UID này đã có mét thực tế', 'item', public._xa_vai_item_json(v_row)));
  end if;
  update public.xa_vai_measures set actual_mm = v_mm, measured_at = now()
   where group_uid_code = v_code
  returning * into v_row;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('item', public._xa_vai_item_json(v_row), 'replaced', true),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public._xa_vai_measure_save_body(text, text, numeric, boolean) from public, anon, authenticated;

revoke all on function public.xa_vai_it_check(text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_check(text) to anon, authenticated;
revoke all on function public.xa_vai_it_attach(text, text, text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_attach(text, text, text) to anon, authenticated;
revoke all on function public.xa_vai_it_report(text, text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_report(text, text) to anon, authenticated;
revoke all on function public.xa_vai_it_set_status(text, text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_set_status(text, text) to authenticated;
revoke all on function public.xa_vai_it_outside(integer) from public, anon, authenticated;
grant execute on function public.xa_vai_it_outside(integer) to anon, authenticated;
revoke all on function public.xa_vai_it_save(jsonb) from public, anon, authenticated;
grant execute on function public.xa_vai_it_save(jsonb) to authenticated;
revoke all on function public.xa_vai_it_list(integer) from public, anon, authenticated;
grant execute on function public.xa_vai_it_list(integer) to anon, authenticated;
revoke all on function public.xa_vai_it_get(text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_get(text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
