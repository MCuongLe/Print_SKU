-- Lệnh in + Thiết bị (11/10/2026): màn Admin "Thiết bị in" gộp thành tab trong Lệnh in.
-- print_admin_jobs nhận thêm p_device (lọc lệnh của một máy) và trả deviceId/deviceName cho từng lệnh
-- (cột Nguồn hiện tên máy đã kích hoạt thay cho chữ tự do); tìm kiếm cũng khớp tên máy.
-- print_admin_job trả thêm deviceId/deviceName. Đổi chữ ký nên phải drop bản 3 tham số (PostgREST không chọn được
-- giữa hai overload khi web gọi thiếu p_device).
begin;

drop function if exists public.print_admin_jobs(date, text, text);

create or replace function public.print_admin_jobs(p_day date default null, p_type text default 'all', p_query text default '', p_device uuid default null)
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
           case when j.type in ('sku', 'group_uid') then j.type else 'other' end as kind,
           dv.name as device_name
      from public.print_jobs j
      left join public.print_devices dv on dv.id = j.device_id
     where j.created_at >= v_from and j.created_at < v_to
       and (p_device is null or j.device_id = p_device)
  ), matched as (
    select d.* from day_jobs d
     where v_q = ''
        or left(d.id::text, char_length(v_q)) = v_q
        or position(v_q in lower(d.requested_by)) > 0
        or position(v_q in lower(coalesce(d.device_name, ''))) > 0
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
    'device', p_device,
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
        'deviceId', s.device_id, 'deviceName', s.device_name,
        'createdAt', s.created_at, 'completedAt', s.completed_at,
        'errorCode', s.error_code, 'errorMessage', s.error_message, 'reprintOf', s.reprint_of,
        'reprintCount', (select count(*) from public.print_jobs r where r.reprint_of = s.id)
      ) order by s.created_at desc) from shown s), '[]'::jsonb)
  )) into v_result;
  return v_result;
end$$;
revoke all on function public.print_admin_jobs(date, text, text, uuid) from public, anon;
grant execute on function public.print_admin_jobs(date, text, text, uuid) to authenticated;

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
    'deviceId', v_job.device_id, 'deviceName', (select name from public.print_devices where id = v_job.device_id),
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

notify pgrst, 'reload schema';
commit;
