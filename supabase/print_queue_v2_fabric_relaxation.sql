-- Fabric Relaxation: giữ nguyên API, lease và quyền của hàng đợi hiện có.
-- Agent cũ không claim loại tem mới; cập nhật agent để quảng bá capability mới.
begin;
alter table public.print_jobs drop constraint if exists print_jobs_type_check;
alter table public.print_jobs add constraint print_jobs_type_check
  check (type in ('sku','group_uid','fabric_relaxation'));

create or replace function public.print_enqueue(p_access_token text,p_nonce text,p_type text,p_template_version integer,p_payload jsonb,p_copies integer,p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean;
begin
  if p_type not in ('sku','group_uid','fabric_relaxation') or p_copies not between 1 and 500 or nullif(trim(p_nonce),'') is null then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Dữ liệu lệnh in không hợp lệ')); end if;
  if p_type = 'fabric_relaxation' and (p_template_version is distinct from 1 or
    jsonb_typeof(p_payload->'itemCode') is distinct from 'string' or
    coalesce(p_payload->>'itemCode','') !~ '^[0-9A-Za-z._-]{1,40}$') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mã hàng không hợp lệ'));
  end if;
  select exists(select 1 from public.print_jobs where nonce=p_nonce) into v_duplicate;
  insert into public.print_jobs(nonce,type,template_version,payload,copies,requested_by)
  values(p_nonce,p_type,greatest(coalesce(p_template_version,1),1),coalesce(p_payload,'{}'::jsonb),p_copies,left(coalesce(p_requested_by,''),100))
  on conflict(nonce) do update set updated_at=public.print_jobs.updated_at returning * into v_job;
  if not v_duplicate then insert into public.print_events(job_id,event_type,details) values(v_job.id,'queued',jsonb_build_object('copies',v_job.copies,'type',v_job.type)); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

create or replace function public.print_agent_claim(p_agent_id text,p_agent_token text,p_state jsonb,p_lease_ms integer default 120000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_cap text[];
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb))),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;
  update public.print_jobs set status='queued',agent_id=null,lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent trước không hoàn tất trong thời hạn lease' where status in ('claimed','rendering','sending','spooling') and lease_expires_at<now();
  if coalesce(p_state#>>'{printer,blocked}','false')='true' then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  select * into v_job from public.print_jobs where status='queued' and ((type='sku' and 'sku:v1'=any(v_cap)) or(type='group_uid' and 'group_uid:v1'=any(v_cap)) or(type='fabric_relaxation' and 'fabric_relaxation:v1'=any(v_cap))) order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  update public.print_jobs set status='claimed',agent_id=p_agent_id,attempt_count=attempt_count+1,claimed_at=coalesce(claimed_at,now()),lease_expires_at=now()+(least(greatest(p_lease_ms,30000),900000)||' milliseconds')::interval,updated_at=now() where id=v_job.id returning * into v_job;
  insert into public.print_events(job_id,agent_id,event_type,details) values(v_job.id,p_agent_id,'claimed',jsonb_build_object('attempt',v_job.attempt_count));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object('id',v_job.id::text,'nonce',v_job.nonce,'type',v_job.type,'templateVersion',v_job.template_version,'copies',v_job.copies,'requestedBy',v_job.requested_by,'payload',v_job.payload)),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

commit;
