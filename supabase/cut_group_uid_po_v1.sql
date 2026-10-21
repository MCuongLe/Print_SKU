-- CẮT GROUP UID lọc theo PO (21/10/2026, kế hoạch docs/plans/2026-10-21-cat-uid-loc-po.md).
-- Vì sao: người dùng yêu cầu "Phần cắt group UID thêm chức năng lọc theo PO". Bảng cut_group_uids và group_uid_details chưa có
-- PO; PO chỉ có ở phiên Lấy mẫu theo PO (cut_sample_sessions.po). Người dùng chốt (21/10): nguồn PO = LƯU KHI ĐỒNG BỘ GROUP UID
-- (như RFID, group_uid_rfid_v1.sql) và CHỈ lưu số PO. Dò WMS 21/10: dòng group-uid-infos có processing_source_type /
-- processing_source_code khi UID có nguồn; Extension gửi purchase_order = processing_source_code khi type = PURCHASE_ORDER (mã
-- 6–40 chữ số), ngược lại null (kiểm kê, chuyển kho, tạo tay — WMS không có PO). Khoảng 44 % UID Available kho MTG có PO.
-- Tác động:
--   1. Cột purchase_order (text, NULL = UID không nhận theo PO) ở group_uid_sync_staging + group_uid_details, cờ
--      staging.purchase_order_known (Edge đặt true khi dòng có khoá purchase_order đúng dạng). KHÔNG index PO (lọc qua
--      coalesce hai bảng không dùng được index — review 21/10). KHÔNG ràng buộc duy nhất / check: dữ liệu WMS lạ không được
--      làm hỏng cả lượt đồng bộ.
--   2. group_uid_sync_preview / group_uid_sync_apply (= bản group_uid_rfid_v1.sql, chép nguyên văn) so/ghi purchase_order CHỈ
--      khi known — y như group_rfid_mapping: known + nguồn null = ghi null; Extension cũ (≤ 0.10.3, không gửi khoá) / giá trị
--      sai dạng → known = false → giữ PO đang lưu. PO KHÔNG tính ở nhánh stale_source (apply chỉ ghi khi nguồn mới hơn: lệch PO
--      ở dòng nguồn cũ hơn sẽ giữ lượt tự động held mãi — bài học RFID 20/10).
--   3. cut_group_uids.po (text, NULL = chưa biết), không index. Ghi lúc cắt:
--      _cut_group_uid_scan_body (= bản floor_access_v1.sql) lấy group_uid_details.purchase_order của UID; _cut_sample_confirm_body
--      (= bản floor_access_v1.sql) lấy số PO của phiên (cut_sample_sessions.po). Hàm công khai cut_group_uid_scan /
--      cut_sample_confirm (bọc floor_access_check) giữ nguyên, không đụng. Bản chụp ở cut_group_uids giữ PO khi UID bị dọn khỏi
--      group_uid_details (Canceled > 180 ngày).
--   4. cut_group_uid_search (= bản cut_group_uid_v5_adj_export.sql) và cut_group_uid_reconcile (= bản group_uid_qc_status_v1.sql):
--      thêm p_po text default '' (tham số cuối), lọc KHỚP ĐÚNG coalesce(cut_group_uids.po, group_uid_details.purchase_order) =
--      btrim(p_po) (dòng cắt cũ có PO ngay sau lượt đồng bộ toàn bộ, không cần backfill), mỗi dòng trả thêm 'po' (null nếu chưa
--      có), data trả thêm 'filterPo'. Mọi khoá cũ giữ nguyên. Đổi chữ ký nên DROP chữ ký cũ trước khi tạo (PostgREST không lẫn hai
--      bản); web cũ gọi theo tên không có p_po vẫn chạy (p_po có default). Quyền như cũ (anon + authenticated) trên chữ ký mới.
-- Lấp dữ liệu: chạy "Toàn bộ" ở Đồng bộ Group UID một lần sau khi lên (lượt đầu báo 'updated' cho mọi UID có PO — khoảng 4.000+,
-- vượt ngưỡng 3.000 của lượt tự động nên chạy tay). WMS có thể không đổi updated_date khi đổi nguồn → lượt gia tăng có thể không
-- thấy; lượt toàn bộ ban đêm bắt được.
-- Cần có trước: group_uid_rfid_v1.sql (preview/apply bản mới nhất), floor_access_v1.sql (thân _…_body), cut_group_uid_v5_adj_export.sql,
-- group_uid_qc_status_v1.sql (reconcile), cut_sample_v1.sql (cut_sample_sessions.po).
-- Thứ tự lên (bắt buộc): (1) migration này → (2) deploy Edge group-uid-sync (ghi staging.purchase_order; chạy trên database chưa
-- có cột sẽ lỗi khi lưu trang) → (3) Reload Extension (gửi purchase_order) + tải lại tab WMS, cả máy chạy auto-sync → (4) push web
-- (gửi p_po; web gọi p_po trước migration sẽ bị PostgREST báo không có hàm) → (5) "Toàn bộ" Group UID.
-- Edge cũ / Extension cũ vẫn chạy được sau migration này (purchase_order_known = false, giữ PO).
-- Có DROP FUNCTION (hai chữ ký cũ, tạo lại ngay trong cùng giao dịch; không xoá dữ liệu) nên cần --allow-destructive.
-- Chạy: python scripts/apply_supabase_sql.py supabase/cut_group_uid_po_v1.sql --allow-destructive
begin;

