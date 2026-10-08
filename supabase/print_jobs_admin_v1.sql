-- Màn "Lệnh in" trong Admin (#admin/lenh-in), 08/10/2026: tìm lệnh in theo ngày, xem từng dòng, in lại.
-- Thay hai mục React cũ "Tổng quan" và "Đợt đã gửi" (chỉ ghi trong bộ nhớ của một tab trình duyệt).
-- Kèm lịch dọn print_jobs: 3 ngày chạy một lần, giữ lệnh của 3 ngày gần nhất.
--
-- Chạy một lần: python scripts/apply_supabase_sql.py supabase/print_jobs_admin_v1.sql
-- Chỉ THÊM (cột, chỉ mục, bảng bảo trì, hàm, lịch pg_cron); không sửa hàm cũ, agent không cần cập nhật.
--
-- Quy tắc in lại (người dùng chốt 08/10/2026):
--   - Lệnh SKU: in lại NGUYÊN lệnh, giống hệt lệnh gốc (cùng dòng, số tem, ngày in, số lượng).
--   - Lệnh Group UID: in lại toàn bộ hoặc một phần dòng; mỗi dòng giữ nguyên số tem.
--   - Payload lệnh mới do máy chủ dựng từ lệnh gốc, không lấy dữ liệu trình duyệt gửi lên.
--   - Lệnh gốc còn đang chờ / đang in thì không cho in lại (tránh trùng tem).
begin;

alter table public.print_jobs add column if not exists reprint_of uuid references public.print_jobs(id) on delete set null;
create index if not exists print_jobs_created_idx on public.print_jobs(created_at desc);
create index if not exists print_jobs_reprint_of_idx on public.print_jobs(reprint_of) where reprint_of is not null;

create or replace function public.print_admin_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.user_roles where user_id = (select auth.uid()) and role = 'admin')
$$;
revoke all on function public.print_admin_allowed() from public, anon, authenticated;

-- Danh sách dòng của một lệnh dưới một dạng: payload mới có `items`; payload cũ một SKU/UID thì
-- coi như một dòng mang toàn bộ số tem của lệnh; Fabric dùng mã hàng.
create or replace function public.print_job_items(p_type text, p_payload jsonb, p_copies integer)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_payload->'items') = 'array' then p_payload->'items'
    when p_type in ('sku','group_uid') and (p_payload ? 'sku' or p_payload ? 'groupUid')
      then jsonb_build_array(p_payload || jsonb_build_object('copies', p_copies))
    when p_type = 'fabric_relaxation' and jsonb_typeof(p_payload->'itemCodes') = 'array'
      then coalesce((select jsonb_agg(jsonb_build_object('code', v)) from jsonb_array_elements_text(p_payload->'itemCodes') as t(v)), '[]'::jsonb)
    when p_type = 'fabric_relaxation' and p_payload ? 'itemCode'
      then jsonb_build_array(jsonb_build_object('code', p_payload->>'itemCode'))
    else '[]'::jsonb
  end
$$;
revoke all on function public.print_job_items(text, jsonb, integer) from public, anon, authenticated;

