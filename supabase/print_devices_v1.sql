-- Thiết bị in + mã kích hoạt (hướng C, 10/10/2026).
--
-- Hiện trạng: print_queue_public_access.sql đặt print_access_allowed() = true cho mọi mã, web gửi mã cố định "public",
-- nên ai có URL + publishable key (nằm trong index.html của repo công khai) đều gửi được lệnh in tới máy TSC ở kho.
-- Hướng C: mỗi thiết bị kích hoạt một lần bằng MÃ CHUNG do Admin tạo (hiệu lực 30 phút, dùng được nhiều máy trong
-- thời gian đó), đổi lấy KHOÁ RIÊNG của máy lưu trong trình duyệt. Admin thấy danh sách máy, tắt/đổi tên từng máy.
--
-- Chuyển tiếp: thêm khoá cũ 'legacy-public' = hash("public") để máy chưa kích hoạt vẫn in được; khi tất cả máy đã
-- kích hoạt, Admin tắt khoá này trong màn Thiết bị in → chỉ máy đã kích hoạt mới in được.
-- print_enqueue từ nay KIỂM mã (trước đây không kiểm dòng nào); phần thân cũ tách thành print_enqueue_unchecked cho
-- print_admin_reprint (đã kiểm quyền Admin) gọi. Agent không đổi (print_agent_* dùng token agent riêng).
begin;

-- ---------- Bảng ----------
create table if not exists public.print_activation_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  note text not null default '',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0)
);
create table if not exists public.print_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and char_length(name) <= 60),
  token_hash text not null unique,
  enabled boolean not null default true,
  activation_code_id uuid references public.print_activation_codes(id) on delete set null,
  user_agent text not null default '',
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_print_at timestamptz,
  print_count integer not null default 0 check (print_count >= 0),
  disabled_at timestamptz,
  updated_at timestamptz not null default now()
);
-- Chặn dò mã: đếm số lần kích hoạt sai theo phút (toàn hệ thống).
create table if not exists public.print_activation_attempts (
  minute timestamptz primary key,
  attempts integer not null default 0
);
alter table public.print_jobs add column if not exists device_id uuid references public.print_devices(id) on delete set null;
create index if not exists print_jobs_device_idx on public.print_jobs(device_id) where device_id is not null;

alter table public.print_activation_codes enable row level security;
alter table public.print_devices enable row level security;
alter table public.print_activation_attempts enable row level security;
revoke all on public.print_activation_codes, public.print_devices, public.print_activation_attempts from public, anon, authenticated;

-- Khoá chuyển tiếp: đúng chuỗi web đang gửi. Tắt trong Admin khi mọi máy đã kích hoạt.
insert into public.print_access_keys(name, token_hash)
values ('legacy-public', public.print_token_hash('public'))
on conflict (name) do nothing;

