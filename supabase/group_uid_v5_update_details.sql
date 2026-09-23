-- Paginated field-level differences for an Admin Group UID import preview.
-- Values are read only from the caller's own staging run.
begin;

create or replace function public.group_uid_import_update_details(
  p_run_id uuid,
  p_search text default null,
  p_offset integer default 0,
  p_limit integer default 25
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_total integer;
  v_items jsonb;
  v_offset integer := greatest(coalesce(p_offset,0),0);
  v_limit integer := least(greatest(coalesce(p_limit,25),1),100);
  v_search text := nullif(btrim(coalesce(p_search,'')),'');
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xem chi tiết cập nhật'));
  end if;
  if not exists(
    select 1 from public.group_uid_import_runs
    where id=p_run_id and created_by=(select auth.uid())
      and status in ('uploading','validated','completed')
  ) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không thấy lượt nạp'));
  end if;

  with changed as (
    select r.*,g.batch_code old_batch_code,g.roll_code old_roll_code,
      g.warehouse old_warehouse,g.location old_location,g.sku old_sku,
      g.qty old_qty,g.updated_by old_updated_by,g.updated_date old_updated_date,
      g.status old_status
    from public.group_uid_import_rows r
    join public.group_uid_details g on g.group_uid_code=r.group_uid_code
    where r.run_id=p_run_id and r.updated_date>=g.updated_date
      and (r.batch_code,r.roll_code,r.warehouse,r.location,r.sku,r.qty,r.updated_by,r.updated_date,r.status)
          is distinct from
          (g.batch_code,g.roll_code,g.warehouse,g.location,g.sku,g.qty,g.updated_by,g.updated_date,g.status)
      and (v_search is null or r.group_uid_code ilike '%'||v_search||'%' or coalesce(r.sku,'') ilike '%'||v_search||'%')
  )
  select count(*) into v_total from changed;

  with changed as (
    select r.*,g.batch_code old_batch_code,g.roll_code old_roll_code,
      g.warehouse old_warehouse,g.location old_location,g.sku old_sku,
      g.qty old_qty,g.updated_by old_updated_by,g.updated_date old_updated_date,
      g.status old_status
    from public.group_uid_import_rows r
    join public.group_uid_details g on g.group_uid_code=r.group_uid_code
    where r.run_id=p_run_id and r.updated_date>=g.updated_date
      and (r.batch_code,r.roll_code,r.warehouse,r.location,r.sku,r.qty,r.updated_by,r.updated_date,r.status)
          is distinct from
          (g.batch_code,g.roll_code,g.warehouse,g.location,g.sku,g.qty,g.updated_by,g.updated_date,g.status)
      and (v_search is null or r.group_uid_code ilike '%'||v_search||'%' or coalesce(r.sku,'') ilike '%'||v_search||'%')
    order by r.group_uid_code
    offset v_offset limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rowNo',c.row_no,
    'groupUidCode',c.group_uid_code,
    'sku',c.sku,
    'changes',(
      select coalesce(jsonb_agg(jsonb_build_object('field',d.field,'oldValue',d.old_value,'newValue',d.new_value) order by d.position),'[]'::jsonb)
      from (values
        (1,'batchCode',to_jsonb(c.old_batch_code),to_jsonb(c.batch_code)),
        (2,'rollCode',to_jsonb(c.old_roll_code),to_jsonb(c.roll_code)),
        (3,'warehouse',to_jsonb(c.old_warehouse),to_jsonb(c.warehouse)),
        (4,'location',to_jsonb(c.old_location),to_jsonb(c.location)),
        (5,'sku',to_jsonb(c.old_sku),to_jsonb(c.sku)),
        (6,'qty',to_jsonb(c.old_qty),to_jsonb(c.qty)),
        (7,'updatedBy',to_jsonb(c.old_updated_by),to_jsonb(c.updated_by)),
        (8,'updatedDate',to_jsonb(c.old_updated_date),to_jsonb(c.updated_date)),
        (9,'status',to_jsonb(c.old_status),to_jsonb(c.status))
      ) d(position,field,old_value,new_value)
      where d.old_value is distinct from d.new_value
    )
  ) order by c.group_uid_code),'[]'::jsonb) into v_items from changed c;

  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'runId',p_run_id,'total',v_total,'offset',v_offset,'limit',v_limit,'items',v_items
  ),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.group_uid_import_update_details(uuid,text,integer,integer) from public, anon;
grant execute on function public.group_uid_import_update_details(uuid,text,integer,integer) to authenticated;

notify pgrst, 'reload schema';
commit;
