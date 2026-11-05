-- Admin xoá dòng đã in ở tab "Đã in" của THEO DÕI XẢ VẢI (04/11/2026, Việc 6 của docs/plans/2026-11-04-xoa-lenh-da-in-khi-admin-dang-nhap.md).
--
-- Vì sao: người dùng cần xoá dữ liệu in thử trong ngày (04/11 22:00 "xóa các lệnh in do tôi test chiều giờ"; 22:2x chốt: đăng
-- nhập Admin và xoá ngay ở tab Đã in của Xả vải, xoá dòng + lệnh A4 trống, chỉ Admin, bỏ phương án xoá ở màn Lệnh in).
--
-- Tác động:
--   * Bảng mới public.print_jobs_purge_log (nhật ký số đếm, không payload / SKU / UID; RLS bật, không policy, không quyền anon /
--     authenticated; lead đọc qua Supabase MCP). Dùng chung với Việc 1 (tự xoá khi Admin đăng nhập, trigger 'admin_login').
--   * Hàm mới public.xa_vai_printed_delete(p_group_uids text[], p_dry_run boolean default true): chỉ Admin (print_admin_allowed(),
--     gọi bằng JWT phiên Admin, không phải khoá máy), chỉ authenticated. Mặc định CHỈ ĐẾM (không khoá, không xoá, không ghi nhật
--     ký); web hỏi số đếm → WhDialog → gọi lại p_dry_run = false với đúng danh sách 'uids' máy chủ cho xoá.
--     - Tối đa 1000 dòng / lần (tab Đã in hiện tối đa 5000); btrim, bỏ rỗng / trùng.
--     - p_dry_run NULL tính như true (chỉ đếm).
--     - Chỉ dòng xa_vai_measures status 'printed'. Bỏ qua kèm lý do: NOT_FOUND; NOT_PRINTED (pending / printing); JOB_ACTIVE
--       (UID còn trong payload lệnh A4 đang chờ / đang in — lệnh in lại không gắn dòng nên dò theo payload); TOO_RECENT (in xong
--       chưa tới 5 phút: tab khác có thể còn theo dõi lệnh). Không hạn 24 giờ (người dùng 04/11).
--     - Xoá dòng → Group UID trở lại chưa đo, đo lại được. Lệnh in A4 (xa_vai_sheet, đã xong / lỗi / huỷ) mà MỌI dòng gắn lệnh
--       đều bị xoá thì xoá luôn lệnh (print_events theo CASCADE, reprint_of của lệnh in lại về NULL). Lệnh còn dòng chưa chọn giữ
--       nguyên. Lệnh in lại / lệnh thử không gắn dòng nào không đụng tới (cron print_jobs_purge dọn sau 3 ngày).
--     - Khoá print_jobs (theo id) trước, xa_vai_measures (theo group_uid_code) sau: cùng thứ tự với trigger
--       xa_vai_measures_sync_job; trạng thái xét lại sau khi khoá. Mỗi lần xoá thật ghi một dòng nhật ký 'xa_vai_manual'.
--   * Không đổi hàm có sẵn, cron, agent, Extension, Edge. Phân loại: tương thích ngược (web cũ không gọi hàm mới).
-- Không DROP, không xoá dữ liệu ở cấp cao nhất (delete chỉ nằm trong thân hàm) → không cần --allow-destructive.
-- Chạy lại nhiều lần được (create table if not exists / create or replace).
-- Thứ tự lên: migration này → push web (icon khiên + nút Xoá ở tab Đã in).
-- Kiểm cục bộ: node tests/xa_vai_printed_delete_sql.cjs; python scripts/apply_supabase_sql.py supabase/xa_vai_printed_delete_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/xa_vai_printed_delete_v1.sql
-- kiem: select to_regprocedure('public.xa_vai_printed_delete(text[],boolean)') is not null and to_regclass('public.print_jobs_purge_log') is not null and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.print_jobs_purge_log')), false) and not has_function_privilege('anon', 'public.xa_vai_printed_delete(text[],boolean)', 'execute') and has_function_privilege('authenticated', 'public.xa_vai_printed_delete(text[],boolean)', 'execute') and not has_table_privilege('authenticated', 'public.print_jobs_purge_log', 'select')
-- Rút lui (web mới báo lỗi khi bấm Xoá; nhật ký mất nếu drop bảng; chạy kèm --allow-destructive):
--   drop function if exists public.xa_vai_printed_delete(text[], boolean);
--   drop table if exists public.print_jobs_purge_log;
begin;

-- ---------- Nhật ký xoá lệnh in / dòng Xả vải (số đếm, không nội dung) ----------
create table if not exists public.print_jobs_purge_log (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  actor_id uuid,
  actor_name text,
  trigger text not null check (trigger in ('admin_login', 'xa_vai_manual')),
  keep_hours integer,
  eligible integer not null default 0,
  deleted_jobs integer not null default 0,
  deleted_events integer not null default 0,
  deleted_xa_vai integer not null default 0,
  by_type jsonb not null default '{}'::jsonb,
  oldest_created_at timestamptz,
  newest_created_at timestamptz,
  outcome text not null check (outcome in ('deleted', 'needs_confirm'))
);
comment on table public.print_jobs_purge_log is
  'Nhật ký xoá: xa_vai_manual = Admin xoá dòng ở tab Đã in của Xả vải (xa_vai_printed_delete), admin_login = tự xoá lệnh đã in khi Admin đăng nhập. Chỉ số đếm và mốc thời gian.';
alter table public.print_jobs_purge_log enable row level security;
revoke all on table public.print_jobs_purge_log from public, anon, authenticated;