create or replace function public.print_admin_jobs(p_day date default null, p_type text default 'all', p_query text default '')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_day date := coalesce(p_day, v_today);
  v_from timestamptz := v_day::timestamp at time zone 'Asia/Ho_Chi_Minh';
  v_to timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh';
  v_type text := lower(coalesce(nullif(btrim(p_type), ''), 'all'));
  v_q text := left(lower(btrim(coalesce(p_query, ''))), 80);
  v_result jsonb;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xem lệnh in'));
  end if;
  if v_type not in ('all', 'sku', 'group_uid', 'other') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_TYPE', 'message', 'Loại lệnh không hợp lệ'));
  end if;
  with day_jobs as (
    select j.*, public.print_job_items(j.type, j.payload, j.copies) as items,
           case when j.type in ('sku', 'group_uid') then j.type else 'other' end as kind
      from public.print_jobs j
     where j.created_at >= v_from and j.created_at < v_to
  ), matched as (
    select d.* from day_jobs d
     where v_q = ''
        or left(d.id::text, char_length(v_q)) = v_q
        or position(v_q in lower(d.requested_by)) > 0
        or exists (
          select 1 from jsonb_array_elements(d.items) as it(v)
           where position(v_q in lower(concat_ws(' ', it.v->>'sku', it.v->>'groupUid', it.v->>'productName',
                                                  it.v->>'code', it.v->>'name', it.v->>'lot', it.v->>'roll'))) > 0)
  ), shown as (
    select m.* from matched m where v_type = 'all' or m.kind = v_type order by m.created_at desc limit 500
  )
  select jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'day', v_day,
    'today', v_today,
    'oldestDay', (select (min(created_at) at time zone 'Asia/Ho_Chi_Minh')::date from public.print_jobs),
    'summary', (select jsonb_build_object(
        'jobs', count(*), 'copies', coalesce(sum(copies), 0),
        'failed', count(*) filter (where status = 'failed'),
        'active', count(*) filter (where status not in ('completed', 'failed', 'cancelled'))) from day_jobs),
    'counts', (select jsonb_build_object(
        'all', count(*), 'sku', count(*) filter (where kind = 'sku'),
        'group_uid', count(*) filter (where kind = 'group_uid'), 'other', count(*) filter (where kind = 'other')) from matched),
    'jobs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'type', s.type, 'kind', s.kind, 'status', s.status, 'copies', s.copies,
        'itemCount', jsonb_array_length(s.items), 'first', s.items->0, 'source', s.requested_by,
        'createdAt', s.created_at, 'completedAt', s.completed_at,
        'errorCode', s.error_code, 'errorMessage', s.error_message, 'reprintOf', s.reprint_of,
        'reprintCount', (select count(*) from public.print_jobs r where r.reprint_of = s.id)
      ) order by s.created_at desc) from shown s), '[]'::jsonb)
  )) into v_result;
  return v_result;
end$$;

create or replace function public.print_admin_job(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_job public.print_jobs; v_items jsonb; v_final boolean;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xem lệnh in'));
  end if;
  select * into v_job from public.print_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Không tìm thấy lệnh in (có thể đã được dọn)'));
  end if;
  v_items := public.print_job_items(v_job.type, v_job.payload, v_job.copies);
  v_final := v_job.status in ('completed', 'failed', 'cancelled');
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'id', v_job.id, 'type', v_job.type, 'templateVersion', v_job.template_version, 'status', v_job.status,
    'copies', v_job.copies, 'source', v_job.requested_by, 'agentId', v_job.agent_id, 'attemptCount', v_job.attempt_count,
    'createdAt', v_job.created_at, 'claimedAt', v_job.claimed_at, 'completedAt', v_job.completed_at,
    'errorCode', v_job.error_code, 'errorMessage', v_job.error_message, 'result', v_job.result, 'reprintOf', v_job.reprint_of,
    'items', coalesce((select jsonb_agg(t.v || jsonb_build_object('index', t.ord - 1) order by t.ord)
                         from jsonb_array_elements(v_items) with ordinality as t(v, ord)), '[]'::jsonb),
    'reprints', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'copies', r.copies, 'createdAt', r.created_at) order by r.created_at)
                            from public.print_jobs r where r.reprint_of = v_job.id), '[]'::jsonb),
    'reprint', jsonb_build_object(
      'allowed', v_job.type in ('sku', 'group_uid') and v_final and jsonb_array_length(v_items) > 0,
      'partial', v_job.type = 'group_uid' and jsonb_typeof(v_job.payload->'items') = 'array',
      'reason', case when v_job.type not in ('sku', 'group_uid') then 'NOT_SUPPORTED'
                     when not v_final then 'JOB_ACTIVE' else null end)
  ));
end$$;

