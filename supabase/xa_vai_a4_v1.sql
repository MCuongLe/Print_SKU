-- THEO DÕI XẢ VẢI · mét thực tế → hàng đợi → phiếu A4 (04/11/2026, kế hoạch docs/plans/2026-11-04-xa-vai-met-thuc-te-a4.md,
-- hợp đồng mục 2; sửa theo hợp đồng v2 04/11/2026: Đ10 đơn vị mm, chặn capability agent, khoá thứ tự trong trigger;
-- sửa theo hợp đồng V3 04/11/2026: mã hàng = mã kiểu hàng (vd. CWSH02, KHÔNG phải SKU) nhập LÚC IN, UID mọi SKU in chung phiếu).
--
-- Vì sao: màn xả vải cũ chỉ ghi giờ bắt đầu / kết thúc (xa_vai_log). Người dùng cần đo MÉT THỰC TẾ từng cuộn (Group UID) sau khi
-- xả, so với số lượng hệ thống quy đổi từ qty WMS, rồi in một phiếu A4 theo mã hàng trên máy in A4 riêng (agent chế độ a4).
-- Đơn vị lưu và so sánh là mm nguyên (người dùng chốt 04/11, Đ10); ô nhập và phiếu A4 hiện mét (mm ÷ 1000).
--
-- Tác động:
--   * Hàm mới public.xa_vai_system_mm(tên SKU, qty) → mm hệ thống (numeric nguyên, NULL khi không quy đổi được): immutable,
--     security invoker, không đụng bảng, không cấp quyền cho ai. Logic chép từ computeCutQty (index.html): đơn vị = trường cuối
--     của tên theo '/'; m → qty × 1000; mm → qty; g → qty × 1000 / (gsm × khổ mét), khổ theo cm hoặc inch (khoảng a-b / a_b
--     lấy trung bình); làm tròn mm nguyên; kết quả ≥ 1e11 → NULL.
--   * Bảng mới public.xa_vai_measures (một dòng / Group UID: SKU, Lot, Roll, qty WMS, system_mm, actual_mm (mm nguyên, tối đa
--     100.000 m), trạng thái pending → printing → printed, lệnh in gắn kèm, item_code = mã hàng nhập lúc in (null tới khi in,
--     viết hoa, ^[0-9A-Z._-]{1,40}$; lưu để tìm và in lại theo mã hàng)). RLS bật, không policy, chỉ service_role; web đi qua RPC.
--     RPC và payload lệnh in dùng systemMm / actualMm (mm nguyên); item có itemCode, printJobId (màn theo dõi dòng printing).
--   * Hàm nội bộ public._xa_vai_item_code(text): chuẩn hoá mã hàng upper(btrim(…)), sai mẫu → NULL (một chỗ dùng chung).
--   * RPC đọc (anon, authenticated, không token): xa_vai_measure_lookup(p_group_uid),
--     xa_vai_measure_list(p_item_code, p_status) — queue = pending + printing của MỌI SKU, printed lọc theo mã hàng,
--     xa_vai_measure_search(p_item_code, p_sku, p_date_from, p_date_to, p_limit) — chỉ dòng printed.
--   * RPC ghi (anon, authenticated, kiểm khoá máy trong thân như floor_access_v1.sql — chỉ máy đã kích hoạt, lỗi thì chặn):
--     xa_vai_measure_save(p_access_token, p_group_uid, p_actual_mm, p_replace) — UID của SKU nào cũng lưu được;
--     xa_vai_measure_delete(p_access_token, p_group_uid);
--     xa_vai_print_enqueue(p_access_token, p_uids, p_copies, p_nonce, p_reprint, p_item_code) — thường: mã hàng bắt buộc
--     (INVALID_ITEM_CODE), ghi item_code vào dòng; in lại: mọi dòng cùng một item_code (MIXED_ITEM_CODE), không đổi dòng.
--     Thân nằm ở _xa_vai_*_body, không cấp quyền cho ai.
--   * Hàng đợi in: print_jobs_type_check thêm loại 'xa_vai_sheet' (giữ 4 loại cũ); print_agent_claim = bản đang chạy
--     (backend_hygiene_v1.sql, đã đối chiếu Supabase 04/11/2026) + đúng một nhánh xa_vai_sheet v1 cho agent khai
--     'xa_vai_sheet:v1' — agent tem cũ không khai nên không nhận; print_queue_status = bản đang chạy (print_devices_v1.sql),
--     queued / queuedCopies / active không còn đếm lệnh A4, thêm queuedA4.
--   * Cột mới print_agents.allowed_capabilities text[] (null = không giới hạn → may-kho-01 giữ nguyên hành vi). UPDATE đầu
--     print_agent_claim chỉ ghi / giao capability agent khai nằm trong danh sách này (state vẫn lưu nguyên agent khai): agent A4
--     cấu hình sai khai capability tem sẽ có capabilities = {} và không nhận lệnh nào. Migration không gán cột cho agent nào.
--   * Trigger xa_vai_measures_sync_job trên print_jobs: lệnh xa_vai_sheet completed → dòng printing của lệnh thành printed
--     (printed_at = completed_at, giữ item_code); failed / cancelled → về pending, bỏ print_job_id và item_code. Lệnh in lại
--     không gắn dòng nên không đổi gì.
--     Trigger khoá dòng theo group_uid_code trước khi UPDATE (cùng thứ tự với _xa_vai_print_enqueue_body, tránh deadlock).
--   * Hàm / bảng xả vải cũ (xa_vai_start/end/list_open/search, xa_vai_log) GIỮ NGUYÊN, không đụng.
--   * Phân loại: tương thích ngược — web cũ vẫn chạy (queued trong print_queue_status không còn tính lệnh A4), agent tem cũ không
--     nhận lệnh mới. Đăng ký agent may-a4-01 trong print_agents KHÔNG nằm ở đây (token thật không vào git) — lead tạo riêng.
--
-- Lệnh xoá: có `alter table public.print_jobs drop constraint if exists print_jobs_type_check` (rồi add lại ngay, thêm một loại)
-- → apply_supabase_sql.py đòi --allow-destructive. Không DROP bảng/hàm, không xoá dữ liệu.
-- Chạy lại được: create … if not exists / add column if not exists / create or replace / drop constraint if exists + add.
-- Thứ tự lên: migration này → lead tạo print_agents 'may-a4-01' (allowed_capabilities = '{xa_vai_sheet:v1}') → agent 0.11.0
-- (PRINTER_KIND=a4) → push web màn xả vải mới.
-- Kiểm cục bộ: node tests/xa_vai_a4_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v1.sql --dry-run --allow-destructive
-- Lệnh: python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v1.sql --allow-destructive
-- kiem: select to_regclass('public.xa_vai_measures') is not null and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.xa_vai_measures')), false) and public.xa_vai_system_mm('Vải Test/155gsm, 178cm/Đen/g', 16763) = 60758 and public.xa_vai_system_mm('Vải Test/Trắng/m', 49.5) = 49500 and public.xa_vai_system_mm('Cúc Test/Đen/pcs', 10) is null and not has_function_privilege('anon', 'public.xa_vai_system_mm(text,numeric)', 'execute') and public._xa_vai_item_code(' cwsh02 ') = 'CWSH02' and public._xa_vai_item_code('CW SH02') is null and not has_function_privilege('anon', 'public._xa_vai_item_code(text)', 'execute') and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'xa_vai_measures' and c.column_name = 'actual_mm') and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'xa_vai_measures' and c.column_name = 'item_code') and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'print_agents' and c.column_name = 'allowed_capabilities') and position('allowed_capabilities' in pg_get_functiondef('public.print_agent_claim(text,text,jsonb,integer)'::regprocedure)) > 0 and position('order by group_uid_code' in pg_get_functiondef('public.xa_vai_measures_sync_job()'::regprocedure)) > 0 and has_function_privilege('anon', 'public.xa_vai_measure_lookup(text)', 'execute') and has_function_privilege('anon', 'public.xa_vai_measure_save(text,text,numeric,boolean)', 'execute') and has_function_privilege('anon', 'public.xa_vai_print_enqueue(text,text[],integer,text,boolean,text)', 'execute') and not has_function_privilege('anon', 'public._xa_vai_measure_save_body(text,text,numeric,boolean)', 'execute') and not has_function_privilege('anon', 'public._xa_vai_print_enqueue_body(text,text[],integer,text,boolean,text)', 'execute') and not has_function_privilege('public', 'public.xa_vai_measure_save(text,text,numeric,boolean)', 'execute') and position('xa_vai_sheet:v1' in pg_get_functiondef('public.print_agent_claim(text,text,jsonb,integer)'::regprocedure)) > 0 and position('LEASE_EXPIRED' in pg_get_functiondef('public.print_agent_claim(text,text,jsonb,integer)'::regprocedure)) > 0 and position('queuedA4' in pg_get_functiondef('public.print_queue_status(text)'::regprocedure)) > 0 and position('xa_vai_sheet' in (select pg_get_constraintdef(k.oid) from pg_constraint k where k.conname = 'print_jobs_type_check' and k.conrelid = 'public.print_jobs'::regclass)) > 0 and exists (select 1 from pg_trigger t where t.tgname = 'xa_vai_measures_sync_job' and t.tgrelid = 'public.print_jobs'::regclass) as ok
-- Rút lui (web màn xả vải mới báo lỗi tải; dữ liệu mét đo mất nếu drop bảng; chạy kèm --allow-destructive):
--   drop trigger if exists xa_vai_measures_sync_job on public.print_jobs;
--   drop function if exists public.xa_vai_measures_sync_job();
--   drop function if exists public.xa_vai_print_enqueue(text, text[], integer, text, boolean, text);
--   drop function if exists public.xa_vai_measure_delete(text, text);
--   drop function if exists public.xa_vai_measure_save(text, text, numeric, boolean);
--   drop function if exists public._xa_vai_print_enqueue_body(text, text[], integer, text, boolean, text);
--   drop function if exists public._xa_vai_measure_delete_body(text, text);
--   drop function if exists public._xa_vai_measure_save_body(text, text, numeric, boolean);
--   drop function if exists public.xa_vai_measure_search(text, text, date, date, integer);
--   drop function if exists public.xa_vai_measure_list(text, text);
--   drop function if exists public.xa_vai_measure_lookup(text);
--   drop function if exists public._xa_vai_item_json(public.xa_vai_measures);
--   drop function if exists public._xa_vai_item_code(text);
--   drop function if exists public._xa_vai_iso(timestamptz);
--   drop function if exists public.xa_vai_system_mm(text, numeric);
--   drop table if exists public.xa_vai_measures;
--   chạy lại print_agent_claim trong backend_hygiene_v1.sql và print_queue_status trong print_devices_v1.sql (bản trước tệp này);
--   sau đó mới bỏ cột (claim mới đọc cột này; bỏ trước thì agent nhận lệnh lỗi tới khi claim cũ lên lại):
--     alter table public.print_agents drop column if exists allowed_capabilities;
--   CHECK 4 loại cũ chỉ add lại được khi print_jobs không còn dòng xa_vai_sheet (chờ print_jobs_purge 3 ngày hoặc huỷ/xoá tay):
--     alter table public.print_jobs drop constraint if exists print_jobs_type_check;
--     alter table public.print_jobs add constraint print_jobs_type_check check (type in ('sku', 'group_uid', 'fabric_relaxation', 'location'));
begin;

