-- Xả vải theo phiếu IT (05/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md).
--
-- Vì sao: người dùng (05/11) "admin nhập phiếu IT load WMS sẽ được thông tin mã hàng và số lượng từng SKU" + "SL đã xuất và lấy
-- thông tin group UID của phiếu này luôn"; chốt: đợt xả theo IT lưu Supabase, quét UID tự gắn vào đợt, tiến độ từng SKU, In A4 lấy
-- mã hàng của đợt. Extension 0.12.6 (lệnh GET_XA_VAI_IT) đọc phiếu + Group UID; web gửi nguyên kết quả cho xa_vai_it_save.
--
-- Tác động:
--   * Bảng mới public.xa_vai_it_batches (một dòng / phiếu IT: mã hàng, đầu phiếu, các dòng SKU dạng jsonb) và public.xa_vai_it_uids
--     (Group UID của phiếu lúc Admin nạp). RLS bật, không policy, không quyền anon / authenticated; chỉ đi qua hàm.
--   * Hàm mới:
--     - xa_vai_it_save(p_batch jsonb): chỉ Admin (print_admin_allowed(), JWT phiên Admin), authenticated. Nạp lại cùng phiếu: cập
--       nhật đầu phiếu + dòng + mã hàng, THÊM UID mới, KHÔNG gỡ UID cũ (WMS chỉ trả UID mà IT là nguồn gần nhất).
--     - xa_vai_it_list(p_limit), xa_vai_it_get(p_it_number), xa_vai_it_of_uids(p_uids): đọc, anon + authenticated.
--   * Không đổi bảng / hàm có sẵn (xa_vai_measures, xa_vai_measure_*, xa_vai_print_enqueue): liên kết UID ↔ đợt bằng group_uid_code.
--   Phân loại: tương thích ngược (web cũ không gọi hàm mới).
-- Không DROP, không xoá dữ liệu → không cần --allow-destructive. Chạy lại nhiều lần được (if not exists / create or replace).
-- Thứ tự lên: commit (chưa push) → migration này → người dùng Reload Extension 0.12.6 → push web (tab Phiếu IT).
-- Kiểm cục bộ: node tests/xa_vai_it_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_it_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_it_v1.sql
-- kiem: select to_regclass('public.xa_vai_it_batches') is not null and to_regclass('public.xa_vai_it_uids') is not null and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.xa_vai_it_batches')), false) and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.xa_vai_it_uids')), false) and to_regprocedure('public.xa_vai_it_save(jsonb)') is not null and not has_function_privilege('anon', 'public.xa_vai_it_save(jsonb)', 'execute') and has_function_privilege('authenticated', 'public.xa_vai_it_save(jsonb)', 'execute') and has_function_privilege('anon', 'public.xa_vai_it_list(integer)', 'execute') and has_function_privilege('anon', 'public.xa_vai_it_get(text)', 'execute') and has_function_privilege('anon', 'public.xa_vai_it_of_uids(text[])', 'execute') and not has_table_privilege('anon', 'public.xa_vai_it_batches', 'select') and not has_table_privilege('authenticated', 'public.xa_vai_it_uids', 'select')
-- Rút lui (web mới báo lỗi ở tab Phiếu IT; mất các đợt đã nạp nếu drop bảng; chạy kèm --allow-destructive):
--   drop function if exists public.xa_vai_it_of_uids(text[]);
--   drop function if exists public.xa_vai_it_get(text);
--   drop function if exists public.xa_vai_it_list(integer);
--   drop function if exists public.xa_vai_it_save(jsonb);
--   drop table if exists public.xa_vai_it_uids;
--   drop table if exists public.xa_vai_it_batches;
begin;

-- ---------- Bảng ----------
create table if not exists public.xa_vai_it_batches (
  it_number text primary key check (it_number ~ '^[0-9]{16}$'),
  it_id bigint,
  mapping_id text check (mapping_id is null or mapping_id ~ '^[0-9]{6,40}$'),
  item_code text not null check (item_code ~ '^[0-9A-Z._-]{1,40}$'),
  description text check (description is null or length(description) <= 500),
  it_status text check (it_status is null or length(it_status) <= 60),
  from_warehouse text check (from_warehouse is null or length(from_warehouse) <= 240),
  to_warehouse text check (to_warehouse is null or length(to_warehouse) <= 240),
  it_created_at timestamptz,
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  loaded_at timestamptz not null default now(),
  loaded_by uuid,
  created_at timestamptz not null default now()
);
comment on table public.xa_vai_it_batches is
  'Đợt xả vải theo phiếu IT (Admin nạp từ WMS qua Extension): mã hàng (tách từ ghi chú phiếu, Admin sửa được) + các dòng SKU {sku, name, unit, requestedQty, deliveredQty, deliveredMm}. Số lượng = SL đã xuất.';
