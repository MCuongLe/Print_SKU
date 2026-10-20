-- RFID ↔ Group UID (20/10/2026): lưu mã RFID dán trên cuộn (WMS group_rfid_mapping) để quét tem RFID ra Group UID.
-- Vì sao: người dùng yêu cầu "Cho phép Scan RFID mapping link với group UID"; nguồn liên kết chốt là ĐỒNG BỘ TỪ WMS (dò DevTools
-- 20/10: dòng group-uid-infos có khoá group_rfid_mapping khi UID đã gắn RFID, khoá vắng khi chưa gắn; mã 1 chữ + 11 số). Máy quét
-- bắn mã in trên tem RFID. Phạm vi quét đợt này: màn LỰA UID BLOCKED.
-- Tác động:
--   1. Thêm cột group_rfid_mapping (text, NULL = chưa gắn RFID) vào group_uid_sync_staging và group_uid_details + index một phần
--      group_uid_details_rfid_idx (chỉ dòng khác null, ~2.000 dòng). KHÔNG ràng buộc duy nhất: dữ liệu WMS lỗi (hai UID một
--      RFID) không được làm hỏng cả lượt đồng bộ; hàm tra trả mọi UID trùng để web xử lý.
--   2. group_uid_sync_preview (= v6 trong group_uid_qc_status_v1.sql, chép nguyên văn) thêm RFID: nguồn có khoá (known) và khác
--      database (kể cả nguồn null) là thay đổi ở nhánh updated (KHÔNG tính ở stale_source), changed_fields có 'group_rfid_mapping'.
--   3. group_uid_sync_apply (= v8 trong group_uid_qc_status_v1.sql, chép nguyên văn) ghi RFID: gu_touch + xác minh so cột,
--      on conflict ghi thẳng excluded — nguồn null = WMS gỡ RFID → xoá theo (KHÁC qc_status vẫn coalesce giữ giá trị cũ).
--   Cờ staging.group_rfid_known (Edge đặt true khi dòng có khoá group_rfid_mapping; Extension 0.10.2+ luôn gửi khoá, kể cả
--   null): Extension cũ (0.10.1 trở xuống) / web cũ không gửi khoá → known = false → preview không tính RFID là thay đổi, apply
--   không so RFID và giữ giá trị đang lưu. Máy chưa Reload Extension không xoá RFID.
--   4. Hàm mới group_uid_by_rfid(p_codes text[]) cho anon + authenticated: tra tối đa 100 mã RFID → [{rfid, groupUid, status}].
--   5. uid_block_snapshot (= bản trong uid_block_v1.sql, giữ chữ ký/khoá JSON/quyền/nhánh unchanged): mỗi item thêm 'rfid'
--      (left join group_uid_details). Cache web kiểm theo id danh sách nên RFID gắn sau khi nạp danh sách không đổi phiên bản —
--      chấp nhận, web gọi group_uid_by_rfid cho mã RFID không có trên máy.
-- Lấp dữ liệu cũ: chạy "Đối chiếu toàn bộ" Group UID một lần sau khi lên (lượt đầu báo 'updated' cho mọi UID đã có RFID: nạp
-- lần đầu, không phải lỗi). WMS có thể không đổi updated_date khi chỉ đổi RFID → lượt gia tăng có thể không thấy; lượt toàn bộ
-- ban đêm bắt được.
-- Cần có trước: group_uid_qc_status_v1.sql (cột qc_status, preview v6, apply v8), uid_block_v1.sql (bảng/hàm Lựa UID blocked).
-- Thứ tự lên (bắt buộc): (1) migration này → (2) deploy Edge group-uid-sync (ghi staging.group_rfid_mapping; chạy trên database
-- chưa có cột sẽ lỗi khi lưu trang) → (3) Reload Extension 0.10.2 + tải lại tab WMS → (4) push web → (5) Đối chiếu toàn bộ.
-- Edge cũ / Extension cũ vẫn chạy được sau migration này (RFID null).
-- Chỉ thêm cột/index/hàm và thay hàm, không drop gì: không cần --allow-destructive.
-- Chạy: python scripts/apply_supabase_sql.py supabase/group_uid_rfid_v1.sql
begin;