-- ---------- Quy đổi số lượng hệ thống ra mm (Đ10) ----------
-- Chép computeCutQty (index.html): JS dùng \b cho ranh giới từ; Postgres ARE dùng \y (\b ở Postgres là ký tự backspace).
-- Kết quả mm nguyên; ≥ 1e11 (vượt numeric(14,0) hợp lý, tên SKU ghi gsm / khổ bất thường) → NULL.
create or replace function public.xa_vai_system_mm(p_product_name text, p_qty numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare
  v_name text := coalesce(p_product_name, '');
  v_unit text;
  v_hit text[];
  v_gsm numeric;
  v_a numeric;
  v_b numeric;
  v_width numeric;
  v_mm numeric;
begin
  if p_qty is null or p_qty = 'NaN'::numeric or p_qty < 0 or p_qty = 'Infinity'::numeric then
    return null;
  end if;
  -- Trường cuối theo '/', bỏ khoảng trắng hai đầu, chữ thường (tên không có '/' thì cả tên là đơn vị, như split của JS).
  v_unit := lower(btrim(regexp_replace(v_name, '^.*/', ''), E' \t\r\n'));
  if v_unit = 'm' then
    v_mm := round(p_qty * 1000, 0);
    return case when v_mm >= 100000000000 then null else v_mm end;
  end if;
  if v_unit = 'mm' then
    v_mm := round(p_qty, 0);
    return case when v_mm >= 100000000000 then null else v_mm end;
  end if;
  if v_unit <> 'g' then
    return null;
  end if;
  v_hit := regexp_match(v_name, '(\d+(?:[.,]\d+)?)\s*gsm', 'i');
  if v_hit is null then
    return null;
  end if;
  v_gsm := replace(v_hit[1], ',', '.')::numeric;
  v_hit := regexp_match(v_name, '(\d+(?:[.,]\d+)?)\s*cm', 'i');
  if v_hit is not null then
    v_width := replace(v_hit[1], ',', '.')::numeric / 100;
  else
    v_hit := regexp_match(v_name, '(\d+(?:[.,]\d+)?)(?:[_-](\d+(?:[.,]\d+)?))?\s*in\y', 'i');
    if v_hit is not null then
      v_a := replace(v_hit[1], ',', '.')::numeric;
      v_b := coalesce(replace(v_hit[2], ',', '.')::numeric, v_a);
      v_width := (v_a + v_b) / 2 * 0.0254;
    end if;
  end if;
  if v_width is null or v_gsm <= 0 or v_width <= 0 then
    return null;
  end if;
  v_mm := round(p_qty * 1000 / (v_gsm * v_width), 0);
  return case when v_mm >= 100000000000 then null else v_mm end;
end $$;
revoke all on function public.xa_vai_system_mm(text, numeric) from public, anon, authenticated;

-- ---------- Bảng ----------
create table if not exists public.xa_vai_measures (
  group_uid_code text primary key check (length(btrim(group_uid_code)) between 1 and 40),
  sku text not null check (length(sku) between 1 and 40),
  batch_code text not null default '',
  roll_code text not null default '',
  system_qty numeric not null,
  system_mm numeric(14,0),
  actual_mm numeric(14,0) not null check (actual_mm > 0 and actual_mm <= 100000000),
  measured_at timestamptz not null default now(),
  device_id uuid references public.print_devices(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'printing', 'printed')),
  print_job_id uuid references public.print_jobs(id) on delete set null,
  printed_at timestamptz,
  item_code text check (item_code ~ '^[0-9A-Z._-]{1,40}$')
);
comment on table public.xa_vai_measures is
  'Theo dõi xả vải: mét thực tế từng Group UID (một dòng / UID), lưu bằng mm nguyên (system_mm, actual_mm). pending = chờ in phiếu A4, printing = đã vào lệnh xa_vai_sheet, printed = phiếu đã in.';
