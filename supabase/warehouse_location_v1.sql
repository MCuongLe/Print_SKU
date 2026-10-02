-- Danh mục mã vị trí kho + tem QR vị trí (màn MÃ VỊ TRÍ, #location).
--
-- Web chỉ đọc/ghi qua RPC security definer (cùng mô hình quyền với Cắt Group UID / Sample);
-- bảng bật RLS, anon không đọc/ghi trực tiếp. Không có đường XOÁ CỨNG từ web (bài học
-- cut_group_uid_v2_lock_delete.sql): "Xoá" trên web chỉ đặt archived_at, lưu lại đúng mã đó
-- là khôi phục.
--
-- In tem đi qua hàng đợi in hiện có: loại tem mới `location` (template 1), agent máy trạm
-- cần capability `location:v1` (workstation-agent/src/templates/location-label.mjs).
-- print_enqueue tự lấy TÊN vị trí từ bảng này, không tin tên do web gửi; vị trí chưa lưu
-- hoặc đã xoá thì không in được. Khi agent báo xong lệnh, trigger cộng số lần in.
--
-- Áp dụng: python scripts/apply_supabase_sql.py supabase/warehouse_location_v1.sql --allow-destructive
-- (--allow-destructive chỉ vì thay CHECK constraint loại tem và `drop trigger if exists`;
-- không xoá dữ liệu nào.)
begin;

-- Bỏ dấu tiếng Việt + chữ thường để tìm "so che" ra "Sơ chế". Không dùng extension unaccent.
create or replace function public.warehouse_location_fold(p_text text)
returns text language sql immutable set search_path='' as $$
  select lower(translate(normalize(coalesce(p_text,''), NFC),
    'àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃĂẰẮẶẲẴÂẦẤẬẨẪÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD'))
$$;

create table if not exists public.warehouse_locations (
  -- Mã in vào QR: chữ IN HOA, số và . _ / - ; 1–40 ký tự (web tự đổi sang chữ hoa).
  location_code text primary key check (location_code ~ '^[0-9A-Z][0-9A-Z._/-]{0,39}$'),
  location_name text not null check (char_length(location_name) between 1 and 60 and location_name = btrim(location_name) and location_name !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  print_count integer not null default 0 check (print_count >= 0),
  last_printed_at timestamptz,
  last_print_job_id uuid
);

alter table public.warehouse_locations enable row level security;
revoke all on public.warehouse_locations from public,anon,authenticated;
grant select,insert,update,delete on public.warehouse_locations to service_role;

-- Chuẩn hoá danh sách web gửi lên: mã chữ hoa bỏ khoảng trắng hai đầu, tên NFC gộp khoảng trắng.
create or replace function public.warehouse_location_parse(p_items jsonb)
returns table(line integer,code text,name text) language sql immutable set search_path='' as $$
  select t.ord::integer,
         upper(btrim(coalesce(t.v->>'code',''))),
         btrim(regexp_replace(normalize(coalesce(t.v->>'name',''),NFC),'\s+',' ','g'))
    from jsonb_array_elements(case when jsonb_typeof(p_items)='array' then p_items else '[]'::jsonb end) with ordinality as t(v,ord)
$$;

-- Lưu 1–500 vị trí một lần (form một vị trí hoặc dán từ Excel). Cả lô hợp lệ mới lưu.
-- Trùng mã đã có thì cập nhật tên; mã đã xoá thì khôi phục.
create or replace function public.warehouse_location_upsert(p_access_token text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_total integer; v_bad record; v_dup text; v_created integer; v_changed integer;
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Mã quyền không hợp lệ'));
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ITEMS','message','Mỗi lần lưu từ 1 đến 500 vị trí'));
  end if;
  v_total := jsonb_array_length(p_items);

  select i.line,i.code,i.name into v_bad from public.warehouse_location_parse(p_items) i
   where i.code !~ '^[0-9A-Z][0-9A-Z._/-]{0,39}$' or char_length(i.name) not between 1 and 60 or i.name ~ '[[:cntrl:]]'
   order by i.line limit 1;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LOCATION',
      'message',format('Dòng %s: mã cần 1–40 ký tự chữ hoa, số, . _ / - và tên cần 1–60 ký tự',v_bad.line),
      'data',jsonb_build_object('line',v_bad.line,'code',v_bad.code)));
  end if;
  select i.code into v_dup from public.warehouse_location_parse(p_items) i group by i.code having count(*)>1 order by min(i.line) limit 1;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','DUPLICATE_CODE',
      'message',format('Mã %s bị lặp trong danh sách',v_dup),'data',jsonb_build_object('code',v_dup)));
  end if;

  select count(*) into v_created from public.warehouse_location_parse(p_items) i
   where not exists(select 1 from public.warehouse_locations l where l.location_code=i.code);
  insert into public.warehouse_locations as l(location_code,location_name)
  select i.code,i.name from public.warehouse_location_parse(p_items) i order by i.line
  on conflict (location_code) do update
     set location_name=excluded.location_name,archived_at=null,updated_at=now()
   where l.location_name is distinct from excluded.location_name or l.archived_at is not null;
  get diagnostics v_changed=row_count;

  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'created',v_created,'updated',greatest(v_changed-v_created,0),'unchanged',greatest(v_total-v_changed,0),
    'codes',(select jsonb_agg(i.code order by i.line) from public.warehouse_location_parse(p_items) i)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Tìm theo mã hoặc tên (không phân biệt dấu/hoa thường), bỏ qua vị trí đã xoá. Mã trùng khớp