create index if not exists xa_vai_it_batches_loaded_idx on public.xa_vai_it_batches (loaded_at desc);
alter table public.xa_vai_it_batches enable row level security;
revoke all on table public.xa_vai_it_batches from public, anon, authenticated;
grant select, insert, update, delete on table public.xa_vai_it_batches to service_role;

create table if not exists public.xa_vai_it_uids (
  it_number text not null references public.xa_vai_it_batches(it_number) on delete cascade,
  group_uid_code text not null check (group_uid_code ~ '^[0-9]{16}$'),
  sku text not null check (length(sku) between 1 and 40),
  batch_code text not null default '',
  roll_code text not null default '',
  wms_qty numeric,
  wms_mm numeric(14,0),
  rfid text,
  added_at timestamptz not null default now(),
  primary key (it_number, group_uid_code)
);
comment on table public.xa_vai_it_uids is
  'Group UID của một phiếu IT lúc Admin nạp (WMS group-uid-infos theo processing_source_code = mapping_id của IT). Nạp lại chỉ thêm / cập nhật, không gỡ.';
-- Tra đợt theo UID (pop-up quét, In A4) và join với xa_vai_measures.
create index if not exists xa_vai_it_uids_uid_idx on public.xa_vai_it_uids (group_uid_code);
alter table public.xa_vai_it_uids enable row level security;
revoke all on table public.xa_vai_it_uids from public, anon, authenticated;
grant select, insert, update, delete on table public.xa_vai_it_uids to service_role;

-- ---------- xa_vai_it_save: Admin nạp / nạp lại một phiếu ----------
-- p_batch = { itNumber, itId, mappingId, itemCode, description, status, fromWarehouse, toWarehouse, createdAt,
--             lines: [{ sku, name, unit, requestedQty, deliveredQty }], uids: [{ groupUid, sku, lot, roll, qty, rfid }] }
-- Kiểm: số phiếu 16 chữ số; mã hàng theo _xa_vai_item_code; 1–200 dòng, SKU không trùng; 1–3000 UID, SKU của UID phải có trong dòng;
-- số lượng là số ≥ 0 (ép kiểu chỉ trong CASE sau khi biết là số: OR không bảo đảm thứ tự). Phiếu chưa xuất (tổng SL đã xuất = 0) hoặc không có UID → NOT_DELIVERED.
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
  if v_bad > 0 or v_n > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Dòng SKU của phiếu IT không hợp lệ'));
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

  -- Thêm / cập nhật UID (không gỡ UID của lần nạp trước). Trùng mã trong cùng lần gửi: giữ dòng đầu.
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
      wms_mm = excluded.wms_mm, rfid = coalesce(excluded.rfid, x.rfid)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_added from up;
  select count(*) into v_total from public.xa_vai_it_uids u where u.it_number = v_it;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('itNumber', v_it, 'itemCode', v_code, 'created', v_created,
    'uidsAdded', v_added, 'uidsTotal', v_total), 'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- ---------- Đọc (mọi người, không token) ----------