-- ---------- Kiểm mã ----------
create or replace function public.print_access_allowed(p_token text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(p_token, '') <> '' and (
    exists(select 1 from public.print_access_keys k where k.enabled and k.token_hash = public.print_token_hash(p_token))
    or exists(select 1 from public.print_devices d where d.enabled and d.token_hash = public.print_token_hash(p_token)))
$$;
revoke all on function public.print_access_allowed(text) from public, anon, authenticated;

create or replace function public.print_device_by_token(p_token text)
returns uuid language sql stable security definer set search_path='' as $$
  select d.id from public.print_devices d where d.enabled and coalesce(p_token,'') <> '' and d.token_hash = public.print_token_hash(p_token) limit 1
$$;
revoke all on function public.print_device_by_token(text) from public, anon, authenticated;

-- Ghi "máy còn sống" tối đa 1 lần/phút; p_printed = true thì đếm lệnh in.
create or replace function public.print_device_touch(p_token text, p_printed boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid := public.print_device_by_token(p_token);
begin
  if v_id is null then return; end if;
  update public.print_devices
     set last_seen_at = now(),
         last_print_at = case when p_printed then now() else last_print_at end,
         print_count = print_count + case when p_printed then 1 else 0 end,
         updated_at = now()
   where id = v_id and (p_printed or last_seen_at is null or last_seen_at < now() - interval '60 seconds');
end $$;
revoke all on function public.print_device_touch(text, boolean) from public, anon, authenticated;

-- ---------- Hàng đợi: tách thân cũ, thêm kiểm mã ----------
create or replace function public.print_enqueue_unchecked(p_access_token text, p_nonce text, p_type text, p_template_version integer, p_payload jsonb, p_copies integer, p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean; v_items jsonb; v_bad integer; v_sum integer; v_device uuid;
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
    select jsonb_agg(jsonb_build_object('code',x.code,'name',x.name,'copies',x.copies) order by x.ord),
           count(*) filter (where x.code !~ '^[0-9A-Z][0-9A-Z._/-]{0,39}$' or char_length(x.name) > 60 or x.name ~ '[[:cntrl:]]' or x.copies not between 1 and 500),
           sum(x.copies)
      into v_items,v_bad,v_sum
      from (select t.ord,
                   upper(btrim(coalesce(t.v->>'code',''))) as code,
                   btrim(regexp_replace(normalize(coalesce(t.v->>'name',''),NFC),'\s+',' ','g')) as name,
                   case when jsonb_typeof(t.v->'copies')='number' and (t.v->>'copies') ~ '^[0-9]{1,3}$' then (t.v->>'copies')::integer else 0 end as copies
              from jsonb_array_elements(p_payload->'items') with ordinality as t(v,ord)) x;
    if v_bad > 0 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mã vị trí cần 1–40 ký tự chữ hoa, số, . _ / -; tên tối đa 60 ký tự; số tem 1–500'));
    end if;
    if v_sum <> p_copies then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Tổng số tem không khớp lệnh in'));
    end if;
    p_payload := jsonb_build_object('items',v_items);
  end if;
  v_device := public.print_device_by_token(p_access_token);
  select exists(select 1 from public.print_jobs where nonce=p_nonce) into v_duplicate;
  insert into public.print_jobs(nonce,type,template_version,payload,copies,requested_by,device_id)
  values(p_nonce,p_type,greatest(coalesce(p_template_version,1),1),coalesce(p_payload,'{}'::jsonb),p_copies,left(coalesce(p_requested_by,''),100),v_device)
  on conflict(nonce) do update set updated_at=public.print_jobs.updated_at returning * into v_job;
  if not v_duplicate then
    insert into public.print_events(job_id,event_type,details) values(v_job.id,'queued',jsonb_build_object('copies',v_job.copies,'type',v_job.type));
    perform public.print_device_touch(p_access_token, true);
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end $$;
revoke all on function public.print_enqueue_unchecked(text,text,text,integer,jsonb,integer,text) from public, anon, authenticated;

create or replace function public.print_enqueue(p_access_token text, p_nonce text, p_type text, p_template_version integer, p_payload jsonb, p_copies integer, p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Máy này chưa được kích hoạt in'));
  end if;
  return public.print_enqueue_unchecked(p_access_token, p_nonce, p_type, p_template_version, p_payload, p_copies, p_requested_by);
end $$;
grant execute on function public.print_enqueue(text,text,text,integer,jsonb,integer,text) to anon, authenticated;

create or replace function public.print_queue_status(p_access_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Máy này chưa được kích hoạt in'));
  end if;
  perform public.print_device_touch(p_access_token, false);
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'queued',(select count(*) from public.print_jobs where status='queued'),
    'queuedCopies',(select coalesce(sum(copies),0) from public.print_jobs where status='queued'),
    'active',(select count(*) from public.print_jobs where status in ('claimed','rendering','sending','spooling')),
    'agents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'capabilities',capabilities,'state',state,'lastSeenAt',last_seen_at)) from public.print_agents where enabled),'[]'::jsonb)
  ),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- In lại từ Admin: đã kiểm quyền Admin, gọi thân không kiểm mã (chỉ đổi đúng một dòng so với print_jobs_admin_v1).
create or replace function public.print_admin_reprint(p_job_id uuid, p_items integer[] default null, p_nonce text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.print_jobs; v_items jsonb; v_count integer; v_sel integer[]; v_payload jsonb; v_copies integer;
  v_source text; v_result jsonb; v_new uuid;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được in lại'));
  end if;
  if coalesce(p_nonce, '') !~ '^[A-Za-z0-9_-]{8,80}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_NONCE', 'message', 'Thiếu mã chống gửi trùng'));
  end if;
  select * into v_job from public.print_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Không tìm thấy lệnh in (có thể đã được dọn)'));
  end if;
  if v_job.type not in ('sku', 'group_uid') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_SUPPORTED', 'message', 'Chỉ in lại lệnh SKU hoặc UID'));
  end if;
  if v_job.status not in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'JOB_ACTIVE', 'message', 'Lệnh gốc còn đang chờ hoặc đang in'));
  end if;
  v_items := public.print_job_items(v_job.type, v_job.payload, v_job.copies);
  v_count := jsonb_array_length(v_items);
  v_payload := v_job.payload;
  v_copies := v_job.copies;
  if p_items is not null then
    select array_agg(distinct i order by i) into v_sel from unnest(p_items) as u(i) where i is not null;
    if v_sel is null or v_sel[1] < 0 or v_sel[cardinality(v_sel)] >= v_count then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_ITEMS', 'message', 'Dòng chọn in lại không hợp lệ'));
    end if;
    if cardinality(v_sel) < v_count then
      if v_job.type <> 'group_uid' or jsonb_typeof(v_job.payload->'items') <> 'array' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PARTIAL_NOT_ALLOWED', 'message', 'Lệnh này chỉ in lại được toàn bộ'));
      end if;
      select jsonb_agg(t.v order by t.ord),
             sum(case when jsonb_typeof(t.v->'copies') = 'number' then (t.v->>'copies')::numeric::integer else 1 end)
        into v_items, v_copies
        from jsonb_array_elements(v_job.payload->'items') with ordinality as t(v, ord)
       where (t.ord - 1)::integer = any(v_sel);
      v_payload := jsonb_set(v_job.payload, '{items}', v_items);
    end if;
  end if;
  v_source := btrim(regexp_replace(coalesce(v_job.requested_by, ''), '\s*(·\s*in lại|\(in lại).*$', '', 'i'));
  v_result := public.print_enqueue_unchecked('', p_nonce, v_job.type, v_job.template_version, v_payload, v_copies,
                                             left(v_source, 70) || ' · in lại ' || left(v_job.id::text, 8));
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;
  v_new := (v_result->'data'->>'id')::uuid;
  if coalesce((v_result->'data'->>'duplicate')::boolean, false) is not true then
    update public.print_jobs set reprint_of = v_job.id where id = v_new and reprint_of is null;
    insert into public.print_events(job_id, event_type, details)
    values (v_new, 'reprint', jsonb_build_object(
      'reprintOf', v_job.id,
      'items', case when v_sel is null or cardinality(v_sel) = v_count then to_jsonb('all'::text) else to_jsonb(v_sel) end,
      'copies', v_copies,
      'userId', (select auth.uid()),
      'username', (select username from public.user_roles where user_id = (select auth.uid()) limit 1)));
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'id', v_new, 'status', v_result->'data'->>'status', 'duplicate', coalesce((v_result->'data'->>'duplicate')::boolean, false),
    'copies', v_copies, 'itemCount', coalesce(cardinality(v_sel), v_count), 'reprintOf', v_job.id));