-- chính xác luôn đứng đầu (web dùng để biết mã vừa gõ đã có hay chưa).
create or replace function public.warehouse_location_search(p_access_token text,p_query text default '',p_limit integer default 300)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_query text := public.warehouse_location_fold(btrim(coalesce(p_query,'')));
  v_exact text := upper(btrim(coalesce(p_query,'')));
  v_like text;
  v_limit integer := least(greatest(coalesce(p_limit,300),1),1000);
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Mã quyền không hợp lệ'));
  end if;
  v_like := '%'||replace(replace(replace(v_query,'\','\\'),'%','\%'),'_','\_')||'%';
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'code',q.location_code,'name',q.location_name,'printCount',q.print_count,
      'lastPrintedAt',q.last_printed_at,'createdAt',q.created_at,'updatedAt',q.updated_at
    ) order by q.location_code=v_exact desc,q.location_code) from (
      select l.* from public.warehouse_locations l
       where l.archived_at is null
         and (v_query='' or lower(l.location_code) like v_like or public.warehouse_location_fold(l.location_name) like v_like)
       order by l.location_code=v_exact desc,l.location_code limit v_limit
    ) q),'[]'::jsonb),
    'matched',(select count(*) from public.warehouse_locations l
       where l.archived_at is null
         and (v_query='' or lower(l.location_code) like v_like or public.warehouse_location_fold(l.location_name) like v_like)),
    'total',(select count(*) from public.warehouse_locations l where l.archived_at is null),
    'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- "Xoá" trên web: ẩn khỏi danh sách và không in được nữa; lưu lại đúng mã là khôi phục.
