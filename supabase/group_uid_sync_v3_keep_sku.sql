-- Group UID sync v3 (08/10/2026): không ghi đè SKU đang có bằng "trống" khi WMS không trả dòng sản phẩm.
--
-- Phiên đối chiếu toàn bộ đầu tiên (08/10/2026 11:30) cho thấy 694 UID đang có SKU bị đặt sku = NULL:
--   * 445 UID nhiều SKU  — đúng thiết kế: sku của UID cha để trống, từng SKU nằm ở group_uid_products.
--   * 249 UID WMS trả danh sách sản phẩm rỗng (chủ yếu Closed) — mất thông tin thật, vì database đã có SKU.
-- Quy tắc mới (group_uid_sync_effective_sku): nguồn có đúng 1 SKU → dùng SKU đó; nguồn nhiều SKU → NULL;
-- nguồn KHÔNG có sản phẩm nào và không có SKU → giữ SKU/sản phẩm đã biết gần nhất (không xoá dòng group_uid_products).
-- preview, apply và bước đọc lại xác minh dùng cùng một quy tắc nên không báo "cập nhật" giả hay sai lệch giả.
-- Cuối file khôi phục 249 UID đã mất SKU từ before_data của bảng thay đổi (chạy lại không làm gì thêm).
begin;

create or replace function public.group_uid_sync_effective_sku(p_source_sku text, p_source_products jsonb, p_current_sku text)
returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    nullif(btrim(p_source_sku), ''),
    case when jsonb_array_length(coalesce(p_source_products, '[]'::jsonb)) = 0 then p_current_sku end
  )
$$;
revoke all on function public.group_uid_sync_effective_sku(text,jsonb,text) from public, anon, authenticated;
grant execute on function public.group_uid_sync_effective_sku(text,jsonb,text) to service_role;

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
  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'added',null,to_jsonb(s)-'run_id',
         array['group_uid_code'],s.updated_date
    from public.group_uid_sync_staging s
    left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and g.group_uid_code is null;

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
      case when g.status is distinct from s.status then 'status' end
    ],null),s.updated_date
    from public.group_uid_sync_staging s join public.group_uid_details g using(group_uid_code)
    cross join lateral (select public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) as sku) e
   where s.run_id=p_run_id and s.updated_date >= g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from e.sku or g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or g.updated_date is distinct from s.updated_date or
      g.status is distinct from s.status);

  insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields,source_updated_at)
  select p_run_id,s.group_uid_code,'stale_source',to_jsonb(g),(to_jsonb(s)-'run_id')||jsonb_build_object('sku',e.sku),array['updated_date'],s.updated_date
    from public.group_uid_sync_staging s join public.group_uid_details g using(group_uid_code)
    cross join lateral (select public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) as sku) e
   where s.run_id=p_run_id and s.updated_date < g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from e.sku or g.qty is distinct from s.qty or g.status is distinct from s.status);

  if v_run.mode='full' then
    insert into public.group_uid_sync_changes(run_id,group_uid_code,change_type,before_data,after_data,changed_fields)
    select p_run_id,g.group_uid_code,'missing',to_jsonb(g),null,array['group_uid_code']
      from public.group_uid_details g
     where not exists(select 1 from public.group_uid_sync_staging s where s.run_id=p_run_id and s.group_uid_code=g.group_uid_code);
  end if;

  select count(*) filter(where change_type='added'),count(*) filter(where change_type='updated'),
         count(*) filter(where change_type='missing'),count(*) filter(where change_type='stale_source')
    into v_added,v_updated,v_missing,v_stale
    from public.group_uid_sync_changes where run_id=p_run_id;
  v_unchanged := greatest(v_source-v_added-v_updated-v_stale,0);
  if v_run.mode='full' then
    select source_count into v_previous_full from public.group_uid_sync_runs
     where mode='full' and status='completed' and id<>p_run_id order by completed_at desc limit 1;
    if coalesce(v_previous_full,0)>0 and v_source<v_previous_full then
      v_drop := round((v_previous_full-v_source)::numeric*100/v_previous_full,2);
    end if;
  end if;
  v_counts := jsonb_build_object('added',v_added,'updated',v_updated,'unchanged',v_unchanged,
    'missing',v_missing,'issues',v_stale,'totalChanges',v_added+v_updated);
  update public.group_uid_sync_runs set status='previewed',page_count=v_pages,source_count=v_source,
    valid_count=v_source,change_counts=v_counts,
    verification=jsonb_build_object('previousFullCount',v_previous_full,'fullDropPercent',v_drop),previewed_at=now()
   where id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'status','previewed','mode',v_run.mode,
    'rangeFrom',v_run.range_from,'rangeTo',v_run.range_to,'pageCount',v_pages,
    'sourceCount',v_source,'changeCounts',v_counts,
    'verification',jsonb_build_object('previousFullCount',v_previous_full,'fullDropPercent',v_drop));
