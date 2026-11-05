-- Phiếu A4 xả vải bản mới (05/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md mục "Đợt 3: phiếu A4 đơn vị gốc").
--
-- Vì sao: người dùng (05/11) "Phần in A4 tôi cần 1 dòng phiếu IT dạng barcode. các group UID thì nhóm lại theo SKU. thêm cột mã vải và màu" +
-- "Giao diện web thì vẫn giữ như cũ hệ mét … phần in A4 thì cần chuyển về đơn vị gốc"; chốt: mỗi phiếu IT một barcode, mã vải = nguyên trường 2
-- của tên SKU, đơn vị gốc cho phiếu A4 + Excel, nhóm SKU có tiêu đề + tổng nhóm.
--
-- Tác động:
--   * Hàm mới (nội bộ, không cấp quyền): xa_vai_name_parts(tên SKU) → { fabricCode, color, unit } (tên dạng "Vải …/<mã vải>/…/<màu>/<đơn vị>";
--     màu = trường gần đơn vị nhất (đi lùi tới trường 3) không trống, không "none", không phải thông số gsm / cm / inch / width / khổ;
--     mã vải "none" → null; tên < 4 trường → null);
--     xa_vai_mm_to_unit(tên SKU, mm) = nghịch đảo xa_vai_system_mm (m: mm ÷ 1000; mm: mm; g: mm × GSM × khổ (m) ÷ 1000; đơn vị khác / thiếu
--     GSM, khổ → null); _xa_vai_unit_json(dòng, tên) → { unit, systemQty (= system_qty WMS), actualQty, fabricCode, color }.
--   * Thay (cùng chữ ký): _xa_vai_item_json (+ các trường trên — Excel tab Đã in), _xa_vai_print_enqueue_body (bản đang chạy = xa_vai_a4_v1.sql,
--     kiểm pg_get_functiondef 05/11: khớp; + itNumbers, item.itNumber + trường đơn vị; dòng xếp theo SKU). template_version vẫn 1: agent 0.11.0
--     bỏ qua trường lạ, in mẫu cũ; agent 0.12.0 in mẫu mới khi có trường mới.
--   Phân loại: tương thích ngược (thêm khoá JSON, không bỏ khoá nào).
-- Không DROP / DELETE → không cần --allow-destructive. Chạy lại được (create or replace).
-- Thứ tự lên: commit (chưa push) → migration này → push web (Excel) → người dùng cài agent 0.12.0 ở máy in A4 → in thử.
-- Kiểm cục bộ: node tests/xa_vai_a4_v2_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v2.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v2.sql
-- kiem: select to_regprocedure('public.xa_vai_name_parts(text)') is not null and to_regprocedure('public.xa_vai_mm_to_unit(text,numeric)') is not null and not has_function_privilege('anon', 'public.xa_vai_name_parts(text)', 'execute') and not has_function_privilege('anon', 'public._xa_vai_unit_json(public.xa_vai_measures,text)', 'execute') and public.xa_vai_mm_to_unit('Vải thử/M1/100% Cotton/200gsm, 160cm/Đen/g', 1000) = 320 and (public.xa_vai_name_parts('Vải bo rib/Korea/None/None/Cam/None/Khổ 100cm/g')->>'color') = 'Cam' and public.xa_vai_mm_to_unit('Vải thử/M1/x/150gsm,152cm/Đen/mm', 1234) = 1234 and (public.xa_vai_name_parts('Vải thử/M1 NCC/100% Poly/63gsm-60inch/Đen-Deep black/mm')->>'color') = 'Đen-Deep black' and (public.xa_vai_name_parts('Vải thử/M1/x/Dusty Mauve /140gsm,57inch/mm')->>'color') = 'Dusty Mauve'
-- Rút lui (chạy lại khối _xa_vai_item_json + _xa_vai_print_enqueue_body của xa_vai_a4_v1.sql; rồi kèm --allow-destructive):
--   drop function if exists public._xa_vai_unit_json(public.xa_vai_measures, text);
--   drop function if exists public.xa_vai_mm_to_unit(text, numeric);
--   drop function if exists public.xa_vai_name_parts(text);
begin;