end $$;

-- ---------- Mã kích hoạt ----------
create or replace function public.print_activation_normalize(p_code text)
returns text language sql immutable set search_path='' as $$
  select upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'))
$$;
revoke all on function public.print_activation_normalize(text) from public, anon, authenticated;

-- Admin tạo mã chung: 8 ký tự (bỏ 0/O/1/I), hiệu lực p_minutes (mặc định 30, từ 5 tới 1440). Chỉ trả mã rõ đúng một lần.
create or replace function public.print_activation_create(p_minutes integer default 30, p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_bytes bytea; v_code text := ''; v_id uuid; v_exp timestamptz; i integer;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được tạo mã kích hoạt'));
  end if;
  if coalesce(p_minutes, 30) not between 5 and 1440 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_MINUTES','message','Hiệu lực từ 5 phút tới 24 giờ'));
  end if;
  -- Dọn mã đã hết hạn quá 7 ngày; thiết bị kích hoạt bằng mã đó chỉ mất liên kết, không bị ảnh hưởng.
  delete from public.print_activation_codes where expires_at < now() - interval '7 days';
  delete from public.print_activation_attempts where minute < now() - interval '1 day';
  v_bytes := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  v_exp := now() + make_interval(mins => coalesce(p_minutes, 30));
  insert into public.print_activation_codes(code_hash, note, created_by, expires_at)
  values (public.print_token_hash(v_code), left(btrim(coalesce(p_note,'')), 80), (select auth.uid()), v_exp)
  returning id into v_id;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'id', v_id, 'code', substr(v_code,1,4) || '-' || substr(v_code,5,4), 'expiresAt', v_exp, 'minutes', coalesce(p_minutes,30)));
end $$;
revoke all on function public.print_activation_create(integer, text) from public, anon;
grant execute on function public.print_activation_create(integer, text) to authenticated;

