-- Admin-only staged XLSX import for Group UID data.
-- The browser never receives service_role: every write RPC verifies auth.uid()
-- against public.user_roles and accepts at most 500 rows per request.
begin;

create table if not exists public.group_uid_import_runs (
  id uuid primary key default gen_random_uuid(),
  file_name text not null check (btrim(file_name) <> ''),
  file_size bigint not null check (file_size between 1 and 10485760),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  expected_rows integer not null check (expected_rows between 1 and 50000),
  uploaded_rows integer not null default 0 check (uploaded_rows >= 0),
  status text not null default 'uploading'
    check (status in ('uploading','validated','applying','completed','failed')),
  counts jsonb not null default '{}'::jsonb,
  error_message text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.group_uid_import_rows (
  run_id uuid not null references public.group_uid_import_runs(id) on delete cascade,
  row_no integer not null check (row_no >= 2),
  group_uid_code text not null check (length(btrim(group_uid_code)) between 1 and 40),
  batch_code text,
  roll_code text,
  warehouse text,
  location text,
  sku text,
  qty numeric not null check (qty >= 0 and qty <> 'NaN'::numeric and qty <> 'Infinity'::numeric),
  updated_by text,
  updated_date timestamptz not null,
  status text not null check (btrim(status) <> ''),
  primary key (run_id, row_no)
);

create index if not exists group_uid_import_runs_created_idx
  on public.group_uid_import_runs (created_at desc);
create index if not exists group_uid_import_rows_code_idx
  on public.group_uid_import_rows (run_id, group_uid_code);

alter table public.group_uid_import_runs enable row level security;
alter table public.group_uid_import_rows enable row level security;
revoke all on public.group_uid_import_runs from public, anon, authenticated;
revoke all on public.group_uid_import_rows from public, anon, authenticated;
grant select, insert, update, delete on public.group_uid_import_runs to service_role;
grant select, insert, update, delete on public.group_uid_import_rows to service_role;

create or replace function public.group_uid_admin_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'admin'
  )
$$;

