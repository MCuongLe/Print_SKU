-- Lưu vết Group UID đã cắt và danh sách tem chờ in.
-- Web chỉ đọc/ghi qua RPC security definer, cùng mô hình quyền với màn Sample.

create table if not exists public.cut_group_uids (
  group_uid_code text primary key check (length(btrim(group_uid_code)) between 1 and 40),
  sku text not null check (length(btrim(sku)) between 1 and 40),
  product_name text not null check (btrim(product_name) <> ''),
  lot text not null default '',
  roll text not null default '',
  print_status text not null default 'pending' check (print_status in ('pending','queued','printed','failed')),
  print_job_id uuid,
  cut_at timestamptz not null default now(),
  queued_at timestamptz,
  printed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists cut_group_uids_sku_cut_idx on public.cut_group_uids (sku,cut_at desc);
create index if not exists cut_group_uids_status_cut_idx on public.cut_group_uids (print_status,cut_at);
alter table public.cut_group_uids enable row level security;
revoke all on public.cut_group_uids from public,anon,authenticated;
grant select,insert,update,delete on public.cut_group_uids to service_role;

create or replace function public.cut_group_uid_scan(p_access_token text,p_group_uid text)
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
         btrim(coalesce(g.batch_code,'')) lot,btrim(coalesce(g.roll_code,'')) roll
    into v_source
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku=g.sku
   where g.group_uid_code=v_code;
  if not found or v_source.sku='' or v_source.product_name='' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','Group UID chưa có đủ dữ liệu. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  insert into public.cut_group_uids(group_uid_code,sku,product_name,lot,roll)
  values(v_source.group_uid_code,v_source.sku,v_source.product_name,left(v_source.lot,20),left(v_source.roll,20))
  on conflict (group_uid_code) do nothing
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_CUT','message','Group UID này vừa được cắt trên thiết bị khác'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'productName',v_row.product_name,
    'lot',v_row.lot,'roll',v_row.roll,'printStatus',v_row.print_status,'cutAt',v_row.cut_at),
    'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end$$;

create or replace function public.cut_group_uid_list(p_access_token text,p_status text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_status text := nullif(btrim(coalesce(p_status,'')),'');
begin
  if v_status is not null and v_status not in ('pending','queued','printed','failed','open') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_STATUS','message','Trạng thái không hợp lệ'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'groupUid',c.group_uid_code,'sku',c.sku,'productName',c.product_name,'lot',c.lot,'roll',c.roll,
      'printStatus',c.print_status,'printJobId',c.print_job_id,'cutAt',c.cut_at,'updatedAt',c.updated_at
    ) order by c.cut_at)
    from public.cut_group_uids c
    where v_status is null or c.print_status=v_status or (v_status='open' and c.print_status in ('pending','queued','failed'))),'[]'::jsonb)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.cut_group_uid_remove(p_access_token text,p_group_uid text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.cut_group_uids;
begin
  delete from public.cut_group_uids where group_uid_code=nullif(btrim(p_group_uid),'') and print_status in ('pending','failed') returning * into v_row;
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_REMOVABLE','message','Chỉ xóa được tem đang chờ in hoặc in lỗi')); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('groupUid',v_row.group_uid_code),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.cut_group_uid_mark_queued(p_access_token text,p_codes text[],p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_job_id is null or coalesce(cardinality(p_codes),0) not between 1 and 100 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_PRINT_JOB','message','Lệnh in không hợp lệ'));
  end if;
  select count(*) into v_count from public.cut_group_uids where group_uid_code=any(p_codes) and print_status in ('pending','failed');
  if v_count<>cardinality(p_codes) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','QUEUE_CONFLICT','message','Danh sách chờ in vừa thay đổi. Hãy tải lại.'));
  end if;
  update public.cut_group_uids set print_status='queued',print_job_id=p_job_id,queued_at=now(),updated_at=now()
   where group_uid_code=any(p_codes) and print_status in ('pending','failed');
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.cut_group_uid_mark_result(p_access_token text,p_job_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer; v_job_status text;
begin
  if p_status not in ('printed','failed') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_STATUS','message','Kết quả in không hợp lệ'));
  end if;
  select j.status into v_job_status from public.print_jobs j where j.id=p_job_id;
  if not found or (p_status='printed' and v_job_status<>'completed') or (p_status='failed' and v_job_status not in ('failed','cancelled')) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','JOB_NOT_FINISHED','message','Lệnh in chưa có kết quả phù hợp'));
  end if;
  update public.cut_group_uids set print_status=p_status,printed_at=case when p_status='printed' then now() else printed_at end,updated_at=now()
   where print_job_id=p_job_id and print_status='queued';
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id,'status',p_status),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

create or replace function public.cut_group_uid_search(p_access_token text,p_sku text default '',p_limit integer default 5000)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
      'printStatus',q.print_status,'cutAt',q.cut_at,'printedAt',q.printed_at
    ) order by q.cut_at desc) from (
      select * from public.cut_group_uids c where v_sku='' or c.sku ilike '%'||v_sku||'%' order by c.cut_at desc limit v_limit
    ) q),'[]'::jsonb),
    'filterSku',v_sku,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.cut_group_uid_scan(text,text) from public;
revoke all on function public.cut_group_uid_list(text,text) from public;
revoke all on function public.cut_group_uid_remove(text,text) from public;
revoke all on function public.cut_group_uid_mark_queued(text,text[],uuid) from public;
revoke all on function public.cut_group_uid_mark_result(text,uuid,text) from public;
revoke all on function public.cut_group_uid_search(text,text,integer) from public;
grant execute on function public.cut_group_uid_scan(text,text) to anon,authenticated;
grant execute on function public.cut_group_uid_list(text,text) to anon,authenticated;
grant execute on function public.cut_group_uid_remove(text,text) to anon,authenticated;
grant execute on function public.cut_group_uid_mark_queued(text,text[],uuid) to anon,authenticated;
grant execute on function public.cut_group_uid_mark_result(text,uuid,text) to anon,authenticated;
grant execute on function public.cut_group_uid_search(text,text,integer) to anon,authenticated;
notify pgrst,'reload schema';
