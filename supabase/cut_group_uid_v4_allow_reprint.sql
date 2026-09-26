-- Cho phep chon IN LAI cac UID da "Da in" (vd tem hu/mat can in lai) - truoc
-- gio chi cho gui vao hang doi khi dang o trang thai pending/failed. Khong doi
-- chu ky ham nen dung create or replace binh thuong, khong can drop.
begin;

create or replace function public.cut_group_uid_mark_queued(p_access_token text,p_codes text[],p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_job_id is null or coalesce(cardinality(p_codes),0) not between 1 and 100 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_PRINT_JOB','message','Lệnh in không hợp lệ'));
  end if;
  select count(*) into v_count from public.cut_group_uids where group_uid_code=any(p_codes) and print_status in ('pending','failed','printed');
  if v_count<>cardinality(p_codes) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','QUEUE_CONFLICT','message','Danh sách chờ in vừa thay đổi. Hãy tải lại.'));
  end if;
  update public.cut_group_uids set print_status='queued',print_job_id=p_job_id,queued_at=now(),updated_at=now()
   where group_uid_code=any(p_codes) and print_status in ('pending','failed','printed');
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

commit;
notify pgrst,'reload schema';
