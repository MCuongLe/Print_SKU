-- Group UID: trạng thái QC (Evaluation Pass/Fail) từ WMS (16/10/2026).
-- Vì sao: WMS group-uid-infos có quality_control_status_name ("Passed"/"Failed"/…); thao tác Evaluation Pass chỉ đổi trường
-- này. Tab Đối chiếu ADJ cần biết UID đã QC Passed để xếp lệnh Cut mẫu vào nhóm "Cắt mẫu QC" thay vì cảnh báo "Cut nhiều lần".
-- Chỉ lưu trạng thái, không lưu người/giờ QC, không đọc bản chấm survey-responses.
-- Tác động:
--   1. Thêm cột qc_status (text, NULL = chưa biết) vào group_uid_sync_staging và group_uid_details. Không đổi dữ liệu cũ.
--   2. group_uid_sync_preview v6 (= v5 trong group_uid_canceled_purge_v1.sql): nguồn có qc_status khác database thì là
--      thay đổi (nhánh updated và stale_source), changed_fields có 'qc_status'. Nguồn null (Extension < 0.9.5, hoặc WMS không
--      có trạng thái QC) không tính là thay đổi. Logic Canceled quá hạn / skippedCanceled giữ nguyên.
--      Lượt đồng bộ đầu tiên sau khi lên đủ (Edge + Extension 0.9.5) sẽ báo "updated" cho mọi UID đã có trạng thái QC trên
--      WMS (database đang null): đó là nạp lần đầu, không phải lỗi; lượt Đối chiếu toàn bộ sẽ nạp hết một lần.
--   3. group_uid_sync_apply v8 (= v7 trong group_uid_sync_v7_apply_guard.sql): ghi qc_status; nguồn null thì giữ giá trị
--      đã lưu (coalesce); xác minh chỉ so khi nguồn có qc_status. Giữ nguyên gu_src_prod/gu_prod/khoá FOR UPDATE/written.
--   4. cut_group_uid_reconcile (= bản trong cut_group_uid_v8_adj_resolved.sql): mỗi item thêm 'qcStatus' (null nếu UID
--      không có trong group_uid_details hoặc chưa biết). Chữ ký, kiểu trả về jsonb, quyền giữ nguyên.
-- Thứ tự lên (bắt buộc): (1) chạy migration này → (2) deploy Edge group-uid-sync (Edge mới ghi staging.qc_status; chạy trên
-- database chưa có cột sẽ lỗi khi lưu trang) → (3) Reload Extension 0.9.5 trong chrome://extensions + tải lại tab Inside/WMS
-- → (4) web. Edge cũ / Extension cũ vẫn chạy được sau migration này (qc_status null, hành vi cũ).
-- Chạy: python scripts/apply_supabase_sql.py supabase/group_uid_qc_status_v1.sql
begin;

alter table public.group_uid_sync_staging add column if not exists qc_status text;
alter table public.group_uid_details add column if not exists qc_status text;
comment on column public.group_uid_sync_staging.qc_status is
  'Trạng thái QC WMS (quality_control_status_name) của lượt đồng bộ; NULL = Extension cũ không gửi hoặc WMS không có.';
comment on column public.group_uid_details.qc_status is
  'Trạng thái QC WMS (quality_control_status_name, ví dụ Passed/Failed); NULL = chưa biết. Đồng bộ nguồn NULL không xoá giá trị cũ.';