-- ---------- xa_vai_printed_delete: Admin xoá dòng đã in + lệnh A4 trống ----------
create or replace function public.xa_vai_printed_delete(p_group_uids text[], p_dry_run boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_dry_run boolean := coalesce(p_dry_run, true);
  v_codes text[];
  v_job_ids uuid[];
  v_ok text[];
  v_empty uuid[];
  v_skipped jsonb;
  v_oldest timestamptz;
  v_newest timestamptz;
  v_rows integer := 0;
  v_jobs integer := 0;
  v_events integer := 0;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xoá dòng Xả vải đã in'));
  end if;
  select coalesce(array_agg(distinct btrim(x)), '{}'::text[]) into v_codes
    from unnest(coalesce(p_group_uids, '{}'::text[])) as x
   where nullif(btrim(x), '') is not null;
  if cardinality(v_codes) = 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'BAD_REQUEST', 'message', 'Chưa chọn dòng'));
  end if;
  if cardinality(v_codes) > 1000 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'TOO_MANY', 'message', 'Tối đa 1000 dòng mỗi lần xoá'));
  end if;
  -- Xoá thật: khoá lệnh rồi dòng (thứ tự của trigger xa_vai_measures_sync_job), xét trạng thái sau khi khoá.
  if not v_dry_run then
    select coalesce(array_agg(distinct m.print_job_id), '{}'::uuid[]) into v_job_ids
      from public.xa_vai_measures m where m.group_uid_code = any(v_codes) and m.print_job_id is not null;
    perform 1 from public.print_jobs where id = any(v_job_ids) order by id for update;
    perform 1 from public.xa_vai_measures where group_uid_code = any(v_codes) order by group_uid_code for update;
  end if;
  with req as (
    select unnest(v_codes) as code
  ), cls as (
    select r.code, m.status, m.printed_at,
           case
             when m.group_uid_code is null then 'NOT_FOUND'
             when m.status <> 'printed' then 'NOT_PRINTED'
             when exists (select 1 from public.print_jobs j where j.type = 'xa_vai_sheet' and j.status not in ('completed', 'failed', 'cancelled') and j.payload->'items' @> jsonb_build_array(jsonb_build_object('groupUid', r.code))) then 'JOB_ACTIVE'
             when coalesce(m.printed_at, now()) > now() - interval '5 minutes' then 'TOO_RECENT'
           end as reason
      from req r left join public.xa_vai_measures m on m.group_uid_code = r.code
  )
  select coalesce(array_agg(code order by code) filter (where reason is null), '{}'::text[]),
         coalesce(jsonb_agg(jsonb_build_object('groupUid', code, 'reason', reason, 'status', status) order by code) filter (where reason is not null), '[]'::jsonb),
         min(printed_at) filter (where reason is null),
         max(printed_at) filter (where reason is null)
    into v_ok, v_skipped, v_oldest, v_newest
    from cls;
  v_rows := cardinality(v_ok);
  -- Lệnh A4 sẽ trống: lệnh đã xong của các dòng được xoá mà mọi dòng gắn lệnh đều nằm trong danh sách xoá.
  select coalesce(array_agg(j.id order by j.id), '{}'::uuid[]) into v_empty
    from public.print_jobs j
   where j.id in (select m.print_job_id from public.xa_vai_measures m where m.group_uid_code = any(v_ok) and m.print_job_id is not null)
     and j.type = 'xa_vai_sheet' and j.status in ('completed', 'failed', 'cancelled') and not exists (select 1 from public.xa_vai_measures m2 where m2.print_job_id = j.id and not (m2.group_uid_code = any(v_ok)));
  v_jobs := cardinality(v_empty);
  select count(*) into v_events from public.print_events where job_id = any(v_empty);
  if v_dry_run then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'dryRun', true, 'requested', cardinality(v_codes), 'uids', to_jsonb(v_ok), 'rows', v_rows, 'jobs', v_jobs,
      'events', v_events, 'skipped', v_skipped));
  end if;
  with gone as (
    delete from public.xa_vai_measures where group_uid_code = any(v_ok) and status = 'printed'
    returning 1)
  select count(*) into v_rows from gone;
  -- print_events theo CASCADE; reprint_of của lệnh in lại về NULL.
  with gone as (
    delete from public.print_jobs j where j.id = any(v_empty) and j.type = 'xa_vai_sheet' and j.status in ('completed', 'failed', 'cancelled') and not exists (select 1 from public.xa_vai_measures m2 where m2.print_job_id = j.id)
    returning 1)
  select count(*) into v_jobs from gone;
  insert into public.print_jobs_purge_log(actor_id, actor_name, trigger, eligible, deleted_jobs, deleted_events, deleted_xa_vai, by_type, oldest_created_at, newest_created_at, outcome)
  values (v_actor, (select username from public.user_roles where user_id = v_actor limit 1), 'xa_vai_manual', cardinality(v_ok), v_jobs, v_events, v_rows,
          jsonb_build_object('xa_vai_sheet', v_jobs), v_oldest, v_newest, 'deleted');
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'dryRun', false, 'requested', cardinality(v_codes), 'uids', to_jsonb(v_ok), 'rows', v_rows, 'jobs', v_jobs,
    'events', v_events, 'skipped', v_skipped));
end$$;
revoke all on function public.xa_vai_printed_delete(text[], boolean) from public, anon, authenticated;
grant execute on function public.xa_vai_printed_delete(text[], boolean) to authenticated;

commit;
notify pgrst, 'reload schema';