end $$;

create or replace function public.group_uid_sync_apply(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_sync_runs;
  v_mismatch integer;
  v_verified integer;
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

  insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status)
  select s.group_uid_code,s.batch_code,s.roll_code,s.warehouse,s.location,
         public.group_uid_sync_effective_sku(s.sku,s.products,g.sku),
         s.qty,s.updated_by,s.updated_date,s.status
    from public.group_uid_sync_staging s
    left join public.group_uid_details g on g.group_uid_code=s.group_uid_code
   where s.run_id=p_run_id
  on conflict(group_uid_code) do update set
    batch_code=excluded.batch_code,roll_code=excluded.roll_code,warehouse=excluded.warehouse,
    location=excluded.location,sku=excluded.sku,qty=excluded.qty,updated_by=excluded.updated_by,
    updated_date=excluded.updated_date,status=excluded.status
  where excluded.updated_date >= public.group_uid_details.updated_date;

  -- Nguồn không có sản phẩm nào: giữ nguyên các dòng group_uid_products đã biết (không xoá, không thay).
  delete from public.group_uid_products p
   using public.group_uid_sync_staging s, public.group_uid_details g
   where s.run_id=p_run_id and p.group_uid_code=s.group_uid_code
     and jsonb_array_length(s.products)>0
     and g.group_uid_code=s.group_uid_code and s.updated_date>=g.updated_date;
  insert into public.group_uid_products(group_uid_code,sku,qty,product_name)
  select s.group_uid_code,x.sku,x.quantity,x.product_name
    from public.group_uid_sync_staging s
    join public.group_uid_details g using(group_uid_code)
    cross join lateral jsonb_to_recordset(s.products) as x(sku text,quantity numeric,product_name text)
   where s.run_id=p_run_id and jsonb_array_length(s.products)>0 and s.updated_date>=g.updated_date
  on conflict(group_uid_code,sku) do update set qty=excluded.qty,product_name=excluded.product_name;

  select count(*) into v_mismatch
    from public.group_uid_sync_staging s left join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and (g.group_uid_code is null or (s.updated_date>=g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) or
      g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or g.updated_date is distinct from s.updated_date or
      g.status is distinct from s.status or
      (jsonb_array_length(s.products)>0 and
       coalesce((select jsonb_agg(jsonb_build_object('sku',p.sku,'quantity',p.qty,'product_name',p.product_name) order by p.sku)
                   from public.group_uid_products p where p.group_uid_code=s.group_uid_code),'[]'::jsonb) is distinct from s.products))));
  if v_mismatch>0 then raise exception 'VERIFY_FAILED:%',v_mismatch; end if;
  select count(*) into v_total from public.group_uid_details;
  v_verified := v_run.source_count-coalesce((v_run.change_counts->>'issues')::integer,0);
  v_result := jsonb_build_object('verified',v_verified,'databaseCount',v_total,'errors',jsonb_build_array());

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

revoke all on function public.group_uid_sync_preview(uuid) from public, anon, authenticated;
revoke all on function public.group_uid_sync_apply(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_preview(uuid) to service_role;
grant execute on function public.group_uid_sync_apply(uuid) to service_role;

-- Khôi phục SKU đã biết cho UID bị phiên 08/10/2026 11:30 đặt về NULL vì WMS không trả sản phẩm.
-- Lấy before_data.sku của lần thay đổi gần nhất; chỉ đụng UID đang NULL và chưa có dòng group_uid_products.
update public.group_uid_details g
   set sku = c.sku
  from (
    select distinct on (c.group_uid_code) c.group_uid_code, btrim(c.before_data->>'sku') as sku
      from public.group_uid_sync_changes c
     where c.change_type = 'updated'
       and 'sku' = any(c.changed_fields)
       and nullif(btrim(c.before_data->>'sku'), '') is not null
       and jsonb_array_length(coalesce(c.after_data->'products', '[]'::jsonb)) = 0
     order by c.group_uid_code, c.id desc
  ) c
 where g.group_uid_code = c.group_uid_code
   and g.sku is null
   and not exists (select 1 from public.group_uid_products p where p.group_uid_code = g.group_uid_code);

notify pgrst, 'reload schema';
commit;