alter table public.group_uid_sync_staging add column if not exists purchase_order text;
alter table public.group_uid_details add column if not exists purchase_order text;
alter table public.group_uid_sync_staging add column if not exists purchase_order_known boolean not null default false;
comment on column public.group_uid_sync_staging.purchase_order is
  'Số PO nguồn (WMS processing_source_code khi processing_source_type = PURCHASE_ORDER) của lượt đồng bộ; NULL = UID không nhận theo PO hoặc nguồn không biết (xem purchase_order_known).';
comment on column public.group_uid_sync_staging.purchase_order_known is
  'true = nguồn có khoá purchase_order đúng dạng (Extension mới), PO được so/ghi; false = Extension cũ / sai dạng, giữ PO đang lưu.';
comment on column public.group_uid_details.purchase_order is
  'Số PO nguồn của UID (WMS processing_source_code khi nhận theo PO); NULL = không nhận theo PO hoặc chưa đồng bộ.';

alter table public.cut_group_uids add column if not exists po text;
comment on column public.cut_group_uids.po is
  'Số PO ghi lúc cắt (Cắt tự do: group_uid_details.purchase_order; Theo PO: cut_sample_sessions.po); NULL = chưa biết, tra cứu dùng coalesce với group_uid_details.';

-- ---------------------------------------------------------------------------------------------
-- Preview = bản group_uid_rfid_v1.sql + so PO (chỉ khi known, không ở stale_source)
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
      case when s.group_rfid_known and g.group_rfid_mapping is distinct from s.group_rfid_mapping then 'group_rfid_mapping' end,
      -- PO: chỉ khi nguồn có khoá purchase_order đúng dạng; khi đó nguồn null (UID không theo PO) cũng so.
      case when s.purchase_order_known and g.purchase_order is distinct from s.purchase_order then 'purchase_order' end
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
      (s.group_rfid_known and g.group_rfid_mapping is distinct from s.group_rfid_mapping) or
      (s.purchase_order_known and g.purchase_order is distinct from s.purchase_order));

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
      -- (held) lượt tự động mãi mà không bao giờ nạp được. PO cũng vậy (cut_group_uid_po_v1).

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
-- Apply = bản group_uid_rfid_v1.sql + ghi/xác minh PO (chỉ khi known)
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
          (s.purchase_order_known and g.purchase_order is distinct from s.purchase_order) or
          (sp.group_uid_code is not null and coalesce(pr.products,'[]'::jsonb) is distinct from sp.products))));
  create index on gu_touch(group_uid_code);
  select count(*) into v_written from gu_touch;

  -- Khoá các dòng sắp ghi để không bị tiến trình khác chen vào giữa chừng.
  perform 1 from public.group_uid_details g join gu_touch t using(group_uid_code) for update of g;

  insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status,qc_status,group_rfid_mapping,purchase_order)
  select s.group_uid_code,s.batch_code,s.roll_code,s.warehouse,s.location,t.eff_sku,s.qty,s.updated_by,s.updated_date,s.status,s.qc_status,
         case when s.group_rfid_known then s.group_rfid_mapping else g.group_rfid_mapping end,
         -- PO: như RFID — nguồn không biết (Extension cũ / sai dạng) → giữ giá trị đang có (dòng mới → null).
         case when s.purchase_order_known then s.purchase_order else g.purchase_order end
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
    group_rfid_mapping=excluded.group_rfid_mapping,
    -- PO: excluded đã mang giá trị chọn sẵn (known → nguồn, kể cả null; không known → giá trị cũ). Không coalesce.
    purchase_order=excluded.purchase_order
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
      (s.purchase_order_known and g.purchase_order is distinct from s.purchase_order) or
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
-- Quét cắt (thân nội bộ, bản floor_access_v1.sql) + ghi po = group_uid_details.purchase_order (null nếu UID chưa có PO).
-- Hàm công khai cut_group_uid_scan (kiểm floor_access_check rồi gọi thân này) giữ nguyên.
-- ---------------------------------------------------------------------------------------------
create or replace function public._cut_group_uid_scan_body(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text; v_source record; v_existing public.cut_group_uids; v_row public.cut_group_uids;
begin
  v_code := nullif(btrim(p_group_uid),'');
  if v_code is null or length(v_code)>40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_GROUP_UID','message','Group UID cần từ 1 đến 40 ký tự'));
  end if;
  select c.* into v_existing from public.cut_group_uids c where c.group_uid_code=v_code;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object(
      'code','ALREADY_CUT','message','Group UID này đã được cắt trước đó',
      'data',jsonb_build_object('groupUid',v_existing.group_uid_code,'sku',v_existing.sku,'status',v_existing.print_status,'cutAt',v_existing.cut_at)));
  end if;
  select g.group_uid_code,btrim(coalesce(g.sku,'')) sku,
         btrim(coalesce(s.product_name,'')) product_name,
         btrim(coalesce(g.batch_code,'')) lot,btrim(coalesce(g.roll_code,'')) roll,
         (s.sku is not null and s.status is distinct from '1') as sku_inactive,
         g.purchase_order as po
    into v_source
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku=g.sku
   where g.group_uid_code=v_code;
  if not found or v_source.sku='' or v_source.product_name='' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','Group UID chưa có đủ dữ liệu. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  insert into public.cut_group_uids(group_uid_code,sku,product_name,lot,roll,po)
  values(v_source.group_uid_code,v_source.sku,v_source.product_name,left(v_source.lot,20),left(v_source.roll,20),v_source.po)
  on conflict (group_uid_code) do nothing
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_CUT','message','Group UID này vừa được cắt trên thiết bị khác'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'productName',v_row.product_name,
    'lot',v_row.lot,'roll',v_row.roll,'printStatus',v_row.print_status,'cutAt',v_row.cut_at,'skuInactive',v_source.sku_inactive),
    'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Xác nhận Theo PO (thân nội bộ, bản floor_access_v1.sql) + ghi po = số PO của phiên (cut_sample_sessions.po).