comment on column public.xa_vai_measures.item_code is
  'Mã hàng (mã kiểu hàng, vd. CWSH02 — không phải SKU) nhập lúc in phiếu A4; null khi chờ in, xoá khi lệnh failed / cancelled.';
-- Hàng chờ = mọi SKU (hợp đồng V3), sắp theo measured_at.
create index if not exists xa_vai_measures_queue_idx on public.xa_vai_measures (status, measured_at);
create index if not exists xa_vai_measures_printed_idx on public.xa_vai_measures (printed_at desc) where status = 'printed';
-- Tìm / in lại theo mã hàng (tab Đã in).
create index if not exists xa_vai_measures_item_idx on public.xa_vai_measures (item_code, printed_at desc);
-- FK: trigger tìm theo print_job_id; print_jobs_purge / xoá máy (on delete set null) quét theo hai cột này.
create index if not exists xa_vai_measures_job_idx on public.xa_vai_measures (print_job_id) where print_job_id is not null;
create index if not exists xa_vai_measures_device_idx on public.xa_vai_measures (device_id) where device_id is not null;
alter table public.xa_vai_measures enable row level security;
revoke all on table public.xa_vai_measures from public, anon, authenticated;
grant select, insert, update, delete on table public.xa_vai_measures to service_role;

-- ---------- Hàm nội bộ ----------
-- Giờ ISO 8601 UTC cố định (payload lệnh in; agent đọc bằng Date.parse).
create or replace function public._xa_vai_iso(p_at timestamptz)
returns text language sql stable set search_path = '' as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
revoke all on function public._xa_vai_iso(timestamptz) from public, anon, authenticated;