create or replace function public.group_uid_import_start(
  p_file_name text, p_file_size bigint, p_file_sha256 text, p_expected_rows integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_previous integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp Group UID'));
  end if;
  if nullif(btrim(p_file_name),'') is null or length(p_file_name) > 240
     or p_file_size not between 1 and 10485760
     or p_file_sha256 !~ '^[0-9a-f]{64}$'
     or p_expected_rows not between 1 and 50000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_FILE','message','File không hợp lệ hoặc vượt giới hạn 10 MB / 50.000 dòng'));
  end if;
  delete from public.group_uid_import_rows r using public.group_uid_import_runs h
   where r.run_id=h.id and h.status in ('completed','failed') and h.created_at < now()-interval '7 days';
  select count(*) into v_previous from public.group_uid_import_runs
   where file_sha256=lower(p_file_sha256) and status='completed';
  insert into public.group_uid_import_runs(file_name,file_size,file_sha256,expected_rows,created_by)
  values(btrim(p_file_name),p_file_size,lower(p_file_sha256),p_expected_rows,(select auth.uid()))
  returning id into v_id;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('runId',v_id,'status','uploading','previousImports',v_previous),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

create or replace function public.group_uid_import_chunk(p_run_id uuid,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer; v_uploaded integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp Group UID'));
  end if;
  if not exists(select 1 from public.group_uid_import_runs where id=p_run_id and created_by=(select auth.uid()) and status='uploading') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','RUN_NOT_OPEN','message','Lượt nạp không tồn tại hoặc đã đóng'));
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_CHUNK','message','Mỗi lô cần từ 1 đến 500 dòng'));
  end if;
  select count(*) into v_count
  from jsonb_to_recordset(p_rows) as x(
    row_no integer,group_uid_code text,batch_code text,roll_code text,warehouse text,
    location text,sku text,qty numeric,updated_by text,updated_date timestamptz,status text
  )
  where row_no < 2 or nullif(btrim(group_uid_code),'') is null or length(btrim(group_uid_code)) > 40
     or qty is null or qty < 0 or qty='NaN'::numeric or qty='Infinity'::numeric
     or updated_date is null or nullif(btrim(status),'') is null;
  if v_count > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Lô có dòng thiếu hoặc sai dữ liệu'));
  end if;
  insert into public.group_uid_import_rows(
    run_id,row_no,group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status
  )
  select p_run_id,row_no,btrim(group_uid_code),nullif(btrim(batch_code),''),nullif(btrim(roll_code),''),
         nullif(btrim(warehouse),''),nullif(btrim(location),''),nullif(btrim(sku),''),qty,
         nullif(btrim(updated_by),''),updated_date,btrim(status)
  from jsonb_to_recordset(p_rows) as x(
    row_no integer,group_uid_code text,batch_code text,roll_code text,warehouse text,
    location text,sku text,qty numeric,updated_by text,updated_date timestamptz,status text
  )
  on conflict(run_id,row_no) do update set
    group_uid_code=excluded.group_uid_code,batch_code=excluded.batch_code,roll_code=excluded.roll_code,
    warehouse=excluded.warehouse,location=excluded.location,sku=excluded.sku,qty=excluded.qty,
    updated_by=excluded.updated_by,updated_date=excluded.updated_date,status=excluded.status;
  select count(*) into v_uploaded from public.group_uid_import_rows where run_id=p_run_id;
  update public.group_uid_import_runs set uploaded_rows=v_uploaded where id=p_run_id;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('runId',p_run_id,'uploadedRows',v_uploaded),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
exception when others then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','CHUNK_ERROR','message',left(sqlerrm,300)));
end $$;

create or replace function public.group_uid_import_validate(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_import_runs; v_duplicates integer; v_blank_sku integer;
  v_unknown_sku integer; v_new integer; v_updated integer; v_unchanged integer; v_stale integer;
  v_duplicate_rows jsonb; v_counts jsonb;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp Group UID'));
  end if;
  select * into v_run from public.group_uid_import_runs
   where id=p_run_id and created_by=(select auth.uid()) and status in ('uploading','validated') for update;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','RUN_NOT_OPEN','message','Lượt nạp không tồn tại hoặc đã đóng'));
  end if;
  select coalesce(sum(n-1),0),coalesce(jsonb_agg(jsonb_build_object('groupUidCode',group_uid_code,'count',n)) filter(where n>1),'[]'::jsonb)
    into v_duplicates,v_duplicate_rows
  from (select group_uid_code,count(*) n from public.group_uid_import_rows where run_id=p_run_id group by group_uid_code having count(*)>1 order by group_uid_code limit 50) d;
  select count(*) filter(where nullif(btrim(r.sku),'') is null),
         count(*) filter(where nullif(btrim(r.sku),'') is not null and s.sku is null),
         count(*) filter(where g.group_uid_code is null),
         count(*) filter(where g.group_uid_code is not null and r.updated_date>=g.updated_date and
           (r.batch_code,r.roll_code,r.warehouse,r.location,r.sku,r.qty,r.updated_by,r.updated_date,r.status)
           is distinct from (g.batch_code,g.roll_code,g.warehouse,g.location,g.sku,g.qty,g.updated_by,g.updated_date,g.status)),
         count(*) filter(where g.group_uid_code is not null and r.updated_date>=g.updated_date and
           (r.batch_code,r.roll_code,r.warehouse,r.location,r.sku,r.qty,r.updated_by,r.updated_date,r.status)
           is not distinct from (g.batch_code,g.roll_code,g.warehouse,g.location,g.sku,g.qty,g.updated_by,g.updated_date,g.status)),
         count(*) filter(where g.group_uid_code is not null and r.updated_date<g.updated_date)
    into v_blank_sku,v_unknown_sku,v_new,v_updated,v_unchanged,v_stale
  from public.group_uid_import_rows r
  left join public.group_uid_details g on g.group_uid_code=r.group_uid_code
  left join public."SKU_Name" s on s.sku=r.sku
  where r.run_id=p_run_id;
  v_counts := jsonb_build_object('totalRows',v_run.uploaded_rows,'newRows',v_new,'updatedRows',v_updated,
    'unchangedRows',v_unchanged,'staleRows',v_stale,'blankSkuRows',v_blank_sku,
    'unknownSkuRows',v_unknown_sku,'duplicateRows',v_duplicates);
  if v_run.uploaded_rows<>v_run.expected_rows or v_duplicates>0 then
    update public.group_uid_import_runs set counts=v_counts,error_message=case
      when v_run.uploaded_rows<>v_run.expected_rows then 'Số dòng tải lên không khớp file'
      else 'Group UID bị trùng trong file' end where id=p_run_id;
    return jsonb_build_object('ok',false,'data',v_counts||jsonb_build_object('duplicateCodes',v_duplicate_rows),
      'error',jsonb_build_object('code','VALIDATION_FAILED','message',case
        when v_run.uploaded_rows<>v_run.expected_rows then 'Số dòng tải lên không khớp file'
        else 'Group UID bị trùng trong file' end));
  end if;
  update public.group_uid_import_runs set status='validated',counts=v_counts,error_message=null,validated_at=now() where id=p_run_id;
  return jsonb_build_object('ok',true,'data',v_counts||jsonb_build_object('runId',p_run_id,'status','validated'),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

create or replace function public.group_uid_import_commit(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.group_uid_import_runs; v_written integer; v_counts jsonb;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp Group UID'));
  end if;
  perform pg_advisory_xact_lock(hashtext('public.group_uid_import')::bigint);
  select * into v_run from public.group_uid_import_runs where id=p_run_id and created_by=(select auth.uid()) for update;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không thấy lượt nạp'));
  end if;
  if v_run.status='completed' then
    return jsonb_build_object('ok',true,'data',v_run.counts||jsonb_build_object('runId',p_run_id,'status','completed','alreadyCompleted',true));
  end if;
  if v_run.status<>'validated' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_VALIDATED','message','Cần kiểm tra file trước khi áp dụng'));
  end if;
  if (select count(*) from public.group_uid_import_rows where run_id=p_run_id)<>v_run.expected_rows
     or exists(select 1 from public.group_uid_import_rows where run_id=p_run_id group by group_uid_code having count(*)>1) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','DATA_CHANGED','message','Dữ liệu tạm đã thay đổi; hãy kiểm tra lại'));
  end if;
  update public.group_uid_import_runs set status='applying' where id=p_run_id;
  begin
    with written as (
      insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status)
      select group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status
      from public.group_uid_import_rows where run_id=p_run_id
      on conflict(group_uid_code) do update set
        batch_code=excluded.batch_code,roll_code=excluded.roll_code,warehouse=excluded.warehouse,
        location=excluded.location,sku=excluded.sku,qty=excluded.qty,updated_by=excluded.updated_by,
        updated_date=excluded.updated_date,status=excluded.status
      where excluded.updated_date>=group_uid_details.updated_date
      returning 1
    ) select count(*) into v_written from written;
    v_counts := v_run.counts||jsonb_build_object('writtenRows',v_written);
    update public.group_uid_import_runs set status='completed',counts=v_counts,completed_at=now(),error_message=null where id=p_run_id;
    return jsonb_build_object('ok',true,'data',v_counts||jsonb_build_object('runId',p_run_id,'status','completed'),
      'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  exception when others then
    update public.group_uid_import_runs set status='failed',error_message=left(sqlerrm,500),completed_at=now() where id=p_run_id;
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','COMMIT_FAILED','message',left(sqlerrm,300)));
  end;
end $$;

create or replace function public.group_uid_import_history(p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xem lịch sử nạp'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('runs',coalesce((
    select jsonb_agg(jsonb_build_object('id',h.id,'fileName',h.file_name,'fileSize',h.file_size,
      'fileSha256',h.file_sha256,'expectedRows',h.expected_rows,'uploadedRows',h.uploaded_rows,'status',h.status,'counts',h.counts,
      'errorMessage',h.error_message,'createdAt',h.created_at,'completedAt',h.completed_at,'username',u.username)
      order by h.created_at desc)
    from (select * from public.group_uid_import_runs order by created_at desc limit least(greatest(coalesce(p_limit,10),1),50)) h
    left join public.user_roles u on u.user_id=h.created_by
  ),'[]'::jsonb)),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.group_uid_admin_allowed() from public, anon, authenticated;
revoke all on function public.group_uid_import_start(text,bigint,text,integer) from public, anon;
revoke all on function public.group_uid_import_chunk(uuid,jsonb) from public, anon;
revoke all on function public.group_uid_import_validate(uuid) from public, anon;
revoke all on function public.group_uid_import_commit(uuid) from public, anon;
revoke all on function public.group_uid_import_history(integer) from public, anon;
grant execute on function public.group_uid_import_start(text,bigint,text,integer) to authenticated;
grant execute on function public.group_uid_import_chunk(uuid,jsonb) to authenticated;
grant execute on function public.group_uid_import_validate(uuid) to authenticated;
grant execute on function public.group_uid_import_commit(uuid) to authenticated;
grant execute on function public.group_uid_import_history(integer) to authenticated;

notify pgrst, 'reload schema';
commit;