create or replace function public.warehouse_location_archive(p_access_token text,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.warehouse_locations;
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Mã quyền không hợp lệ'));
  end if;
  update public.warehouse_locations set archived_at=now(),updated_at=now()
   where location_code=upper(btrim(coalesce(p_code,''))) and archived_at is null
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không tìm thấy vị trí này (có thể vừa bị xoá trên máy khác)'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('code',v_row.location_code),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Agent báo xong một lệnh tem vị trí → cộng số tem đã in cho từng mã trong lệnh.
-- Lỗi ở đây KHÔNG được làm hỏng việc báo hoàn tất lệnh in (agent sẽ tưởng chưa xong và in
-- lại), nên bọc EXCEPTION giống print_jobs_wake_agent.
create or replace function public.warehouse_location_mark_printed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  begin
    update public.warehouse_locations l
       set print_count=l.print_count+x.copies,last_printed_at=coalesce(new.completed_at,now()),last_print_job_id=new.id
      from (select i.v->>'code' as code,sum((i.v->>'copies')::integer) as copies
              from jsonb_array_elements(case when jsonb_typeof(new.payload->'items')='array' then new.payload->'items' else '[]'::jsonb end) as i(v)
             group by 1) x
     where l.location_code=x.code and l.last_print_job_id is distinct from new.id;
  exception when others then
    raise warning 'warehouse_location_mark_printed: không cập nhật được lệnh %: %', new.id, sqlerrm;
  end;
  return new;
end$$;

revoke all on function public.warehouse_location_mark_printed() from public,anon,authenticated;
drop trigger if exists print_jobs_location_printed on public.print_jobs;
create trigger print_jobs_location_printed
  after update of status on public.print_jobs
  for each row
  when (new.type='location' and new.status='completed' and old.status is distinct from 'completed')
  execute function public.warehouse_location_mark_printed();

-- Hàng đợi in: thêm loại tem `location`. Phần còn lại giữ nguyên bản đang chạy
-- (print_queue_v4_fabric_relaxation_handwritten.sql, đã đối chiếu với server 02/10/2026).
alter table public.print_jobs drop constraint if exists print_jobs_type_check;
alter table public.print_jobs add constraint print_jobs_type_check
  check (type in ('sku','group_uid','fabric_relaxation','location'));

create or replace function public.print_enqueue(p_access_token text,p_nonce text,p_type text,p_template_version integer,p_payload jsonb,p_copies integer,p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean; v_items jsonb; v_count integer; v_found integer; v_bad_copies integer; v_sum integer;
begin
  if p_type not in ('sku','group_uid','fabric_relaxation','location') or p_copies not between 1 and 500 or nullif(trim(p_nonce),'') is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Dữ liệu lệnh in không hợp lệ'));
  end if;
  if p_type = 'fabric_relaxation' then
    if p_template_version = 1 then
      if jsonb_typeof(p_payload->'itemCode') is distinct from 'string' or coalesce(p_payload->>'itemCode','') !~ '^[0-9A-Za-z._-]{1,40}$' then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mã hàng không hợp lệ'));
      end if;
    elsif p_template_version = 2 then
      if jsonb_typeof(p_payload->'itemCodes') is distinct from 'array' then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Danh sách mã hàng không hợp lệ'));
      end if;
      if jsonb_array_length(p_payload->'itemCodes') not between 1 and 5 or exists(
        select 1 from jsonb_array_elements(p_payload->'itemCodes') as item(value)
        where jsonb_typeof(item.value) is distinct from 'string'
           or coalesce(item.value #>> '{}','') !~ '^[0-9A-Za-z._-]{1,40}$'
      ) then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mỗi tem cần 1–5 mã hàng hợp lệ'));
      end if;
    elsif p_template_version = 3 then
      if coalesce(p_payload->>'handwritten','false') <> 'true' then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Tem viết tay không hợp lệ'));
      end if;
    else
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Phiên bản tem Fabric Relaxation không được hỗ trợ'));
    end if;
  end if;
  if p_type = 'location' then
    if coalesce(p_template_version,1) <> 1 or jsonb_typeof(p_payload->'items') is distinct from 'array'
       or jsonb_array_length(p_payload->'items') not between 1 and 100 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mỗi lệnh in từ 1 đến 100 vị trí'));
    end if;
    -- Tên in lên tem lấy từ warehouse_locations theo mã, không dùng tên web gửi lên.
    select jsonb_agg(jsonb_build_object('code',l.location_code,'name',l.location_name,'copies',x.copies) order by x.ord),
           count(*),count(l.location_code),count(*) filter (where x.copies not between 1 and 500),sum(x.copies)
      into v_items,v_count,v_found,v_bad_copies,v_sum
      from (select t.ord,upper(btrim(coalesce(t.v->>'code',''))) as code,
                   case when jsonb_typeof(t.v->'copies')='number' and (t.v->>'copies') ~ '^[0-9]{1,3}$' then (t.v->>'copies')::integer else 0 end as copies
              from jsonb_array_elements(p_payload->'items') with ordinality as t(v,ord)) x
      left join public.warehouse_locations l on l.location_code=x.code and l.archived_at is null;
    if v_found <> v_count then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','LOCATION_NOT_FOUND','message','Có vị trí chưa lưu hoặc vừa bị xoá. Hãy tải lại danh sách.'));
    end if;
    if v_bad_copies > 0 or v_sum <> p_copies then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Số tem mỗi vị trí phải từ 1 đến 500 và khớp tổng lệnh in'));
    end if;
    p_payload := jsonb_build_object('items',v_items);
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
  select * into v_job from public.print_jobs where status='queued' and (
    (type='sku' and template_version=1 and 'sku:v1'=any(v_cap)) or
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

revoke all on function public.warehouse_location_fold(text) from public,anon,authenticated;
revoke all on function public.warehouse_location_parse(jsonb) from public,anon,authenticated;
revoke all on function public.warehouse_location_upsert(text,jsonb) from public;
revoke all on function public.warehouse_location_search(text,text,integer) from public;
revoke all on function public.warehouse_location_archive(text,text) from public;
grant execute on function public.warehouse_location_upsert(text,jsonb) to anon,authenticated;
grant execute on function public.warehouse_location_search(text,text,integer) to anon,authenticated;
grant execute on function public.warehouse_location_archive(text,text) to anon,authenticated;

commit;
notify pgrst,'reload schema';