-- Chuẩn hoá mã hàng (hợp đồng V3, một chỗ dùng chung): upper(btrim(…)); khớp ^[0-9A-Z._-]{1,40}$ → mã viết hoa, còn lại NULL
-- (nơi gọi trả INVALID_ITEM_CODE). btrim chỉ bỏ dấu cách hai đầu; chữ có dấu, tab, khoảng trắng giữa → NULL.
create or replace function public._xa_vai_item_code(p_item_code text)
returns text language sql immutable set search_path = '' as $$
  select case when upper(btrim(p_item_code)) ~ '^[0-9A-Z._-]{1,40}$' then upper(btrim(p_item_code)) end
$$;
revoke all on function public._xa_vai_item_code(text) from public, anon, authenticated;

-- Item của danh sách / tìm kiếm / lỗi ALREADY_MEASURED / save. systemMm, actualMm = mm nguyên; itemCode = mã hàng (null khi
-- chưa in); printJobId để màn theo dõi dòng printing.
create or replace function public._xa_vai_item_json(p_row public.xa_vai_measures)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('groupUid', p_row.group_uid_code, 'sku', p_row.sku, 'itemCode', p_row.item_code,
    'lot', p_row.batch_code, 'roll', p_row.roll_code,
    'systemMm', p_row.system_mm, 'actualMm', p_row.actual_mm, 'measuredAt', p_row.measured_at, 'status', p_row.status,
    'printedAt', p_row.printed_at, 'printJobId', p_row.print_job_id)
$$;
revoke all on function public._xa_vai_item_json(public.xa_vai_measures) from public, anon, authenticated;

-- ---------- RPC đọc (mọi người, không token) ----------
create or replace function public.xa_vai_measure_lookup(p_group_uid text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(coalesce(p_group_uid, '')), '');
  v_gd public.group_uid_details;
  v_row public.xa_vai_measures;
  v_sku text;
  v_name text;
begin
  if v_code is null or length(v_code) > 40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  select g.* into v_gd from public.group_uid_details g where g.group_uid_code = v_code;
  select m.* into v_row from public.xa_vai_measures m where m.group_uid_code = v_code;
  if found then
    select btrim(coalesce(s.product_name, '')) into v_name from public."SKU_Name" s where s.sku = v_row.sku;
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'groupUid', v_row.group_uid_code, 'sku', v_row.sku, 'itemCode', v_row.item_code, 'productName', coalesce(v_name, ''),
      'lot', v_row.batch_code, 'roll', v_row.roll_code, 'uidStatus', v_gd.status,
      'systemQty', v_row.system_qty, 'systemMm', v_row.system_mm, 'state', v_row.status,
      'actualMm', v_row.actual_mm, 'measuredAt', v_row.measured_at, 'printedAt', v_row.printed_at, 'printJobId', v_row.print_job_id),
      'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
  end if;
  v_sku := btrim(coalesce(v_gd.sku, ''));
  if v_gd.group_uid_code is null or v_sku = '' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'GROUP_UID_NOT_READY', 'message', 'Group UID chưa có dữ liệu SKU. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  select btrim(coalesce(s.product_name, '')) into v_name from public."SKU_Name" s where s.sku = v_sku;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'groupUid', v_gd.group_uid_code, 'sku', v_sku, 'itemCode', null, 'productName', coalesce(v_name, ''),
    'lot', btrim(coalesce(v_gd.batch_code, '')), 'roll', btrim(coalesce(v_gd.roll_code, '')), 'uidStatus', v_gd.status,
    'systemQty', v_gd.qty, 'systemMm', public.xa_vai_system_mm(v_name, v_gd.qty), 'state', 'new',
    'actualMm', null, 'measuredAt', null, 'printedAt', null, 'printJobId', null),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- p_status 'queue' = pending + printing của MỌI SKU (measured_at tăng; bỏ qua p_item_code); 'printed' = đã in (printed_at giảm),
-- lọc theo mã hàng khi có (khớp đúng sau chuẩn hoá; sai mẫu → INVALID_ITEM_CODE). Tối đa 1000 dòng; total = tổng khớp.
create or replace function public.xa_vai_measure_list(p_item_code text default null, p_status text default 'queue')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_status text := coalesce(nullif(btrim(p_status), ''), 'queue');
  v_code text;
  v_total integer;
  v_items jsonb;
