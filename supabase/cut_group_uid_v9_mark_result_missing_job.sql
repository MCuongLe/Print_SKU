-- Cho phep cut_group_uid_mark_result(..., 'failed') khi lenh in da bi don khoi print_jobs (11/10/2026).
--
-- Van de: print_jobs_purge xoa lenh qua 3-6 ngay. Neu nguoi dung dong tab truoc khi in xong, cac UID o trang thai 'queued'
-- tro nen mo coi: ham cu coi "khong con lenh" la JOB_NOT_FINISHED nen khong the chuyen sang 'failed', cung khong in lai duoc
-- (man Cat UID chi cho chon pending/failed/printed) va cut_group_uid_admin_delete tu choi. Hang ket vinh vien.
--
-- Doi: lenh khong con trong print_jobs thi cho danh dau 'failed' (de in lai duoc). Van KHONG cho danh dau 'printed' khi
-- khong con lenh vi khong chung minh duoc da in. Cac truong hop con lai giu nguyen.
-- Web (index.html, man Cat UID) goi markResult(id,'failed') khi print_job_status tra NOT_FOUND; chua ap dung ham nay thi
-- web van dung hoi lien tuc va bao nguoi dung, nhung hang van ket 'queued' cho toi khi ham nay duoc ap dung.
begin;

create or replace function public.cut_group_uid_mark_result(p_access_token text,p_job_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer; v_job_status text; v_missing boolean;
begin
  if p_status not in ('printed','failed') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_STATUS','message','Kết quả in không hợp lệ'));
  end if;
  select j.status into v_job_status from public.print_jobs j where j.id=p_job_id;
  v_missing := not found;
  if (v_missing and p_status='printed')
     or (not v_missing and ((p_status='printed' and v_job_status<>'completed') or (p_status='failed' and v_job_status not in ('failed','cancelled')))) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','JOB_NOT_FINISHED','message','Lệnh in chưa có kết quả phù hợp'));
  end if;
  update public.cut_group_uids set print_status=p_status,printed_at=case when p_status='printed' then now() else printed_at end,updated_at=now()
   where print_job_id=p_job_id and print_status='queued';
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id,'status',p_status),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

commit;
notify pgrst,'reload schema';