create or replace function public.print_activation_revoke(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được thu hồi mã'));
  end if;
  update public.print_activation_codes set revoked_at = now() where id = p_id and revoked_at is null;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',p_id,'revoked',found));
end $$;
revoke all on function public.print_activation_revoke(uuid) from public, anon;
grant execute on function public.print_activation_revoke(uuid) to authenticated;

-- Máy nhập mã → nhận khoá riêng. Chặn dò: tối đa 30 lần sai/phút toàn hệ thống.
create or replace function public.print_device_activate(p_code text, p_name text, p_user_agent text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text := public.print_activation_normalize(p_code); v_name text := btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g'));
        v_minute timestamptz := date_trunc('minute', now()); v_attempts integer; v_row public.print_activation_codes; v_token text; v_dev public.print_devices;
begin
  if v_name = '' or char_length(v_name) > 60 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_NAME','message','Tên máy từ 1 đến 60 ký tự'));
  end if;
  if char_length(v_code) <> 8 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_CODE','message','Mã kích hoạt gồm 8 ký tự'));
  end if;
  insert into public.print_activation_attempts(minute, attempts) values (v_minute, 1)
  on conflict (minute) do update set attempts = public.print_activation_attempts.attempts + 1
  returning attempts into v_attempts;
  if v_attempts > 30 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','RATE_LIMITED','message','Thử quá nhiều lần, chờ một phút rồi nhập lại'));
  end if;
  select * into v_row from public.print_activation_codes
   where code_hash = public.print_token_hash(v_code) and revoked_at is null and expires_at > now()
   for update;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_CODE','message','Mã không đúng hoặc đã hết hạn'));
  end if;
  v_token := 'pd_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.print_devices(name, token_hash, activation_code_id, user_agent)
  values (v_name, public.print_token_hash(v_token), v_row.id, left(coalesce(p_user_agent,''), 200))
  returning * into v_dev;
  update public.print_activation_codes set use_count = use_count + 1 where id = v_row.id;
  -- Lần nhập đúng không tính vào hạn mức dò mã.
  update public.print_activation_attempts set attempts = greatest(attempts - 1, 0) where minute = v_minute;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'token', v_token, 'device', jsonb_build_object('id', v_dev.id, 'name', v_dev.name, 'activatedAt', v_dev.activated_at)));
end $$;
grant execute on function public.print_device_activate(text, text, text) to anon, authenticated;

-- ---------- Admin: danh sách và quản lý ----------
create or replace function public.print_devices_admin()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xem thiết bị in'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'enabled', d.enabled, 'activatedAt', d.activated_at, 'lastSeenAt', d.last_seen_at,
        'lastPrintAt', d.last_print_at, 'printCount', d.print_count, 'userAgent', d.user_agent, 'disabledAt', d.disabled_at,
        'jobsToday', (select count(*) from public.print_jobs j where j.device_id = d.id and j.created_at >= date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')
      ) order by d.enabled desc, coalesce(d.last_seen_at, d.activated_at) desc) from public.print_devices d), '[]'::jsonb),
    'codes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'note', c.note, 'createdAt', c.created_at, 'expiresAt', c.expires_at, 'revokedAt', c.revoked_at, 'useCount', c.use_count,
        'active', c.revoked_at is null and c.expires_at > now(),
        'createdBy', (select username from public.user_roles u where u.user_id = c.created_by limit 1)
      ) order by c.created_at desc) from public.print_activation_codes c where c.created_at > now() - interval '7 days'), '[]'::jsonb),
    'legacyKeys', coalesce((select jsonb_agg(jsonb_build_object(
        'name', k.name, 'enabled', k.enabled, 'createdAt', k.created_at, 'isPublic', k.token_hash = public.print_token_hash('public')
      ) order by k.created_at) from public.print_access_keys k), '[]'::jsonb),
    'now', now()));
end $$;
revoke all on function public.print_devices_admin() from public, anon;
grant execute on function public.print_devices_admin() to authenticated;

create or replace function public.print_device_set_enabled(p_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đổi trạng thái máy'));
  end if;
  update public.print_devices
     set enabled = coalesce(p_enabled, false), disabled_at = case when coalesce(p_enabled,false) then null else now() end, updated_at = now()
   where id = p_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không thấy máy'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',p_id,'enabled',coalesce(p_enabled,false)));
end $$;
revoke all on function public.print_device_set_enabled(uuid, boolean) from public, anon;
grant execute on function public.print_device_set_enabled(uuid, boolean) to authenticated;

create or replace function public.print_device_rename(p_id uuid, p_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_name text := btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g'));
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đổi tên máy'));
  end if;
  if v_name = '' or char_length(v_name) > 60 or v_name ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_NAME','message','Tên máy từ 1 đến 60 ký tự'));
  end if;
  update public.print_devices set name = v_name, updated_at = now() where id = p_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không thấy máy'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',p_id,'name',v_name));
end $$;
revoke all on function public.print_device_rename(uuid, text) from public, anon;
grant execute on function public.print_device_rename(uuid, text) to authenticated;

-- Bật/tắt khoá chuyển tiếp (và khoá cũ khác) — tắt 'legacy-public' khi mọi máy đã kích hoạt.
create or replace function public.print_access_key_set_enabled(p_name text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đổi khoá chung'));
  end if;
  update public.print_access_keys set enabled = coalesce(p_enabled,false), updated_at = now() where name = p_name;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Không thấy khoá'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('name',p_name,'enabled',coalesce(p_enabled,false)));
end $$;
revoke all on function public.print_access_key_set_enabled(text, boolean) from public, anon;
grant execute on function public.print_access_key_set_enabled(text, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