begin
  if v_status not in ('queue', 'printed') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_INPUT', 'message', 'Trạng thái danh sách không hợp lệ'));
  end if;
  if v_status = 'queue' then
    select count(*) into v_total from public.xa_vai_measures m
     where m.status in ('pending', 'printing');
    select coalesce(jsonb_agg(public._xa_vai_item_json(q.r) order by q.measured_at, q.group_uid_code), '[]'::jsonb) into v_items
      from (select m as r, m.measured_at, m.group_uid_code from public.xa_vai_measures m
             where m.status in ('pending', 'printing')
             order by m.measured_at, m.group_uid_code limit 1000) q;
  else
    if nullif(btrim(coalesce(p_item_code, '')), '') is not null then
      v_code := public._xa_vai_item_code(p_item_code);
      if v_code is null then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEM_CODE', 'message', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)'));
      end if;
    end if;
    select count(*) into v_total from public.xa_vai_measures m
     where (v_code is null or m.item_code = v_code) and m.status = 'printed';
    select coalesce(jsonb_agg(public._xa_vai_item_json(q.r) order by q.printed_at desc, q.group_uid_code), '[]'::jsonb) into v_items
      from (select m as r, m.printed_at, m.group_uid_code from public.xa_vai_measures m
             where (v_code is null or m.item_code = v_code) and m.status = 'printed'
             order by m.printed_at desc, m.group_uid_code limit 1000) q;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', v_items, 'total', v_total),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

-- Chỉ dòng printed; lọc printed_at theo ngày giờ Việt Nam; mã hàng (sau chuẩn hoá; sai mẫu → INVALID_ITEM_CODE) và SKU khớp
-- đúng khi có; p_limit kẹp 1–5000.
create or replace function public.xa_vai_measure_search(p_item_code text default null, p_sku text default null, p_date_from date default null, p_date_to date default null, p_limit integer default 5000)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text;
  v_sku text := nullif(btrim(coalesce(p_sku, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 5000), 1), 5000);
  v_from timestamptz := case when p_date_from is null then null else p_date_from::timestamp at time zone 'Asia/Ho_Chi_Minh' end;
  v_to timestamptz := case when p_date_to is null then null else (p_date_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh' end;
  v_total integer;
  v_items jsonb;
begin
  if nullif(btrim(coalesce(p_item_code, '')), '') is not null then
    v_code := public._xa_vai_item_code(p_item_code);
    if v_code is null then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEM_CODE', 'message', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)'));
    end if;
  end if;
  select count(*) into v_total from public.xa_vai_measures m
   where m.status = 'printed' and (v_code is null or m.item_code = v_code) and (v_sku is null or m.sku = v_sku)
     and (v_from is null or m.printed_at >= v_from) and (v_to is null or m.printed_at < v_to);
  select coalesce(jsonb_agg(public._xa_vai_item_json(q.r) order by q.printed_at desc, q.group_uid_code), '[]'::jsonb) into v_items
    from (select m as r, m.printed_at, m.group_uid_code from public.xa_vai_measures m
           where m.status = 'printed' and (v_code is null or m.item_code = v_code) and (v_sku is null or m.sku = v_sku)
             and (v_from is null or m.printed_at >= v_from) and (v_to is null or m.printed_at < v_to)
           order by m.printed_at desc, m.group_uid_code limit v_limit) q;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', v_items, 'total', v_total, 'truncated', v_total > v_limit),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

revoke all on function public.xa_vai_measure_lookup(text) from public, anon, authenticated;
grant execute on function public.xa_vai_measure_lookup(text) to anon, authenticated;
revoke all on function public.xa_vai_measure_list(text, text) from public, anon, authenticated;
grant execute on function public.xa_vai_measure_list(text, text) to anon, authenticated;
revoke all on function public.xa_vai_measure_search(text, text, date, date, integer) from public, anon, authenticated;
grant execute on function public.xa_vai_measure_search(text, text, date, date, integer) to anon, authenticated;

-- ---------- Thân hàm ghi (nội bộ, không cấp quyền; chỉ hàm công khai bên dưới gọi sau khi kiểm khoá máy) ----------
-- Hợp đồng V3: UID của SKU nào cũng lưu được (bỏ p_sku / SKU_MISMATCH); mã hàng KHÔNG ghi ở đây mà nhập lúc in.
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

create or replace function public._xa_vai_measure_delete_body(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(coalesce(p_group_uid, '')), '');
  v_row public.xa_vai_measures;
begin
  if v_code is null or length(v_code) > 40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  select m.* into v_row from public.xa_vai_measures m where m.group_uid_code = v_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Group UID chưa có trong danh sách chờ in'));
  end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_PENDING',
      'message', 'Chỉ xoá được Group UID đang chờ in', 'state', v_row.status));
  end if;
  delete from public.xa_vai_measures where group_uid_code = v_code;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('groupUid', v_code),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public._xa_vai_measure_delete_body(text, text) from public, anon, authenticated;

