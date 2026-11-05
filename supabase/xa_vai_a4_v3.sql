-- Phiếu A4 xả vải: tên máy gửi lệnh in ở ô "Người xả" (05/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md mục "Đợt 4").
--
-- Vì sao: người dùng (05/11, sau tờ in thử agent 0.12.0) "Mã phiếu IT cần chuyển lên giữa đầu trang tận dụng mép giấy. Bỏ phần người kiểm tra.
-- Người xả lấy tên thiết bị gửi lệnh in."
--
-- Tác động:
--   * Thay (cùng chữ ký) _xa_vai_print_enqueue_body (bản đang chạy = xa_vai_a4_v2.sql): payload thêm deviceName = print_devices.name của máy
--     gửi lệnh (≤ 60 ký tự; máy không nhận ra → null). Không đổi trường nào khác, template_version vẫn 1.
--   * Agent 0.12.0 bỏ qua khoá lạ (vẫn in hai ô ký trống); agent 0.12.1 in tên máy trong ô "Người xả", bỏ ô "Người kiểm", barcode IT ở mép trên.
--   Phân loại: tương thích ngược (thêm khoá JSON).
-- Không DROP / DELETE → không cần --allow-destructive. Chạy lại được (create or replace).
-- Thứ tự lên: commit (chưa push) → migration này → người dùng cài agent 0.12.1 ở máy in A4 → in thử. Web không đổi.
-- Kiểm cục bộ: node tests/xa_vai_a4_v3_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v3.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v3.sql
-- kiem: select position('deviceName' in pg_get_functiondef('public._xa_vai_print_enqueue_body(text,text[],integer,text,boolean,text)'::regprocedure)) > 0 and position('itNumbers' in pg_get_functiondef('public._xa_vai_print_enqueue_body(text,text[],integer,text,boolean,text)'::regprocedure)) > 0 and not has_function_privilege('anon', 'public._xa_vai_print_enqueue_body(text,text[],integer,text,boolean,text)', 'execute')
-- Rút lui: chạy lại khối _xa_vai_print_enqueue_body của xa_vai_a4_v2.sql.
begin;

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
  -- v3 (xa_vai_a4_v3, 05/11/2026): + deviceName = tên máy (print_devices.name) GỬI lệnh này — ô "Người xả" trên phiếu (agent 0.12.1).
  -- Máy chưa kích hoạt / đã tắt → null (ô ký để trống). In lại: tên máy gửi lệnh in lại.
  v_device := public.print_device_by_token(p_access_token);
  -- v2 (xa_vai_a4_v2, 05/11/2026): thêm trường cho phiếu A4 bản mới (agent 0.12.0) — itNumbers (phiếu IT của các UID, barcode), từng dòng
  -- itNumber, fabricCode / color (tách từ tên SKU), unit + systemQty / actualQty theo ĐƠN VỊ GỐC của SKU. Giữ nguyên mọi trường v1: agent 0.11.0
  -- bỏ qua trường lạ và in mẫu cũ (mm). Dòng xếp theo SKU rồi giờ nhập (phiếu nhóm theo SKU).
  select jsonb_build_object('itemCode', v_item, 'productName', v_name, 'printedAt', public._xa_vai_iso(now()),
           'reprint', v_reprint,
           'deviceName', (select left(nullif(btrim(d.name), ''), 60) from public.print_devices d where d.id = v_device),
           'itNumbers', coalesce((select jsonb_agg(distinct c.it order by c.it) from (select (select x.it_number from public.xa_vai_it_uids x where x.group_uid_code = u order by x.added_at desc, x.it_number limit 1) as it from unnest(v_uids) as u) c where c.it is not null), '[]'::jsonb),
           'items', coalesce(jsonb_agg(jsonb_build_object('groupUid', m.group_uid_code, 'sku', m.sku, 'lot', m.batch_code, 'roll', m.roll_code,
                      'systemMm', m.system_mm, 'actualMm', m.actual_mm, 'measuredAt', public._xa_vai_iso(m.measured_at))
                      || public._xa_vai_unit_json(m, s.product_name)
                      || jsonb_build_object('itNumber', (select x.it_number from public.xa_vai_it_uids x where x.group_uid_code = m.group_uid_code order by x.added_at desc, x.it_number limit 1))
                      order by m.sku, m.measured_at, m.group_uid_code), '[]'::jsonb))
    into v_payload
    from public.xa_vai_measures m left join public."SKU_Name" s on s.sku = m.sku where m.group_uid_code = any(v_uids);
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
