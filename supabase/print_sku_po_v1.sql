-- Tem Phụ liệu có PO + ngày nhận (22/10/2026): tem SKU phiên bản 2 (templateVersion 2) in từ KIỂM TRA ĐẦU VÀO.
-- Chỉ thay print_agent_claim (bản trước: warehouse_location_v1.sql): thêm nhánh (sku, template_version 2) cho agent khai
-- capability 'sku:v2' (agent 0.10.1+). Agent cũ không khai 'sku:v2' nên lệnh v2 nằm chờ trong hàng đợi (thấy được ở màn Lệnh in)
-- thay vì bị in thiếu PO/ngày nhận. print_enqueue_unchecked không đổi: đã giữ nguyên mọi trường của item (po, receivedDate)
-- và template_version web gửi; agent kiểm mẫu PO/ngày (sai thì từ chối cả lệnh).
-- Chạy: python scripts/apply_supabase_sql.py supabase/print_sku_po_v1.sql
begin;

create or replace function public.print_agent_claim(p_agent_id text,p_agent_token text,p_state jsonb,p_lease_ms integer default 120000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_cap text[];
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb))),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;
  update public.print_jobs set status='queued',agent_id=null,lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent trước không hoàn tất trong thời hạn lease' where status in ('claimed','rendering','sending','spooling') and lease_expires_at<now();
  if coalesce(p_state#>>'{printer,blocked}','false')='true' then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  select * into v_job from public.print_jobs where status='queued' and (
    (type='sku' and template_version=1 and 'sku:v1'=any(v_cap)) or
    (type='sku' and template_version=2 and 'sku:v2'=any(v_cap)) or
    (type='group_uid' and template_version=1 and 'group_uid:v1'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=1 and 'fabric_relaxation:v1'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=2 and 'fabric_relaxation:v2'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=3 and 'fabric_relaxation:v3'=any(v_cap)) or
    (type='location' and template_version=1 and 'location:v1'=any(v_cap))
  ) order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  update public.print_jobs set status='claimed',agent_id=p_agent_id,attempt_count=attempt_count+1,claimed_at=coalesce(claimed_at,now()),lease_expires_at=now()+(least(greatest(p_lease_ms,30000),900000)||' milliseconds')::interval,updated_at=now() where id=v_job.id returning * into v_job;
  insert into public.print_events(job_id,agent_id,event_type,details) values(v_job.id,p_agent_id,'claimed',jsonb_build_object('attempt',v_job.attempt_count));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object('id',v_job.id::text,'nonce',v_job.nonce,'type',v_job.type,'templateVersion',v_job.template_version,'copies',v_job.copies,'requestedBy',v_job.requested_by,'payload',v_job.payload)),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;


commit;

notify pgrst, 'reload schema';