-- Dựng lệnh in xa_vai_sheet v1 từ dữ liệu trong bảng (web không gửi payload). Một phiếu được lẫn nhiều SKU (hợp đồng V3).
-- Chế độ thường: mã hàng bắt buộc (INVALID_ITEM_CODE); dòng pending → printing + gắn lệnh + ghi item_code.
-- In lại: dòng phải printed và cùng MỘT item_code khác null (MIXED_ITEM_CODE), p_item_code bỏ qua, KHÔNG đổi dòng nào
-- (trigger không có gì để đồng bộ). Nonce đã có → trả lệnh cũ, không đổi gì.
create or replace function public._xa_vai_print_enqueue_body(p_access_token text, p_uids text[], p_copies integer, p_nonce text, p_reprint boolean, p_item_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_nonce text := nullif(btrim(coalesce(p_nonce, '')), '');
  v_reprint boolean := coalesce(p_reprint, false);
  v_uids text[];
  v_missing text[];
  v_skus text[];
  v_bad text[];
  v_item text;
  v_codes text[];
  v_name text;
  v_payload jsonb;
  v_device uuid;
  v_job public.print_jobs;
begin
  if p_uids is null or exists (select 1 from unnest(p_uids) x where nullif(btrim(x), '') is null or length(btrim(x)) > 40) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_JOB', 'message', 'Danh sách Group UID không hợp lệ'));
  end if;
  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}'::text[]) into v_uids from unnest(p_uids) x;
  if cardinality(v_uids) not between 1 and 100 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_JOB', 'message', 'Mỗi lệnh in từ 1 đến 100 Group UID'));
  end if;
  if p_copies is null or p_copies not between 1 and 5 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_JOB', 'message', 'Số bản từ 1 đến 5'));
  end if;
  if v_nonce is null or length(v_nonce) > 120 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_JOB', 'message', 'Mã lệnh in không hợp lệ'));
  end if;
  if not v_reprint then
    v_item := public._xa_vai_item_code(p_item_code);
    if v_item is null then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEM_CODE', 'message', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)'));
    end if;
  end if;
  -- Hai lượt gửi cùng nonce (bấm lại sau lỗi mạng) chạy tuần tự: lượt sau thấy lệnh của lượt trước và trả duplicate.
  perform pg_advisory_xact_lock(hashtextextended('xa_vai_print_enqueue:' || v_nonce, 0));
  select j.* into v_job from public.print_jobs j where j.nonce = v_nonce;
  if found then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', v_job.id, 'status', v_job.status, 'duplicate', true,
      'count', case when jsonb_typeof(v_job.payload->'items') = 'array' then jsonb_array_length(v_job.payload->'items') else 0 end),
      'meta', jsonb_build_object('updatedAt', v_job.updated_at, 'schemaVersion', 1));
  end if;
  perform 1 from public.xa_vai_measures m where m.group_uid_code = any(v_uids) order by m.group_uid_code for update;
  select coalesce(array_agg(u order by u), '{}'::text[]) into v_missing
    from unnest(v_uids) u where not exists (select 1 from public.xa_vai_measures m where m.group_uid_code = u);
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND',
      'message', 'Có Group UID chưa có mét thực tế: ' || left(array_to_string(v_missing, ', '), 200), 'uids', to_jsonb(v_missing)));
  end if;
  -- Agent từ chối cả lệnh khi SKU của một dòng sai mẫu hoặc mã UID không phải ASCII in được (job-validator.mjs): chặn sớm,
  -- tránh lệnh failed lặp lại.
  if exists (select 1 from public.xa_vai_measures m where m.group_uid_code = any(v_uids) and m.sku !~ '^[0-9A-Za-z._-]{1,40}$')
     or exists (select 1 from unnest(v_uids) u where u !~ '^[ -~]{1,40}$') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_JOB',
      'message', 'SKU hoặc Group UID có ký tự máy in không nhận'));
  end if;
  select coalesce(array_agg(m.group_uid_code order by m.group_uid_code), '{}'::text[]) into v_bad
    from public.xa_vai_measures m
   where m.group_uid_code = any(v_uids) and m.status <> case when v_reprint then 'printed' else 'pending' end;
  if cardinality(v_bad) > 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_PENDING',
      'message', case when v_reprint then 'Chỉ in lại được Group UID đã in' else 'Có Group UID không còn chờ in' end,
      'uids', to_jsonb(v_bad)));
  end if;
  if v_reprint then
    -- In lại theo mã hàng đã lưu: mọi dòng cùng MỘT item_code khác null (dòng printed luôn có mã — enqueue ghi cùng lúc printing).
    if exists (select 1 from public.xa_vai_measures m where m.group_uid_code = any(v_uids) and m.item_code is null)
       or (select count(distinct m.item_code) from public.xa_vai_measures m where m.group_uid_code = any(v_uids)) > 1 then
      select coalesce(array_agg(distinct coalesce(m.item_code, '') order by coalesce(m.item_code, '')), '{}'::text[]) into v_codes
        from public.xa_vai_measures m where m.group_uid_code = any(v_uids);
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'MIXED_ITEM_CODE',
        'message', 'Mỗi phiếu một mã hàng', 'itemCodes', to_jsonb(v_codes)));
    end if;
    select min(m.item_code) into v_item from public.xa_vai_measures m where m.group_uid_code = any(v_uids);
  end if;
  -- productName (≤ 180 ký tự) CHỈ KHI mọi dòng cùng một SKU và có tên trong "SKU_Name"; phiếu nhiều SKU → null (cột SKU trong bảng).
  select array_agg(distinct m.sku order by m.sku) into v_skus from public.xa_vai_measures m where m.group_uid_code = any(v_uids);
  if cardinality(v_skus) = 1 then
    select left(nullif(btrim(s.product_name), ''), 180) into v_name from public."SKU_Name" s where s.sku = v_skus[1];
  end if;
  select jsonb_build_object('itemCode', v_item, 'productName', v_name, 'printedAt', public._xa_vai_iso(now()),
           'reprint', v_reprint,
           'items', coalesce(jsonb_agg(jsonb_build_object('groupUid', m.group_uid_code, 'sku', m.sku, 'lot', m.batch_code, 'roll', m.roll_code,
                      'systemMm', m.system_mm, 'actualMm', m.actual_mm, 'measuredAt', public._xa_vai_iso(m.measured_at))
                      order by m.measured_at, m.group_uid_code), '[]'::jsonb))
    into v_payload
    from public.xa_vai_measures m where m.group_uid_code = any(v_uids);
  v_device := public.print_device_by_token(p_access_token);
  insert into public.print_jobs(nonce, type, template_version, payload, copies, requested_by, device_id)
  values (v_nonce, 'xa_vai_sheet', 1, v_payload, p_copies, 'xa-vai', v_device)
  on conflict (nonce) do nothing
  returning * into v_job;
  if not found then
    -- Nonce trùng với lệnh vừa chèn qua đường khác (print_enqueue): trả lệnh đó, không gắn dòng nào.
    select j.* into v_job from public.print_jobs j where j.nonce = v_nonce;
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', v_job.id, 'status', v_job.status, 'duplicate', true,
      'count', case when jsonb_typeof(v_job.payload->'items') = 'array' then jsonb_array_length(v_job.payload->'items') else 0 end),
      'meta', jsonb_build_object('updatedAt', v_job.updated_at, 'schemaVersion', 1));
  end if;
  if not v_reprint then
    update public.xa_vai_measures set status = 'printing', print_job_id = v_job.id, item_code = v_item
     where group_uid_code = any(v_uids);
  end if;
  insert into public.print_events(job_id, event_type, details) values (v_job.id, 'queued', jsonb_build_object('copies', v_job.copies, 'type', v_job.type));
  perform public.print_device_touch(p_access_token, true);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', v_job.id, 'status', v_job.status, 'duplicate', false,
    'count', cardinality(v_uids)),
    'meta', jsonb_build_object('updatedAt', v_job.updated_at, 'schemaVersion', 1));