alter table public.group_uid_sync_staging add column if not exists group_rfid_mapping text;
alter table public.group_uid_details add column if not exists group_rfid_mapping text;
alter table public.group_uid_sync_staging add column if not exists group_rfid_known boolean not null default false;
comment on column public.group_uid_sync_staging.group_rfid_mapping is
  'Mã RFID WMS (group_rfid_mapping, viết hoa) của lượt đồng bộ; NULL = UID chưa gắn RFID hoặc Extension cũ không gửi (xem group_rfid_known).';
comment on column public.group_uid_sync_staging.group_rfid_known is
  'true = nguồn có khoá group_rfid_mapping (Extension 0.10.2+), RFID được so/ghi; false = Extension cũ, giữ RFID đang lưu.';
comment on column public.group_uid_details.group_rfid_mapping is
  'Mã RFID WMS (group_rfid_mapping, viết hoa) dán trên cuộn; NULL = chưa gắn. Đồng bộ nguồn NULL xoá giá trị cũ (WMS gỡ RFID).';
create index if not exists group_uid_details_rfid_idx on public.group_uid_details (group_rfid_mapping) where group_rfid_mapping is not null;

-- ---------------------------------------------------------------------------------------------
-- Preview = v6 (group_uid_qc_status_v1.sql) + so RFID
-- ---------------------------------------------------------------------------------------------
create or replace function public.group_uid_sync_preview(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_sync_runs;
  v_pages integer;
  v_source integer;
  v_added integer;
  v_updated integer;
  v_missing integer;
  v_stale integer;
  v_skipped integer;
  v_unchanged integer;
  v_previous_full integer;
  v_drop numeric := 0;
  v_counts jsonb;
begin
  select * into v_run from public.group_uid_sync_runs where id=p_run_id for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status <> 'running' then raise exception 'RUN_NOT_RUNNING'; end if;
  select count(*) into v_pages from public.group_uid_sync_pages where run_id=p_run_id;
  if v_run.expected_pages is null or v_pages <> v_run.expected_pages or
     exists(select 1 from generate_series(1,v_run.expected_pages) p where not exists(
       select 1 from public.group_uid_sync_pages x where x.run_id=p_run_id and x.page_no=p)) then
    raise exception 'PAGES_INCOMPLETE';
  end if;
  select count(*) into v_source from public.group_uid_sync_staging where run_id=p_run_id;
  if v_source <> v_run.source_count then raise exception 'SOURCE_COUNT_MISMATCH'; end if;
  if v_run.mode='full' and v_source<1000 then raise exception 'FULL_SOURCE_TOO_SMALL'; end if;

  delete from public.group_uid_sync_changes where run_id=p_run_id;
  -- v5: UID Canceled quá hạn chưa có trong database thì không nạp.
  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'added',null,to_jsonb(s)-'run_id',
         array['group_uid_code'],s.updated_date
    from public.group_uid_sync_staging s
    left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and g.group_uid_code is null
     and not public.group_uid_expired_canceled(s.status,s.updated_date);

  -- v4: chỉ đổi updated_date thì không phải thay đổi; apply vẫn nâng mốc từ staging.
  -- v5: cả hai bên đều Canceled và nguồn đã quá hạn thì bỏ qua (lần dọn sau xoá).
  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'updated',to_jsonb(g),(to_jsonb(s)-'run_id')||jsonb_build_object('sku',e.sku),
    array_remove(array[
      case when g.batch_code is distinct from s.batch_code then 'batch_code' end,
      case when g.roll_code is distinct from s.roll_code then 'roll_code' end,
      case when g.warehouse is distinct from s.warehouse then 'warehouse' end,
      case when g.location is distinct from s.location then 'location' end,
      case when g.sku is distinct from e.sku then 'sku' end,
      case when g.qty is distinct from s.qty then 'qty' end,
      case when g.updated_by is distinct from s.updated_by then 'updated_by' end,
      case when g.updated_date is distinct from s.updated_date then 'updated_date' end,
      case when g.status is distinct from s.status then 'status' end,
      -- v6: nguồn có trạng thái QC và khác database. Nguồn null (Extension cũ / WMS không có) không tính là thay đổi.
      case when s.qc_status is not null and g.qc_status is distinct from s.qc_status then 'qc_status' end,
      -- RFID: chỉ khi nguồn có khoá (Extension 0.10.2+); khi đó nguồn null cũng là thay đổi (WMS gỡ RFID → xoá theo).
      case when s.group_rfid_known and g.group_rfid_mapping is distinct from s.group_rfid_mapping then 'group_rfid_mapping' end
    ],null),s.updated_date
    from public.group_uid_sync_staging s join public.group_uid_details g using(group_uid_code)
    cross join lateral (select public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) as sku) e
   where s.run_id=p_run_id and s.updated_date >= g.updated_date
     and not (public.group_uid_expired_canceled(s.status,s.updated_date) and coalesce(g.status,'') ilike 'cancel%')
     and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from e.sku or g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or
      g.status is distinct from s.status or
      (s.qc_status is not null and g.qc_status is distinct from s.qc_status) or
      (s.group_rfid_known and g.group_rfid_mapping is distinct from s.group_rfid_mapping));

  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'stale_source',to_jsonb(g),(to_jsonb(s)-'run_id')||jsonb_build_object('sku',e.sku),array['updated_date'],s.updated_date
    from public.group_uid_sync_staging s join public.group_uid_details g using(group_uid_code)
    cross join lateral (select public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) as sku) e
   where s.run_id=p_run_id and s.updated_date < g.updated_date
     and not (public.group_uid_expired_canceled(s.status,s.updated_date) and coalesce(g.status,'') ilike 'cancel%')
     and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from e.sku or g.qty is distinct from s.qty or g.status is distinct from s.status or
      (s.qc_status is not null and g.qc_status is distinct from s.qc_status));
      -- RFID không tính ở nhánh này (review A 20/10): apply chỉ ghi khi nguồn mới hơn, nên lệch RFID ở dòng nguồn cũ hơn sẽ giữ
      -- (held) lượt tự động mãi mà không bao giờ nạp được.

  if v_run.mode='full' then
    -- v5: UID Canceled quá hạn trong database không phải "thiếu trên WMS" (sắp bị dọn).
    insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields)
    select p_run_id,g.group_uid_code,'missing',to_jsonb(g),null,array['group_uid_code']
      from public.group_uid_details g
     where not public.group_uid_expired_canceled(g.status,g.updated_date)
       and not exists(select 1 from public.group_uid_sync_staging s where s.run_id=p_run_id and s.group_uid_code=g.group_uid_code);
  end if;

  select count(*) into v_skipped
    from public.group_uid_sync_staging s left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and public.group_uid_expired_canceled(s.status,s.updated_date)
     and (g.group_uid_code is null or coalesce(g.status,'') ilike 'cancel%');

  select count(*) filter(where change_type='added'),count(*) filter(where change_type='updated'),
         count(*) filter(where change_type='missing'),count(*) filter(where change_type='stale_source')
    into v_added,v_updated,v_missing,v_stale
    from public.group_uid_sync_changes where run_id=p_run_id;
  v_unchanged := greatest(v_source-v_added-v_updated-v_stale-v_skipped,0);
  if v_run.mode='full' then
    select source_count into v_previous_full from public.group_uid_sync_runs
     where mode='full' and status='completed' and id<>p_run_id order by completed_at desc limit 1;
    if coalesce(v_previous_full,0)>0 and v_source<v_previous_full then
      v_drop := round((v_previous_full-v_source)::numeric*100/v_previous_full,2);
    end if;
  end if;
  v_counts := jsonb_build_object('added',v_added,'updated',v_updated,'unchanged',v_unchanged,
    'missing',v_missing,'issues',v_stale,'skippedCanceled',v_skipped,'totalChanges',v_added+v_updated);
  update public.group_uid_sync_runs set status='previewed',page_count=v_pages,source_count=v_source,
    valid_count=v_source,change_counts=v_counts,
    verification=jsonb_build_object('previousFullCount',v_previous_full,'fullDropPercent',v_drop),previewed_at=now()
   where id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'status','previewed','mode',v_run.mode,
    'rangeFrom',v_run.range_from,'rangeTo',v_run.range_to,'pageCount',v_pages,
    'sourceCount',v_source,'changeCounts',v_counts,
    'verification',jsonb_build_object('previousFullCount',v_previous_full,'fullDropPercent',v_drop));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Apply = v8 (group_uid_qc_status_v1.sql) + ghi/xác minh RFID