-- ---------------------------------------------------------------------------------------------
-- Preview v6 = v5 (bỏ qua Canceled quá hạn, bỏ qua chỉ đổi updated_date) + so trạng thái QC
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
      case when s.qc_status is not null and g.qc_status is distinct from s.qc_status then 'qc_status' end
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
      (s.qc_status is not null and g.qc_status is distinct from s.qc_status));

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
-- Apply v8 = v7 (gu_touch, chuẩn hoá thành phần, khoá FOR UPDATE) + ghi/xác minh trạng thái QC
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
          (sp.group_uid_code is not null and coalesce(pr.products,'[]'::jsonb) is distinct from sp.products))));
  create index on gu_touch(group_uid_code);
  select count(*) into v_written from gu_touch;

  -- Khoá các dòng sắp ghi để không bị tiến trình khác chen vào giữa chừng.
  perform 1 from public.group_uid_details g join gu_touch t using(group_uid_code) for update of g;

  insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status,qc_status)
  select s.group_uid_code,s.batch_code,s.roll_code,s.warehouse,s.location,t.eff_sku,s.qty,s.updated_by,s.updated_date,s.status,s.qc_status
    from public.group_uid_sync_staging s join gu_touch t using(group_uid_code)
   where s.run_id=p_run_id
  on conflict(group_uid_code) do update set
    batch_code=excluded.batch_code,roll_code=excluded.roll_code,warehouse=excluded.warehouse,
    location=excluded.location,sku=excluded.sku,qty=excluded.qty,updated_by=excluded.updated_by,
    updated_date=excluded.updated_date,status=excluded.status,
    -- v8: nguồn null (Extension cũ) thì giữ trạng thái QC đã lưu.
    qc_status=coalesce(excluded.qc_status,public.group_uid_details.qc_status)
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
-- Đối chiếu Cắt UID: thêm qcStatus cho từng item. group_uid_details.group_uid_code là khoá chính nên left join không nhân dòng;
-- chọn c.* + g.qc_status (không select *) để cột trùng tên của hai bảng không làm q.sku/q.group_uid_code mơ hồ.
-- ---------------------------------------------------------------------------------------------
create or replace function public.cut_group_uid_reconcile(
  p_access_token text, p_sku text default '', p_lot text default '',
  p_date_from date default null, p_date_to date default null, p_limit integer default 5000
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,''));
        v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
        'printStatus',q.print_status,'cutAt',q.cut_at,'adjExportedAt',q.adj_exported_at,
        'adjResolvedAt',q.adj_resolved_at,'adjResolvedState',q.adj_resolved_state,
        'qcStatus',q.qc_status,
        'wmsCuts',coalesce((select jsonb_agg(jsonb_build_object('cutAt',w.cut_at,'qty',w.qty,'remaining',w.remaining_qty,'by',w.cut_by) order by w.cut_at)
                              from public.wms_group_uid_cuts w where w.group_uid_code=q.group_uid_code and w.cut_at>=q.cut_at),'[]'::jsonb)
      ) order by q.cut_at desc) from (
        select c.*, g.qc_status from public.cut_group_uids c
          left join public.group_uid_details g on g.group_uid_code=c.group_uid_code
         where (v_sku='' or c.sku ilike '%'||v_sku||'%')
           and (v_lot='' or c.lot ilike '%'||v_lot||'%')
           and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
           and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
         order by c.cut_at desc limit v_limit
      ) q),'[]'::jsonb),
    'coverage',(select case when count(*)=0 then null else jsonb_build_object(
        'from',min(data_from),'until',max(data_until),'files',count(*),'importedAt',max(created_at)) end
        from public.wms_group_uid_history_imports),
    'lastImport',(select jsonb_build_object('fileName',i.file_name,'createdAt',i.created_at,'cutRows',i.cut_rows,
        'newRows',i.new_rows,'changedRows',i.changed_rows,'dataUntil',i.data_until)
        from public.wms_group_uid_history_imports i order by i.created_at desc limit 1),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- Quyền như cũ (group_uid_sync_v1.sql, cut_group_uid_v6_wms_reconcile.sql); create or replace vốn giữ quyền, lặp lại cho chắc.
revoke all on function public.group_uid_sync_preview(uuid) from public, anon, authenticated;
revoke all on function public.group_uid_sync_apply(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_preview(uuid) to service_role;
grant execute on function public.group_uid_sync_apply(uuid) to service_role;
revoke all on function public.cut_group_uid_reconcile(text,text,text,date,date,integer) from public;
grant execute on function public.cut_group_uid_reconcile(text,text,text,date,date,integer) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
