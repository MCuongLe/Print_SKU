-- Group UID sync v4 (10/10/2026): không coi "chỉ đổi updated_date" là một thay đổi.
--
-- Ngày 10/10/2026 14:14 WMS lưu lại hàng loạt 18.264 Group UID (cùng giây 07:14:31 UTC, 43 người dùng khác nhau,
-- kể cả UID đã Closed từ tháng 5). Lượt đồng bộ gia tăng 14:31 xếp 18.294 dòng vào "updated" và ghi ảnh trước/sau
-- (923 byte/dòng) → bảng group_uid_sync_changes từ 4,3 MB lên 23 MB trong một lượt, dashboard báo "18.294 cập nhật"
-- trong khi 18.298 dòng chỉ khác đúng trường updated_date. Chuyện tương tự đã xảy ra 25/03/2026 (3.744 dòng).
--
-- Sửa: preview chỉ ghi 'updated' khi có ít nhất một trường nghiệp vụ đổi (batch, roll, kho, vị trí, SKU, qty,
-- người cập nhật, trạng thái). Dòng chỉ đổi mốc thời gian được đếm là "unchanged". apply không đổi: vẫn nạp từ
-- staging nên mốc updated_date trên group_uid_details vẫn được nâng lên, lượt sau không thấy lại các dòng này.
-- updated_date vẫn nằm trong changed_fields khi đi kèm thay đổi khác.
--
-- Cuối file: dọn một lần các dòng 'updated' chỉ có changed_fields = {updated_date} đã ghi trước đó (ảnh trước và sau
-- giống hệt nhau ngoài mốc) và tính lại change_counts của các lượt bị ảnh hưởng để dashboard khớp với dữ liệu còn lại.
begin;

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

  -- v4: chỉ đổi updated_date thì không phải thay đổi; apply vẫn nâng mốc từ staging.
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
      g.updated_by is distinct from s.updated_by or
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

revoke all on function public.group_uid_sync_preview(uuid) from public, anon, authenticated;
grant execute on function public.group_uid_sync_preview(uuid) to service_role;

-- Dọn một lần: dòng 'updated' chỉ đổi mốc thời gian của các lượt đã kết thúc, rồi tính lại change_counts.
create temp table touched_runs on commit drop as
  select distinct c.run_id
    from public.group_uid_sync_changes c join public.group_uid_sync_runs r on r.id = c.run_id
   where c.change_type = 'updated' and c.changed_fields = array['updated_date']
     and r.status in ('completed', 'failed', 'expired');

delete from public.group_uid_sync_changes c
 using touched_runs t
 where c.run_id = t.run_id and c.change_type = 'updated' and c.changed_fields = array['updated_date'];

update public.group_uid_sync_runs r
   set change_counts = r.change_counts
     || jsonb_build_object(
          'updated', x.updated,
          'unchanged', greatest(r.source_count - x.added - x.updated - x.issues, 0),
          'totalChanges', x.added + x.updated,
          'touchOnlyRemoved', (r.change_counts->>'updated')::integer - x.updated)
  from touched_runs t
  cross join lateral (
    select count(*) filter (where c.change_type = 'added') added,
           count(*) filter (where c.change_type = 'updated') updated,
           count(*) filter (where c.change_type = 'stale_source') issues
      from public.group_uid_sync_changes c where c.run_id = t.run_id) x
 where r.id = t.run_id;

commit;