-- ---------------------------------------------------------------------------------------------
create or replace function public.group_uid_sync_apply(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_sync_runs;
  v_mismatch integer;
  v_verified integer;
  v_written integer;
  v_total integer;
  v_result jsonb;
begin
  select * into v_run from public.group_uid_sync_runs where id=p_run_id for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status='completed' then
    return jsonb_build_object('runId',p_run_id,'status','completed','verification',v_run.verification,'alreadyCompleted',true);
  end if;
  if v_run.status<>'previewed' then raise exception 'RUN_NOT_PREVIEWED'; end if;
  if v_run.previewed_at is null or v_run.previewed_at < now()-interval '30 minutes' then raise exception 'PREVIEW_EXPIRED'; end if;
  update public.group_uid_sync_runs set status='applying',applied_at=now(),error_message=null where id=p_run_id;

  -- Thành phần nguồn, chuẩn hoá cùng dạng với database (mảng theo sku tăng dần, cùng 3 khoá).
  create temp table gu_src_prod on commit drop as
  select s.group_uid_code,
         jsonb_agg(jsonb_build_object('sku',x.sku,'quantity',x.quantity,'product_name',x.product_name) order by x.sku) as products
    from public.group_uid_sync_staging s
    cross join lateral jsonb_to_recordset(s.products) as x(sku text,quantity numeric,product_name text)
   where s.run_id=p_run_id and jsonb_array_length(s.products)>0
   group by s.group_uid_code;
  create index on gu_src_prod(group_uid_code);

  -- Thành phần hiện có, gộp một lần cho các UID trong lượt.
  create temp table gu_prod on commit drop as
  select p.group_uid_code,
         jsonb_agg(jsonb_build_object('sku',p.sku,'quantity',p.qty,'product_name',p.product_name) order by p.sku) as products
    from public.group_uid_products p
   where exists (select 1 from public.group_uid_sync_staging s where s.run_id=p_run_id and s.group_uid_code=p.group_uid_code)
   group by p.group_uid_code;
  create index on gu_prod(group_uid_code);

  -- Dòng cần ghi: mới, hoặc đã có + nguồn không cũ hơn + khác một trường nghiệp vụ / khác thành phần.
  create temp table gu_touch on commit drop as
  select s.group_uid_code, public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) as eff_sku, (g.group_uid_code is null) as is_new
    from public.group_uid_sync_staging s
    left join public.group_uid_details g on g.group_uid_code=s.group_uid_code
    left join gu_prod pr on pr.group_uid_code=s.group_uid_code
    left join gu_src_prod sp on sp.group_uid_code=s.group_uid_code
   where s.run_id=p_run_id
     and (g.group_uid_code is not null or not public.group_uid_expired_canceled(s.status,s.updated_date))
     and (g.group_uid_code is null or (s.updated_date >= g.updated_date and (
          g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
          g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
          g.sku is distinct from public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) or
          g.qty is distinct from s.qty or g.updated_by is distinct from s.updated_by or
          g.status is distinct from s.status or
          (s.qc_status is not null and g.qc_status is distinct from s.qc_status) or
          (s.group_rfid_known and g.group_rfid_mapping is distinct from s.group_rfid_mapping) or
          (sp.group_uid_code is not null and coalesce(pr.products,'[]'::jsonb) is distinct from sp.products))));
  create index on gu_touch(group_uid_code);
  select count(*) into v_written from gu_touch;

  -- Khoá các dòng sắp ghi để không bị tiến trình khác chen vào giữa chừng.
  perform 1 from public.group_uid_details g join gu_touch t using(group_uid_code) for update of g;

  insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status,qc_status,group_rfid_mapping)
  select s.group_uid_code,s.batch_code,s.roll_code,s.warehouse,s.location,t.eff_sku,s.qty,s.updated_by,s.updated_date,s.status,s.qc_status,
         case when s.group_rfid_known then s.group_rfid_mapping else g.group_rfid_mapping end
    from public.group_uid_sync_staging s join gu_touch t using(group_uid_code)
    -- RFID: nguồn không có khoá (Extension cũ) → giữ giá trị đang có (dòng mới → null); đọc sau khi đã khoá FOR UPDATE.
    left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id
  on conflict(group_uid_code) do update set
    batch_code=excluded.batch_code,roll_code=excluded.roll_code,warehouse=excluded.warehouse,
    location=excluded.location,sku=excluded.sku,qty=excluded.qty,updated_by=excluded.updated_by,
    updated_date=excluded.updated_date,status=excluded.status,
    -- v8: nguồn null (Extension cũ) thì giữ trạng thái QC đã lưu.
    qc_status=coalesce(excluded.qc_status,public.group_uid_details.qc_status),
    -- RFID: excluded đã mang giá trị chọn sẵn (known → nguồn, null = WMS gỡ RFID → xoá theo; không known → giá trị cũ). KHÁC qc_status.
    group_rfid_mapping=excluded.group_rfid_mapping
  where excluded.updated_date >= public.group_uid_details.updated_date;

  -- Thành phần: chỉ khi nguồn có thành phần và nguồn không cũ hơn dòng hiện tại (kiểm lại lúc ghi).
  delete from public.group_uid_products p
   using public.group_uid_sync_staging s
   join gu_touch t using(group_uid_code)
   join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and p.group_uid_code=s.group_uid_code
     and jsonb_array_length(s.products)>0 and s.updated_date>=g.updated_date;
  insert into public.group_uid_products(group_uid_code,sku,qty,product_name)
  select s.group_uid_code,x.sku,x.quantity,x.product_name
    from public.group_uid_sync_staging s
    join gu_touch t using(group_uid_code)
    join public.group_uid_details g using(group_uid_code)
    cross join lateral jsonb_to_recordset(s.products) as x(sku text,quantity numeric,product_name text)
   where s.run_id=p_run_id and jsonb_array_length(s.products)>0 and s.updated_date>=g.updated_date
  on conflict(group_uid_code,sku) do update set qty=excluded.qty,product_name=excluded.product_name;

  -- Xác minh các dòng vừa ghi.
  create temp table gu_prod_after on commit drop as
  select p.group_uid_code,
         jsonb_agg(jsonb_build_object('sku',p.sku,'quantity',p.qty,'product_name',p.product_name) order by p.sku) as products
    from public.group_uid_products p join gu_touch t using(group_uid_code)
   group by p.group_uid_code;
  select count(*) into v_mismatch
    from public.group_uid_sync_staging s join gu_touch t using(group_uid_code)
    left join public.group_uid_details g using(group_uid_code)
    left join gu_prod_after pa using(group_uid_code)
    left join gu_src_prod sp using(group_uid_code)
   where s.run_id=p_run_id and (g.group_uid_code is null or (s.updated_date>=g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from t.eff_sku or g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or g.updated_date is distinct from s.updated_date or
      g.status is distinct from s.status or
      (s.qc_status is not null and g.qc_status is distinct from s.qc_status) or
      (s.group_rfid_known and g.group_rfid_mapping is distinct from s.group_rfid_mapping) or
      (sp.group_uid_code is not null and coalesce(pa.products,'[]'::jsonb) is distinct from sp.products))));
  if v_mismatch>0 then raise exception 'VERIFY_FAILED:%',v_mismatch; end if;

  select count(*) into v_total from public.group_uid_details;
  v_verified := v_run.source_count-coalesce((v_run.change_counts->>'issues')::integer,0)
                -coalesce((v_run.change_counts->>'skippedCanceled')::integer,0);
  v_result := jsonb_build_object('verified',v_verified,'written',v_written,'databaseCount',v_total,'errors',jsonb_build_array());

  insert into public.group_uid_sync_state(singleton,last_successful_incremental_at,last_successful_full_at,updated_at)
  values(true,v_run.range_to,case when v_run.mode='full' then now() end,now())
  on conflict(singleton) do update set
    last_successful_incremental_at=greatest(coalesce(public.group_uid_sync_state.last_successful_incremental_at,'-infinity'::timestamptz),excluded.last_successful_incremental_at),
    last_successful_full_at=case when v_run.mode='full' then excluded.last_successful_full_at else public.group_uid_sync_state.last_successful_full_at end,
    updated_at=now();
  update public.group_uid_sync_runs set status='completed',verification=v_result,completed_at=now(),error_message=null where id=p_run_id;
  delete from public.group_uid_sync_pages where run_id=p_run_id;
  delete from public.group_uid_sync_staging where run_id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'status','completed','changeCounts',v_run.change_counts,'verification',v_result);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Tra Group UID theo mã RFID (web LỰA UID BLOCKED khi mã RFID không có trên máy). Chỉ đọc.