-- Hàm công khai cut_sample_confirm (hai bản, kiểm floor_access_check rồi gọi thân này) giữ nguyên.
-- ---------------------------------------------------------------------------------------------
create or replace function public._cut_sample_confirm_body(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pushed integer; v_marked integer; v_missing text[]; v_left integer;
begin
  if not exists(select 1 from public.cut_sample_sessions where id = p_session) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu đã bị xóa'));
  end if;
  with todo as (
    select i.id, i.group_uid_code, i.sku, i.lot, i.roll, btrim(coalesce(s.product_name, '')) as product_name, ss.po
      from public.cut_sample_items i join public.cut_sample_sessions ss on ss.id = i.session_id left join public."SKU_Name" s on s.sku = i.sku
     where i.session_id = p_session and i.role = 'cut' and i.scanned_at is not null and i.pushed_at is null
  ), ins as (
    insert into public.cut_group_uids(group_uid_code, sku, product_name, lot, roll, po)
    select t.group_uid_code, t.sku, t.product_name, left(t.lot, 20), left(t.roll, 20), t.po from todo t where t.product_name <> ''
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

-- ---------------------------------------------------------------------------------------------
-- Tra cứu UID đã cắt (bản cut_group_uid_v5_adj_export.sql) + p_po (khớp đúng) + 'po' mỗi dòng + 'filterPo'.
-- Đổi chữ ký: drop bản 7 tham số rồi tạo bản 8 tham số (p_po cuối, có default).
-- ---------------------------------------------------------------------------------------------
drop function if exists public.cut_group_uid_search(text,text,text,date,date,text,integer);

create or replace function public.cut_group_uid_search(p_access_token text,p_sku text default '',p_lot text default '',p_date_from date default null,p_date_to date default null,p_adj text default '',p_limit integer default 5000,p_po text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,'')); v_adj text := lower(btrim(coalesce(p_adj,''))); v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
  v_po text := btrim(coalesce(p_po,''));
begin
  if v_adj not in ('','done','pending') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ADJ_FILTER','message','Bộ lọc ADJ không hợp lệ'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
      'printStatus',q.print_status,'cutAt',q.cut_at,'printedAt',q.printed_at,'adjExportedAt',q.adj_exported_at,'po',q.eff_po
    ) order by q.cut_at desc) from (
      -- PO: bản chụp lúc cắt (c.po), chưa có thì PO đang lưu của UID (dòng cắt trước khi có cột / trước lượt đồng bộ có PO).
      select c.*, coalesce(c.po,d.purchase_order) as eff_po from public.cut_group_uids c
        left join public.group_uid_details d on d.group_uid_code=c.group_uid_code
       where (v_sku='' or c.sku ilike '%'||v_sku||'%')
         and (v_lot='' or c.lot ilike '%'||v_lot||'%')
         and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
         and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
         and (v_adj='' or (v_adj='done')=(c.adj_exported_at is not null))
         and (v_po='' or coalesce(c.po,d.purchase_order)=v_po)
       order by c.cut_at desc limit v_limit
    ) q),'[]'::jsonb),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'filterAdj',v_adj,'filterPo',v_po,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- ---------------------------------------------------------------------------------------------
