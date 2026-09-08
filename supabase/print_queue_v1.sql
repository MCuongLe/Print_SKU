-- Hàng đợi độc lập cho ứng dụng Print SKU / Group UID.
-- Chạy một lần trong Supabase SQL Editor. Không đặt token thật trong file này.
create extension if not exists pgcrypto;

create table if not exists public.print_access_keys (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  token_hash text not null unique, enabled boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.print_agents (
  id text primary key, name text not null, token_hash text not null unique,
  enabled boolean not null default true, capabilities text[] not null default '{}',
  state jsonb not null default '{}'::jsonb, last_seen_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.print_jobs (
  id uuid primary key default gen_random_uuid(), nonce text not null unique,
  type text not null check(type in ('sku','group_uid')),
  template_version integer not null default 1 check(template_version>0),
  payload jsonb not null, copies integer not null check(copies between 1 and 500),
  requested_by text not null default '',
  status text not null default 'queued' check(status in ('queued','claimed','rendering','sending','spooling','completed','failed','cancelled')),
  agent_id text references public.print_agents(id), attempt_count integer not null default 0,
  lease_expires_at timestamptz, error_code text, error_message text, result jsonb,
  created_at timestamptz not null default now(), claimed_at timestamptz,
  completed_at timestamptz, updated_at timestamptz not null default now()
);
create index if not exists print_jobs_queue_idx on public.print_jobs(status,created_at);
create index if not exists print_jobs_agent_idx on public.print_jobs(agent_id,status);
create table if not exists public.print_events (
  id bigint generated always as identity primary key,
  job_id uuid references public.print_jobs(id) on delete cascade,
  agent_id text, event_type text not null, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists print_events_job_idx on public.print_events(job_id,created_at);

alter table public.print_access_keys enable row level security;
alter table public.print_agents enable row level security;
alter table public.print_jobs enable row level security;
alter table public.print_events enable row level security;
revoke all on public.print_access_keys,public.print_agents,public.print_jobs,public.print_events from anon,authenticated;
revoke all on sequence public.print_events_id_seq from anon,authenticated;

create or replace function public.print_token_hash(p_token text)
returns text language sql immutable strict set search_path=''
as $$select encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex')$$;
revoke all on function public.print_token_hash(text) from public,anon,authenticated;

create or replace function public.print_agent_allowed(p_agent_id text,p_token text)
returns boolean language sql stable security definer set search_path=''
as $$select exists(select 1 from public.print_agents where id=p_agent_id and enabled and token_hash=public.print_token_hash(p_token))$$;
revoke all on function public.print_agent_allowed(text,text) from public,anon,authenticated;

create or replace function public.print_access_allowed(p_token text)
returns boolean language sql stable security definer set search_path=''
as $$select exists(select 1 from public.print_access_keys where enabled and token_hash=public.print_token_hash(p_token))$$;
revoke all on function public.print_access_allowed(text) from public,anon,authenticated;

create or replace function public.print_enqueue(p_access_token text,p_nonce text,p_type text,p_template_version integer,p_payload jsonb,p_copies integer,p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean;
begin
  if p_type not in ('sku','group_uid') or p_copies not between 1 and 500 or nullif(trim(p_nonce),'') is null then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Dữ liệu lệnh in không hợp lệ')); end if;
  select exists(select 1 from public.print_jobs where nonce=p_nonce) into v_duplicate;
  insert into public.print_jobs(nonce,type,template_version,payload,copies,requested_by)
  values(p_nonce,p_type,greatest(coalesce(p_template_version,1),1),coalesce(p_payload,'{}'::jsonb),p_copies,left(coalesce(p_requested_by,''),100))
  on conflict(nonce) do update set updated_at=public.print_jobs.updated_at returning * into v_job;
  if not v_duplicate then insert into public.print_events(job_id,event_type,details) values(v_job.id,'queued',jsonb_build_object('copies',v_job.copies,'type',v_job.type)); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

create or replace function public.print_job_status(p_access_token text,p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs;
begin
  select * into v_job from public.print_jobs where id=p_job_id;
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không tìm thấy lệnh in')); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'type',v_job.type,'copies',v_job.copies,'status',v_job.status,'agentId',v_job.agent_id,'attemptCount',v_job.attempt_count,'errorCode',v_job.error_code,'errorMessage',v_job.error_message,'result',v_job.result,'createdAt',v_job.created_at,'updatedAt',v_job.updated_at,'completedAt',v_job.completed_at),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

create or replace function public.print_queue_status(p_access_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'queued',(select count(*) from public.print_jobs where status='queued'),
    'queuedCopies',(select coalesce(sum(copies),0) from public.print_jobs where status='queued'),
    'active',(select count(*) from public.print_jobs where status in ('claimed','rendering','sending','spooling')),
    'agents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'capabilities',capabilities,'state',state,'lastSeenAt',last_seen_at)) from public.print_agents where enabled),'[]'::jsonb)
  ),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.print_agent_claim(p_agent_id text,p_agent_token text,p_state jsonb,p_lease_ms integer default 120000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_cap text[];
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb))),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;
  update public.print_jobs set status='queued',agent_id=null,lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent trước không hoàn tất trong thời hạn lease' where status in ('claimed','rendering','sending','spooling') and lease_expires_at<now();
  if coalesce(p_state#>>'{printer,blocked}','false')='true' then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  select * into v_job from public.print_jobs where status='queued' and ((type='sku' and 'sku:v1'=any(v_cap)) or(type='group_uid' and 'group_uid:v1'=any(v_cap))) order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  update public.print_jobs set status='claimed',agent_id=p_agent_id,attempt_count=attempt_count+1,claimed_at=coalesce(claimed_at,now()),lease_expires_at=now()+(least(greatest(p_lease_ms,30000),900000)||' milliseconds')::interval,updated_at=now() where id=v_job.id returning * into v_job;
  insert into public.print_events(job_id,agent_id,event_type,details) values(v_job.id,p_agent_id,'claimed',jsonb_build_object('attempt',v_job.attempt_count));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object('id',v_job.id::text,'nonce',v_job.nonce,'type',v_job.type,'templateVersion',v_job.template_version,'copies',v_job.copies,'requestedBy',v_job.requested_by,'payload',v_job.payload)),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

create or replace function public.print_agent_progress(p_agent_id text,p_agent_token text,p_job_id uuid,p_stage text,p_details jsonb default '{}'::jsonb,p_lease_ms integer default 120000)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  if p_stage not in ('rendering','sending','spooling') then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_STAGE','message','Trạng thái không hợp lệ')); end if;
  update public.print_jobs set status=p_stage,lease_expires_at=now()+(least(greatest(p_lease_ms,30000),900000)||' milliseconds')::interval,updated_at=now() where id=p_job_id and agent_id=p_agent_id and status in ('claimed','rendering','sending','spooling');
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','LEASE_LOST','message','Agent không còn giữ lệnh này')); end if;
  insert into public.print_events(job_id,agent_id,event_type,details) values(p_job_id,p_agent_id,p_stage,coalesce(p_details,'{}'::jsonb));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('status',p_stage),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.print_agent_complete(p_agent_id text,p_agent_token text,p_job_id uuid,p_result jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_jobs set status='completed',result=coalesce(p_result,'{}'::jsonb),lease_expires_at=null,completed_at=now(),updated_at=now(),error_code=null,error_message=null where id=p_job_id and agent_id=p_agent_id and status in ('claimed','rendering','sending','spooling');
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','LEASE_LOST','message','Không thể hoàn tất lệnh')); end if;
  insert into public.print_events(job_id,agent_id,event_type,details) values(p_job_id,p_agent_id,'completed',coalesce(p_result,'{}'::jsonb));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('status','completed'),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.print_agent_fail(p_agent_id text,p_agent_token text,p_job_id uuid,p_error jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_jobs set status='failed',error_code=left(coalesce(p_error->>'code','PRINT_FAILED'),80),error_message=left(coalesce(p_error->>'message','Không rõ lỗi'),500),lease_expires_at=null,updated_at=now() where id=p_job_id and agent_id=p_agent_id and status in ('claimed','rendering','sending','spooling');
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','LEASE_LOST','message','Không thể ghi lỗi cho lệnh')); end if;
  insert into public.print_events(job_id,agent_id,event_type,details) values(p_job_id,p_agent_id,'failed',coalesce(p_error,'{}'::jsonb));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('status','failed'),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.print_agent_requeue(p_agent_id text,p_agent_token text,p_job_id uuid,p_reason jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_jobs set status='queued',agent_id=null,lease_expires_at=null,error_code=left(coalesce(p_reason->>'code','PRINTER_BLOCKED'),80),error_message=left(coalesce(p_reason->>'message','Máy in chưa sẵn sàng'),500),updated_at=now() where id=p_job_id and agent_id=p_agent_id and status in ('claimed','rendering','sending','spooling');
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','LEASE_LOST','message','Không thể trả lệnh về hàng đợi')); end if;
  insert into public.print_events(job_id,agent_id,event_type,details) values(p_job_id,p_agent_id,'requeued',coalesce(p_reason,'{}'::jsonb));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('status','queued'),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.print_enqueue(text,text,text,integer,jsonb,integer,text) from public;
revoke all on function public.print_job_status(text,uuid) from public;
revoke all on function public.print_queue_status(text) from public;
revoke all on function public.print_agent_claim(text,text,jsonb,integer) from public;
revoke all on function public.print_agent_progress(text,text,uuid,text,jsonb,integer) from public;
revoke all on function public.print_agent_complete(text,text,uuid,jsonb) from public;
revoke all on function public.print_agent_fail(text,text,uuid,jsonb) from public;
revoke all on function public.print_agent_requeue(text,text,uuid,jsonb) from public;
grant execute on function public.print_enqueue(text,text,text,integer,jsonb,integer,text) to anon,authenticated;
grant execute on function public.print_job_status(text,uuid) to anon,authenticated;
grant execute on function public.print_queue_status(text) to anon,authenticated;
grant execute on function public.print_agent_claim(text,text,jsonb,integer) to anon,authenticated;
grant execute on function public.print_agent_progress(text,text,uuid,text,jsonb,integer) to anon,authenticated;
grant execute on function public.print_agent_complete(text,text,uuid,jsonb) to anon,authenticated;
grant execute on function public.print_agent_fail(text,text,uuid,jsonb) to anon,authenticated;
grant execute on function public.print_agent_requeue(text,text,uuid,jsonb) to anon,authenticated;