-- p_codes tối đa 100 mã (quá → TOO_MANY); mỗi mã ≤ 64 ký tự; chuẩn hoá upper(btrim), bỏ rỗng/trùng.
-- Trả rows [{rfid, groupUid, status}] (một RFID có thể nhiều UID nếu WMS lỗi: trả hết, web xử lý); mã không có thì không có dòng.
-- ---------------------------------------------------------------------------------------------
create or replace function public.group_uid_by_rfid(p_codes text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_codes text[]; v_rows jsonb;
begin
  if p_codes is null then
    p_codes := '{}'::text[];
  end if;
  if cardinality(p_codes) > 100 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','TOO_MANY','message','Mỗi lần tra tối đa 100 mã RFID'));
  end if;
  if exists (select 1 from unnest(p_codes) as u(code) where length(u.code) > 64) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Có mã RFID dài bất thường'));
  end if;

  select coalesce(array_agg(distinct upper(btrim(u.code))), '{}'::text[]) into v_codes
    from unnest(p_codes) as u(code)
   where nullif(btrim(u.code), '') is not null;

  select coalesce(jsonb_agg(jsonb_build_object('rfid',g.group_rfid_mapping,'groupUid',g.group_uid_code,'status',g.status)
                            order by g.group_rfid_mapping, (coalesce(g.status,'') ilike 'cancel%'), g.updated_date desc nulls last, g.group_uid_code), '[]'::jsonb)
    into v_rows
    from public.group_uid_details g
   where g.group_rfid_mapping is not null and g.group_rfid_mapping = any(v_codes);

  return jsonb_build_object('ok',true,'data',jsonb_build_object('rows',v_rows),
                            'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- ---------------------------------------------------------------------------------------------
-- uid_block_snapshot = bản uid_block_v1.sql + 'rfid' mỗi item (group_uid_details.group_uid_code là khoá chính: không nhân dòng)
-- ---------------------------------------------------------------------------------------------
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
                                          'warehouse',i.warehouse,'location',i.location,'fileStatus',i.file_status,
                                          'rfid',g.group_rfid_mapping) order by i.group_uid_code)
        from public.uid_block_items i
        left join public.group_uid_details g on g.group_uid_code = i.group_uid_code
       where i.list_id = v_list.id), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Quyền: preview/apply như cũ (group_uid_qc_status_v1.sql); uid_block_snapshot như uid_block_v1.sql; hàm mới cho anon + authenticated.
revoke all on function public.group_uid_sync_preview(uuid) from public, anon, authenticated;
revoke all on function public.group_uid_sync_apply(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_preview(uuid) to service_role;
grant execute on function public.group_uid_sync_apply(uuid) to service_role;
revoke all on function public.group_uid_by_rfid(text[]) from public;
grant execute on function public.group_uid_by_rfid(text[]) to anon, authenticated;
revoke all on function public.uid_block_snapshot(uuid) from public;
grant execute on function public.uid_block_snapshot(uuid) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