-- Đối chiếu ADJ (bản group_uid_qc_status_v1.sql) + p_po (khớp đúng) + 'po' mỗi dòng + 'filterPo'.
-- Đổi chữ ký: drop bản 6 tham số rồi tạo bản 7 tham số (p_po cuối, có default).
-- ---------------------------------------------------------------------------------------------
drop function if exists public.cut_group_uid_reconcile(text,text,text,date,date,integer);

create or replace function public.cut_group_uid_reconcile(
  p_access_token text, p_sku text default '', p_lot text default '',
  p_date_from date default null, p_date_to date default null, p_limit integer default 5000,
  p_po text default ''
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,''));
        v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
        v_po text := btrim(coalesce(p_po,''));
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
        'printStatus',q.print_status,'cutAt',q.cut_at,'adjExportedAt',q.adj_exported_at,
        'adjResolvedAt',q.adj_resolved_at,'adjResolvedState',q.adj_resolved_state,
        'qcStatus',q.qc_status,'po',q.eff_po,
        'wmsCuts',coalesce((select jsonb_agg(jsonb_build_object('cutAt',w.cut_at,'qty',w.qty,'remaining',w.remaining_qty,'by',w.cut_by) order by w.cut_at)
                              from public.wms_group_uid_cuts w where w.group_uid_code=q.group_uid_code and w.cut_at>=q.cut_at),'[]'::jsonb)
      ) order by q.cut_at desc) from (
        select c.*, g.qc_status, coalesce(c.po,g.purchase_order) as eff_po from public.cut_group_uids c
          left join public.group_uid_details g on g.group_uid_code=c.group_uid_code
         where (v_sku='' or c.sku ilike '%'||v_sku||'%')
           and (v_lot='' or c.lot ilike '%'||v_lot||'%')
           and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
           and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
           and (v_po='' or coalesce(c.po,g.purchase_order)=v_po)
         order by c.cut_at desc limit v_limit
      ) q),'[]'::jsonb),
    'coverage',(select case when count(*)=0 then null else jsonb_build_object(
        'from',min(data_from),'until',max(data_until),'files',count(*),'importedAt',max(created_at)) end
        from public.wms_group_uid_history_imports),
    'lastImport',(select jsonb_build_object('fileName',i.file_name,'createdAt',i.created_at,'cutRows',i.cut_rows,
        'newRows',i.new_rows,'changedRows',i.changed_rows,'dataUntil',i.data_until)
        from public.wms_group_uid_history_imports i order by i.created_at desc limit 1),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'filterPo',v_po,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- Quyền: preview/apply như group_uid_rfid_v1.sql; thân nội bộ như floor_access_v1.sql (không cấp); search/reconcile như
-- cut_group_uid_v5_adj_export.sql / group_uid_qc_status_v1.sql nhưng trên chữ ký mới.
revoke all on function public.group_uid_sync_preview(uuid) from public, anon, authenticated;
revoke all on function public.group_uid_sync_apply(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_preview(uuid) to service_role;
grant execute on function public.group_uid_sync_apply(uuid) to service_role;
revoke all on function public._cut_group_uid_scan_body(text, text) from public, anon, authenticated;
revoke all on function public._cut_sample_confirm_body(uuid) from public, anon, authenticated;
revoke all on function public.cut_group_uid_search(text,text,text,date,date,text,integer,text) from public;
grant execute on function public.cut_group_uid_search(text,text,text,date,date,text,integer,text) to anon, authenticated;
revoke all on function public.cut_group_uid_reconcile(text,text,text,date,date,integer,text) from public;
grant execute on function public.cut_group_uid_reconcile(text,text,text,date,date,integer,text) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