-- ---------- Tách mã vải / màu / đơn vị từ tên SKU ----------
-- Đo 05/11/2026 (Supabase, SKU vải có Group UID): 672 SKU, 669 tên ≥ 4 trường. SKU đơn vị g: 200, đổi được 165 (35 vải bo / rib không ghi
-- GSM → actualQty null, phiếu in "—").
create or replace function public.xa_vai_name_parts(p_product_name text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_parts text[] := string_to_array(coalesce(p_product_name, ''), '/');
  v_n integer := cardinality(string_to_array(coalesce(p_product_name, ''), '/'));
  v_color text;
  v_code text;
  v_i integer;
  v_spec constant text := '(gsm|[0-9]\s*cm|inch|width|khổ|[0-9]\s*in\y)';
begin
  if v_n < 4 then
    return jsonb_build_object('fabricCode', null, 'color', null, 'unit', nullif(lower(btrim(v_parts[v_n])), ''));
  end if;
  -- Màu: đi lùi từ trường kề đơn vị tới trường 3, bỏ trường trống / "none" / thông số (gsm, cm, inch, width, khổ).
  for v_i in reverse v_n - 1 .. 3 loop
    if btrim(v_parts[v_i]) <> '' and lower(btrim(v_parts[v_i])) <> 'none' and btrim(v_parts[v_i]) !~* v_spec then
      v_color := btrim(v_parts[v_i]);
      exit;
    end if;
  end loop;
  v_code := btrim(v_parts[2]);
  if lower(v_code) = 'none' then
    v_code := null;
  end if;
  return jsonb_build_object('fabricCode', left(nullif(v_code, ''), 80), 'color', left(v_color, 80),
    'unit', left(nullif(lower(btrim(v_parts[v_n])), ''), 20));
end $$;
revoke all on function public.xa_vai_name_parts(text) from public, anon, authenticated;

-- ---------- mm → đơn vị gốc (nghịch đảo xa_vai_system_mm, cùng cách đọc GSM / khổ) ----------
create or replace function public.xa_vai_mm_to_unit(p_product_name text, p_mm numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare
  v_name text := coalesce(p_product_name, '');
  v_unit text;
  v_hit text[];
  v_gsm numeric;
  v_a numeric;
  v_b numeric;
  v_width numeric;
begin
  if p_mm is null or p_mm = 'NaN'::numeric or p_mm < 0 or p_mm = 'Infinity'::numeric then
    return null;
  end if;
  v_unit := lower(btrim(regexp_replace(v_name, '^.*/', ''), E' \t\r\n'));
  if v_unit = 'm' then
    return round(p_mm / 1000, 2);
  end if;
  if v_unit = 'mm' then
    return round(p_mm, 0);
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
  return round(p_mm * v_gsm * v_width / 1000, 0);
end $$;
revoke all on function public.xa_vai_mm_to_unit(text, numeric) from public, anon, authenticated;

-- Trường đơn vị gốc của một dòng đo: systemQty = số lượng WMS gốc (system_qty, đã ở đơn vị gốc); actualQty = mét thực tế đổi ra đơn vị gốc.
create or replace function public._xa_vai_unit_json(p_row public.xa_vai_measures, p_product_name text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('unit', public.xa_vai_name_parts(p_product_name)->>'unit', 'systemQty', p_row.system_qty,
    'actualQty', public.xa_vai_mm_to_unit(p_product_name, p_row.actual_mm),
    'fabricCode', public.xa_vai_name_parts(p_product_name)->>'fabricCode', 'color', public.xa_vai_name_parts(p_product_name)->>'color')
$$;
revoke all on function public._xa_vai_unit_json(public.xa_vai_measures, text) from public, anon, authenticated;

-- Dòng của danh sách / tìm kiếm / lưu (v2): + unit, systemQty, actualQty, fabricCode, color (Excel tab Đã in dùng đơn vị gốc).
create or replace function public._xa_vai_item_json(p_row public.xa_vai_measures)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('groupUid', p_row.group_uid_code, 'sku', p_row.sku, 'itemCode', p_row.item_code,
    'lot', p_row.batch_code, 'roll', p_row.roll_code,
    'systemMm', p_row.system_mm, 'actualMm', p_row.actual_mm, 'measuredAt', p_row.measured_at, 'status', p_row.status,
    'printedAt', p_row.printed_at, 'printJobId', p_row.print_job_id)
    || public._xa_vai_unit_json(p_row, (select s.product_name from public."SKU_Name" s where s.sku = p_row.sku))
$$;
revoke all on function public._xa_vai_item_json(public.xa_vai_measures) from public, anon, authenticated;

-- Dựng lệnh in A4 (v2): bản đang chạy (xa_vai_a4_v1.sql, kiểm pg_get_functiondef 05/11/2026) + trường mới, giữ template_version 1.
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
  -- v2 (xa_vai_a4_v2, 05/11/2026): thêm trường cho phiếu A4 bản mới (agent 0.12.0) — itNumbers (phiếu IT của các UID, barcode), từng dòng
  -- itNumber, fabricCode / color (tách từ tên SKU), unit + systemQty / actualQty theo ĐƠN VỊ GỐC của SKU. Giữ nguyên mọi trường v1: agent 0.11.0
  -- bỏ qua trường lạ và in mẫu cũ (mm). Dòng xếp theo SKU rồi giờ nhập (phiếu nhóm theo SKU).
  select jsonb_build_object('itemCode', v_item, 'productName', v_name, 'printedAt', public._xa_vai_iso(now()),
           'reprint', v_reprint,
           'itNumbers', coalesce((select jsonb_agg(distinct x.it_number order by x.it_number) from public.xa_vai_it_uids x where x.group_uid_code = any(v_uids)), '[]'::jsonb),
           'items', coalesce(jsonb_agg(jsonb_build_object('groupUid', m.group_uid_code, 'sku', m.sku, 'lot', m.batch_code, 'roll', m.roll_code,
                      'systemMm', m.system_mm, 'actualMm', m.actual_mm, 'measuredAt', public._xa_vai_iso(m.measured_at))
                      || public._xa_vai_unit_json(m, s.product_name)
                      || jsonb_build_object('itNumber', (select x.it_number from public.xa_vai_it_uids x where x.group_uid_code = m.group_uid_code order by x.added_at desc limit 1))
                      order by m.sku, m.measured_at, m.group_uid_code), '[]'::jsonb))
    into v_payload
    from public.xa_vai_measures m left join public."SKU_Name" s on s.sku = m.sku where m.group_uid_code = any(v_uids);
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

commit;

notify pgrst, 'reload schema';