-- Tiến độ của đợt: theo từng dòng SKU (giữ thứ tự WMS) — uidCount / uidMm = UID của phiếu, measuredCount / actualMm / systemMm = UID đã
-- có dòng xa_vai_measures (mọi trạng thái), printedCount = UID đã in phiếu A4.
create or replace function public._xa_vai_it_json(p_batch public.xa_vai_it_batches)
returns jsonb language sql stable set search_path = '' as $$
  with u as (
    select x.sku, x.wms_mm, m.status, m.actual_mm, m.system_mm
      from public.xa_vai_it_uids x
      left join public.xa_vai_measures m on m.group_uid_code = x.group_uid_code
     where x.it_number = p_batch.it_number
  ), per as (
    select l, n,
           (select count(*) from u where u.sku = l->>'sku') as uid_count,
           (select sum(u.wms_mm) from u where u.sku = l->>'sku') as uid_mm,
           (select count(*) from u where u.sku = l->>'sku' and u.status is not null) as measured_count,
           (select count(*) from u where u.sku = l->>'sku' and u.status = 'printed') as printed_count,
           (select sum(u.actual_mm) from u where u.sku = l->>'sku') as actual_mm,
           (select sum(u.system_mm) from u where u.sku = l->>'sku' and u.status is not null) as system_mm
      from jsonb_array_elements(p_batch.lines) with ordinality as t(l, n)
  )
  select jsonb_build_object(
    'itNumber', p_batch.it_number, 'itemCode', p_batch.item_code, 'description', p_batch.description, 'status', p_batch.it_status,
    'fromWarehouse', p_batch.from_warehouse, 'toWarehouse', p_batch.to_warehouse, 'itCreatedAt', p_batch.it_created_at,
    'loadedAt', p_batch.loaded_at,
    'uidCount', (select count(*) from u), 'measuredCount', (select count(*) from u where u.status is not null),
    'printedCount', (select count(*) from u where u.status = 'printed'),
    'lines', coalesce((select jsonb_agg(per.l || jsonb_build_object('uidCount', per.uid_count, 'uidMm', per.uid_mm, 'measuredCount', per.measured_count,
               'printedCount', per.printed_count, 'actualMm', per.actual_mm, 'systemMm', per.system_mm) order by per.n) from per), '[]'::jsonb))
$$;
revoke all on function public._xa_vai_it_json(public.xa_vai_it_batches) from public, anon, authenticated;

-- Đợt mới nạp trước; p_limit kẹp 1–100.
create or replace function public.xa_vai_it_list(p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_total integer;
  v_items jsonb;
begin
  select count(*) into v_total from public.xa_vai_it_batches;
  select coalesce(jsonb_agg(public._xa_vai_it_json(q.b) order by q.loaded_at desc, q.it_number), '[]'::jsonb) into v_items
    from (select b, b.loaded_at, b.it_number from public.xa_vai_it_batches b order by b.loaded_at desc, b.it_number limit v_limit) q;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', v_items, 'total', v_total),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Một đợt + từng UID: state = trạng thái dòng xa_vai_measures ('new' khi chưa đo), printedItemCode = mã hàng đã in (có thể khác mã của đợt).
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
           'measuredAt', m.measured_at, 'printedItemCode', m.item_code)
           order by x.sku, x.batch_code, x.roll_code, x.group_uid_code), '[]'::jsonb)
    into v_uids
    from public.xa_vai_it_uids x
    left join public.xa_vai_measures m on m.group_uid_code = x.group_uid_code
   where x.it_number = v_it;
  return jsonb_build_object('ok', true, 'data', public._xa_vai_it_json(v_batch) || jsonb_build_object('uids', v_uids),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Đợt của từng UID (pop-up quét, điền sẵn mã hàng khi In A4): tối đa 500 mã / lần; UID ở nhiều đợt → đợt nạp gần nhất; UID không thuộc
-- đợt nào thì không có trong kết quả.
create or replace function public.xa_vai_it_of_uids(p_uids text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_codes text[];
  v_items jsonb;
begin
  select coalesce(array_agg(distinct btrim(x)), '{}'::text[]) into v_codes
    from unnest(coalesce(p_uids, '{}'::text[])) as x
   where nullif(btrim(x), '') is not null;
  if cardinality(v_codes) > 500 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Mỗi lần tra tối đa 500 Group UID'));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('groupUid', q.group_uid_code, 'itNumber', q.it_number, 'itemCode', q.item_code) order by q.group_uid_code), '[]'::jsonb)
    into v_items
    from (select distinct on (x.group_uid_code) x.group_uid_code, b.it_number, b.item_code
            from public.xa_vai_it_uids x
            join public.xa_vai_it_batches b on b.it_number = x.it_number
           where x.group_uid_code = any(v_codes)
           order by x.group_uid_code, b.loaded_at desc, b.it_number) q;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', v_items),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

revoke all on function public.xa_vai_it_save(jsonb) from public, anon, authenticated;
grant execute on function public.xa_vai_it_save(jsonb) to authenticated;
revoke all on function public.xa_vai_it_list(integer) from public, anon, authenticated;
grant execute on function public.xa_vai_it_list(integer) to anon, authenticated;
revoke all on function public.xa_vai_it_get(text) from public, anon, authenticated;
grant execute on function public.xa_vai_it_get(text) to anon, authenticated;
revoke all on function public.xa_vai_it_of_uids(text[]) from public, anon, authenticated;
grant execute on function public.xa_vai_it_of_uids(text[]) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