end $$;
revoke all on function public._xa_vai_print_enqueue_body(text, text[], integer, text, boolean, text) from public, anon, authenticated;

-- ---------- Hàm ghi công khai: kiểm khoá máy → thân → gộp cờ accessWarning (mẫu floor_access_v1.sql) ----------
create or replace function public.xa_vai_measure_save(p_access_token text, p_group_uid text, p_actual_mm numeric, p_replace boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_measure_save');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_measure_save_body(p_access_token, p_group_uid, p_actual_mm, p_replace));
end $$;

create or replace function public.xa_vai_measure_delete(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_measure_delete');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_measure_delete_body(p_access_token, p_group_uid));
end $$;

create or replace function public.xa_vai_print_enqueue(p_access_token text, p_uids text[], p_copies integer, p_nonce text, p_reprint boolean default false, p_item_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_print_enqueue');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_print_enqueue_body(p_access_token, p_uids, p_copies, p_nonce, p_reprint, p_item_code));
end $$;

revoke all on function public.xa_vai_measure_save(text, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.xa_vai_measure_save(text, text, numeric, boolean) to anon, authenticated;
revoke all on function public.xa_vai_measure_delete(text, text) from public, anon, authenticated;
grant execute on function public.xa_vai_measure_delete(text, text) to anon, authenticated;
revoke all on function public.xa_vai_print_enqueue(text, text[], integer, text, boolean, text) from public, anon, authenticated;
grant execute on function public.xa_vai_print_enqueue(text, text[], integer, text, boolean, text) to anon, authenticated;

-- ---------- Hàng đợi in: loại lệnh mới ----------
alter table public.print_jobs drop constraint if exists print_jobs_type_check;
alter table public.print_jobs add constraint print_jobs_type_check
  check (type in ('sku', 'group_uid', 'fabric_relaxation', 'location', 'xa_vai_sheet'));

-- ---------- Danh sách capability cho phép từng agent (hợp đồng v2 mục 2) ----------
-- null = không giới hạn (may-kho-01 giữ nguyên hành vi). Lead đặt tay cho may-a4-01: '{xa_vai_sheet:v1}' — agent A4 cấu hình sai
-- (PRINTER_KIND thiếu → khai capability tem) được giao capabilities = {} nên không nhận lệnh tem nào.
alter table public.print_agents add column if not exists allowed_capabilities text[];
comment on column public.print_agents.allowed_capabilities is
  'Capability được giao cho agent (null = không giới hạn). print_agent_claim chỉ ghi vào capabilities các capability agent khai nằm trong danh sách này.';

-- ---------- print_agent_claim (bản gốc backend_hygiene_v1.sql; thêm nhánh xa_vai_sheet v1 + UPDATE đầu lọc allowed_capabilities) ----------
create or replace function public.print_agent_claim(p_agent_id text,p_agent_token text,p_state jsonb,p_lease_ms integer default 120000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_cap text[];
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select c.cap from jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb)) as c(cap) where print_agents.allowed_capabilities is null or c.cap=any(print_agents.allowed_capabilities)),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;
  -- Chưa gửi byte xuống máy in (claimed/rendering): về hàng đợi chung như cũ, agent nào cũng nhận lại được — TRỪ lệnh từng gửi
  -- byte (print_events sending/spooling) rồi được chính agent đó nhận lại để đối chiếu sổ tay: vẫn giữ agent_id (review vòng 1).
  update public.print_jobs set status='queued',agent_id=case when exists (select 1 from public.print_events e where e.job_id=print_jobs.id and e.event_type in ('sending','spooling')) then agent_id else null end,lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent trước không hoàn tất trong thời hạn lease' where status in ('claimed','rendering') and lease_expires_at<now();
  -- Đã gửi byte (sending/spooling): về hàng đợi nhưng GIỮ agent_id, chỉ agent đó nhận lại (đối chiếu sổ tay, không in lại);
  -- agent khác không có sổ tay sẽ in trùng. Quá 30 phút không ai nhận: print_jobs_purge đóng failed SENT_UNCONFIRMED.
  update public.print_jobs set status='queued',lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent đã gửi tem nhưng chưa báo hoàn tất trong thời hạn lease, chỉ agent đó được nhận lại' where status in ('sending','spooling') and lease_expires_at<now();
  if coalesce(p_state#>>'{printer,blocked}','false')='true' then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  select * into v_job from public.print_jobs where status='queued' and (agent_id is null or agent_id=p_agent_id) and (
    (type='sku' and template_version=1 and 'sku:v1'=any(v_cap)) or
    (type='sku' and template_version=2 and 'sku:v2'=any(v_cap)) or
    (type='sku' and template_version=3 and 'sku:v3'=any(v_cap)) or
    (type='group_uid' and template_version=1 and 'group_uid:v1'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=1 and 'fabric_relaxation:v1'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=2 and 'fabric_relaxation:v2'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=3 and 'fabric_relaxation:v3'=any(v_cap)) or
    (type='xa_vai_sheet' and template_version=1 and 'xa_vai_sheet:v1'=any(v_cap)) or
    (type='location' and template_version=1 and 'location:v1'=any(v_cap))
  ) order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  update public.print_jobs set status='claimed',agent_id=p_agent_id,attempt_count=attempt_count+1,claimed_at=coalesce(claimed_at,now()),lease_expires_at=now()+(least(greatest(p_lease_ms,30000),900000)||' milliseconds')::interval,updated_at=now() where id=v_job.id returning * into v_job;
  insert into public.print_events(job_id,agent_id,event_type,details) values(v_job.id,p_agent_id,'claimed',jsonb_build_object('attempt',v_job.attempt_count));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object('id',v_job.id::text,'nonce',v_job.nonce,'type',v_job.type,'templateVersion',v_job.template_version,'copies',v_job.copies,'requestedBy',v_job.requested_by,'payload',v_job.payload)),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

-- ---------- print_queue_status (bản gốc print_devices_v1.sql; lệnh A4 đếm riêng ở queuedA4) ----------
create or replace function public.print_queue_status(p_access_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Máy này chưa được kích hoạt in'));
  end if;
  perform public.print_device_touch(p_access_token, false);
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'queued',(select count(*) from public.print_jobs where status='queued' and type<>'xa_vai_sheet'),
    'queuedCopies',(select coalesce(sum(copies),0) from public.print_jobs where status='queued' and type<>'xa_vai_sheet'),
    'active',(select count(*) from public.print_jobs where status in ('claimed','rendering','sending','spooling') and type<>'xa_vai_sheet'),
    'queuedA4',(select count(*) from public.print_jobs where status='queued' and type='xa_vai_sheet'),
    'agents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'capabilities',capabilities,'state',state,'lastSeenAt',last_seen_at)) from public.print_agents where enabled),'[]'::jsonb)
  ),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- ---------- Trigger: trạng thái lệnh A4 → trạng thái UID ----------
-- Chỉ dòng đang printing gắn đúng lệnh: completed → printed (giữ item_code); failed / cancelled (Admin huỷ, SENT_UNCONFIRMED…)
-- → về chờ in, bỏ print_job_id và item_code (mã hàng nhập lại khi in lại).
-- Khoá các dòng theo group_uid_code trước khi UPDATE: cùng thứ tự khoá với _xa_vai_print_enqueue_body, tránh deadlock khi agent
-- báo xong lệnh cùng lúc web gửi lệnh mới có chung UID (vd. In lại).
create or replace function public.xa_vai_measures_sync_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.xa_vai_measures where print_job_id = new.id and status = 'printing' order by group_uid_code for update;
  if new.status = 'completed' then
    update public.xa_vai_measures set status = 'printed', printed_at = coalesce(new.completed_at, now())
     where print_job_id = new.id and status = 'printing';
  else
    update public.xa_vai_measures set status = 'pending', print_job_id = null, item_code = null
     where print_job_id = new.id and status = 'printing';
  end if;
  return null;
end $$;
revoke all on function public.xa_vai_measures_sync_job() from public, anon, authenticated;

create or replace trigger xa_vai_measures_sync_job
  after update of status on public.print_jobs
  for each row
  when (new.type = 'xa_vai_sheet' and new.status in ('completed', 'failed', 'cancelled') and old.status is distinct from new.status)
  execute function public.xa_vai_measures_sync_job();

commit;
notify pgrst, 'reload schema';