create or replace function public.print_admin_reprint(p_job_id uuid, p_items integer[] default null, p_nonce text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
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
      -- SKU luôn in lại nguyên lệnh; lệnh UID dạng cũ (một UID, không có items) cũng chỉ in nguyên lệnh.
      if v_job.type <> 'group_uid' or jsonb_typeof(v_job.payload->'items') <> 'array' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PARTIAL_NOT_ALLOWED', 'message', 'Lệnh này chỉ in lại được toàn bộ'));
      end if;
      -- Agent đòi tổng số tem bằng tổng số tem từng dòng (thiếu `copies` tính là 1), nên tính lại theo đúng dòng chọn.
      select jsonb_agg(t.v order by t.ord),
             sum(case when jsonb_typeof(t.v->'copies') = 'number' then (t.v->>'copies')::numeric::integer else 1 end)
        into v_items, v_copies
        from jsonb_array_elements(v_job.payload->'items') with ordinality as t(v, ord)
       where (t.ord - 1)::integer = any(v_sel);
      v_payload := jsonb_set(v_job.payload, '{items}', v_items);
    end if;
  end if;
  v_source := btrim(regexp_replace(coalesce(v_job.requested_by, ''), '\s*(·\s*in lại|\(in lại).*$', '', 'i'));
  v_result := public.print_enqueue('', p_nonce, v_job.type, v_job.template_version, v_payload, v_copies,
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
end$$;

revoke all on function public.print_admin_jobs(date, text, text) from public, anon;
revoke all on function public.print_admin_job(uuid) from public, anon;
revoke all on function public.print_admin_reprint(uuid, integer[], text) from public, anon;
grant execute on function public.print_admin_jobs(date, text, text) to authenticated;
grant execute on function public.print_admin_job(uuid) to authenticated;
grant execute on function public.print_admin_reprint(uuid, integer[], text) to authenticated;

-- Dọn print_jobs: 3 ngày chạy một lần, xoá lệnh ĐÃ KẾT THÚC (xong / lỗi / huỷ) cũ hơn 3 ngày; lệnh đang
-- chờ hoặc đang in không bao giờ bị xoá. print_events của lệnh bị xoá đi theo (on delete cascade).
-- pg_cron gọi mỗi ngày lúc 03:00 giờ VN; hàm tự bỏ qua nếu lần chạy trước chưa đủ 3 ngày, nên nhịp
-- luôn đúng 3 ngày kể cả qua cuối tháng (cron "*/3" theo ngày trong tháng sẽ lệch ở ngày 31 → 1).
create table if not exists public.print_maintenance (
  task text primary key,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.print_maintenance enable row level security;
revoke all on public.print_maintenance from anon, authenticated;

create or replace function public.print_jobs_purge(p_keep interval default interval '3 days', p_every interval default interval '3 days', p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz; v_cutoff timestamptz := now() - p_keep; v_jobs integer; v_events integer; v_result jsonb;
begin
  select last_run_at into v_last from public.print_maintenance where task = 'print_jobs_purge' for update;
  -- Trừ hao 1 giờ để lần chạy 03:00 không trôi sang ngày thứ 4 vì lệch vài giây.
  if not p_force and v_last is not null and now() - v_last < p_every - interval '1 hour' then
    return jsonb_build_object('ok', true, 'skipped', true, 'lastRunAt', v_last);
  end if;
  with gone as (
    delete from public.print_jobs
     where status in ('completed', 'failed', 'cancelled') and created_at < v_cutoff
    returning 1)
  select count(*) into v_jobs from gone;
  with gone as (
    delete from public.print_events where job_id is null and created_at < v_cutoff returning 1)
  select count(*) into v_events from gone;
  v_result := jsonb_build_object('ok', true, 'skipped', false, 'cutoff', v_cutoff, 'deletedJobs', v_jobs,
                                 'deletedAgentEvents', v_events, 'remainingJobs', (select count(*) from public.print_jobs));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('print_jobs_purge', now(), v_result, now())
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end$$;
revoke all on function public.print_jobs_purge(interval, interval, boolean) from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
-- 20:00 UTC = 03:00 giờ VN. Lên lịch lại cùng tên thì pg_cron cập nhật lịch cũ, không tạo lịch thứ hai.
select cron.schedule('print-jobs-purge', '0 20 * * *', $$select public.print_jobs_purge()$$);

commit;
