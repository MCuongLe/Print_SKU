-- Đồng bộ tự động qua Extension (auto-sync v1), 17/10/2026.
-- Vì sao: Extension (service worker) tự chạy đồng bộ Group UID / SKU theo lịch (gia tăng mỗi 30 phút, toàn bộ 1 lần/đêm),
-- dùng phiên Admin riêng của Extension; Edge vẫn kiểm vai trò Admin như cũ. Cần: cấu hình chung (bật/tắt, nhịp, ngưỡng tự áp dụng),
-- khoá thuê theo loại để nhiều máy không chạy trùng, và đánh dấu lượt tự động / máy chạy / lý do giữ lại trên bảng lượt.
-- Tác động:
--   * Bảng mới sync_auto_settings (1 dòng) và sync_auto_leases; RLS bật, không policy, chỉ service_role (qua Edge) đọc/ghi.
--   * RPC mới sync_auto_lease / sync_auto_release (chỉ service_role).
--   * group_uid_sync_runs thêm cột source ('manual'|'auto'), device, auto_hold.
--   * sku_sync_runs thêm cột run_source ('manual'|'auto'), device, auto_hold. KHÔNG dùng tên "source" vì bảng này đã có
--     cột source = 'inside-extension' (check cứng, sku_sync_admin_v1.sql); Edge trả run_source ra API dưới tên "source".
--   * Trạng thái mới 'held' cho group_uid_sync_runs và sku_sync_runs: lượt tự động vượt ngưỡng được giữ lại cho Admin xem
--     (status='held', auto_hold = lý do, completed_at = lúc giữ). held là trạng thái kết thúc: không bị ACTIVE_RUN chặn, không hết hạn,
--     Edge từ chối áp dụng (RUN_HELD) — Admin chạy lại tay để có bản xem trước mới. Ràng buộc check của cột status được thay:
--     tên theo khuôn mặc định của Postgres cho check viết liền cột (<bảng>_status_check, từ group_uid_sync_v1.sql / sku_sync_admin_v1.sql);
--     khối kiểm ngay sau đó dừng migration nếu còn ràng buộc status cũ nào không có 'held' (tên thật khác khuôn).
--   * Khoá thuê: holder = tên máy (≤ 60) + "#" + mã máy → giới hạn holder 80 ký tự.
--   * Giãn cách giữa các máy (vòng review 2): sync_auto_leases.last_finished_at = lúc lượt tự động gần nhất kết thúc
--     (hoàn tất hoặc giữ lại, nhả khoá với p_finished = true). sync_auto_lease nhận p_cooldown_seconds: lượt theo lịch gửi
--     nhịp − 2 phút → máy khác không chạy lại cùng loại trong cùng chu kỳ (trả reason COOLDOWN); "Chạy ngay" gửi 0.
--   * sync_history_purge thay bản sync_history_purge_v1.sql (cùng chữ ký, cùng thân): coi 'held' là trạng thái kết thúc như
--     'completed' để changes / payload / pages / staging / dòng lượt held được dọn theo cùng thời hạn. Lịch cron giữ nguyên.
--   * group_uid_sync_prepare đổi sang 5 tham số (thêm p_source, p_device có mặc định); bản 3 tham số bị drop để PostgREST
--     không mơ hồ. Edge cũ gọi bằng 3 tham số có tên vẫn chạy (2 tham số mới có mặc định) → chạy migration trước, deploy Edge sau.
-- Chạy lại nhiều lần được (if not exists / create or replace / on conflict do nothing).
begin;

create table if not exists public.sync_auto_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  interval_minutes integer not null default 30 check (interval_minutes between 15 and 180),
  full_window_start time not null default '00:00',
  full_window_end time not null default '05:00',
  thresholds jsonb not null default '{"group_uid":{"maxChanges":3000,"maxMissing":0,"maxIssues":0},"sku":{"maxUpdated":500,"maxAdded":500,"maxMissing":0,"maxOrphaned":0}}'::jsonb
    check (jsonb_typeof(thresholds) = 'object'),
  updated_by uuid,
  updated_at timestamptz default now()
);
insert into public.sync_auto_settings(singleton) values (true) on conflict (singleton) do nothing;

create table if not exists public.sync_auto_leases (
  kind text primary key check (kind in ('sku','group_uid')),
  holder text,
  run_id uuid,
  leased_until timestamptz,
  updated_at timestamptz,
  last_finished_at timestamptz
);
alter table public.sync_auto_leases add column if not exists last_finished_at timestamptz;

alter table public.sync_auto_settings enable row level security;
alter table public.sync_auto_leases enable row level security;
revoke all on public.sync_auto_settings, public.sync_auto_leases from public, anon, authenticated;
grant select, insert, update, delete on public.sync_auto_settings, public.sync_auto_leases to service_role;

alter table public.group_uid_sync_runs
  add column if not exists source text not null default 'manual' check (source in ('manual','auto')),
  add column if not exists device text check (device is null or char_length(device) <= 60),
  add column if not exists auto_hold text check (auto_hold is null or char_length(auto_hold) <= 300);

alter table public.sku_sync_runs
  add column if not exists run_source text not null default 'manual' check (run_source in ('manual','auto')),
  add column if not exists device text check (device is null or char_length(device) <= 60),
  add column if not exists auto_hold text check (auto_hold is null or char_length(auto_hold) <= 300);

-- Trạng thái 'held' (lượt tự động bị giữ lại chờ Admin).
alter table public.group_uid_sync_runs drop constraint if exists group_uid_sync_runs_status_check;
alter table public.group_uid_sync_runs add constraint group_uid_sync_runs_status_check
  check (status in ('running','previewed','applying','completed','failed','expired','held'));
alter table public.sku_sync_runs drop constraint if exists sku_sync_runs_status_check;
alter table public.sku_sync_runs add constraint sku_sync_runs_status_check
  check (status in ('previewed','applying','completed','failed','held'));
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid in ('public.group_uid_sync_runs'::regclass, 'public.sku_sync_runs'::regclass)
       and contype = 'c'
       and pg_get_constraintdef(oid) ~ '\mstatus\M'
       and pg_get_constraintdef(oid) not like '%held%'
  ) then
    raise exception 'Còn ràng buộc check cột status không có held (tên khác khuôn <bảng>_status_check); kiểm pg_constraint rồi sửa migration';
  end if;
end $$;

-- Khoá thuê: máy nào giành được mới chạy. Hết hạn (leased_until < now()) thì máy khác giành được; cùng máy thuê lại = gia hạn.
-- p_cooldown_seconds > 0 (lượt theo lịch): lượt cùng loại vừa kết thúc chưa quá p_cooldown_seconds → từ chối (COOLDOWN),
-- không đổi người giữ. Máy đang giữ khoá còn hạn gia hạn thì không xét giãn cách.
drop function if exists public.sync_auto_lease(text, text, integer);
create or replace function public.sync_auto_lease(p_kind text, p_holder text, p_ttl_seconds integer default 900,
  p_cooldown_seconds integer default 0)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_holder text := left(btrim(coalesce(p_holder,'')),80);
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds,900),60),3600);
  v_cooldown integer := least(greatest(coalesce(p_cooldown_seconds,0),0),10800);
  v_row public.sync_auto_leases;
begin
  if p_kind is null or p_kind not in ('sku','group_uid') or v_holder = '' then
    raise exception 'INVALID_LEASE';
  end if;
  perform pg_advisory_xact_lock(hashtext('sync_auto_'||p_kind));
  select * into v_row from public.sync_auto_leases where kind = p_kind;
  if found and v_row.holder is not null and v_row.holder <> v_holder
     and v_row.leased_until is not null and v_row.leased_until >= now() then
    return jsonb_build_object('ok',false,'holder',v_row.holder,'leasedUntil',v_row.leased_until);
  end if;
  if v_cooldown > 0 and found and v_row.last_finished_at is not null
     and v_row.last_finished_at > now() - make_interval(secs => v_cooldown)
     and not (v_row.holder is not distinct from v_holder and v_row.leased_until is not null and v_row.leased_until >= now()) then
    return jsonb_build_object('ok',false,'reason','COOLDOWN','lastFinishedAt',v_row.last_finished_at,
      'retryAfter',v_row.last_finished_at + make_interval(secs => v_cooldown));
  end if;
  insert into public.sync_auto_leases(kind,holder,run_id,leased_until,updated_at)
  values (p_kind,v_holder,null,now()+make_interval(secs => v_ttl),now())
  on conflict (kind) do update set
    run_id = case when public.sync_auto_leases.holder = excluded.holder then public.sync_auto_leases.run_id end,
    holder = excluded.holder,
    leased_until = excluded.leased_until,
    updated_at = now()
  returning * into v_row;
  return jsonb_build_object('ok',true,'holder',v_row.holder,'leasedUntil',v_row.leased_until);
end $$;

-- Nhả khoá: chỉ khi đúng máy đang giữ; máy khác gọi nhả không làm gì. p_finished = true (lượt hoàn tất hoặc giữ lại)
-- ghi last_finished_at cho giãn cách giữa các máy; lỗi / bỏ qua thì không ghi.
drop function if exists public.sync_auto_release(text, text);
create or replace function public.sync_auto_release(p_kind text, p_holder text, p_finished boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_holder text := left(btrim(coalesce(p_holder,'')),80);
  v_count integer;
begin
  if p_kind is null or p_kind not in ('sku','group_uid') or v_holder = '' then
    raise exception 'INVALID_LEASE';
  end if;
  perform pg_advisory_xact_lock(hashtext('sync_auto_'||p_kind));
  update public.sync_auto_leases set holder = null, run_id = null, leased_until = null, updated_at = now(),
         last_finished_at = case when coalesce(p_finished,false) then now() else last_finished_at end
   where kind = p_kind and holder = v_holder;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok',true,'released',v_count > 0);
end $$;

-- prepare 5 tham số: thân giữ nguyên group_uid_sync_v1.sql, thêm source/device vào lượt; dọn pages/staging sau 7 ngày tính cả lượt held.
-- held không nằm trong ('running','previewed','applying') nên không chặn lượt mới (ACTIVE_RUN) và không bị đánh expired.
drop function if exists public.group_uid_sync_prepare(text, timestamptz, uuid);
create or replace function public.group_uid_sync_prepare(p_mode text, p_range_to timestamptz, p_created_by uuid,
  p_source text default 'manual', p_device text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_from timestamptz;
  v_run public.group_uid_sync_runs;
  v_source text := coalesce(nullif(btrim(p_source),''),'manual');
  v_device text := nullif(left(btrim(coalesce(p_device,'')),60),'');
begin
  if p_mode not in ('incremental','full') or p_range_to is null or p_created_by is null
     or v_source not in ('manual','auto') then
    raise exception 'INVALID_PREPARE';
  end if;
  update public.group_uid_sync_runs
     set status='expired', completed_at=now(), error_message='Bản xem trước hết hạn sau 30 phút'
   where (status='previewed' and previewed_at < now() - interval '30 minutes')
      or (status='running' and created_at < now() - interval '30 minutes');
  delete from public.group_uid_sync_pages p using public.group_uid_sync_runs r
   where p.run_id=r.id and r.status in ('completed','failed','expired','held') and r.created_at<now()-interval '7 days';
  delete from public.group_uid_sync_staging s using public.group_uid_sync_runs r
   where s.run_id=r.id and r.status in ('completed','failed','expired','held') and r.created_at<now()-interval '7 days';
  if exists(select 1 from public.group_uid_sync_runs where status in ('running','previewed','applying')) then
    raise exception 'ACTIVE_RUN';
  end if;
  select last_successful_incremental_at - interval '30 minutes'
    into v_from from public.group_uid_sync_state where singleton=true;
  if p_mode='incremental' and v_from is null then raise exception 'FULL_REQUIRED'; end if;
  insert into public.group_uid_sync_runs(mode,status,range_from,range_to,created_by,source,device)
  values(p_mode,'running',case when p_mode='incremental' then v_from end,p_range_to,p_created_by,v_source,v_device)
  returning * into v_run;
  return jsonb_build_object('runId',v_run.id,'mode',v_run.mode,'status',v_run.status,
    'rangeFrom',v_run.range_from,'rangeTo',v_run.range_to,'source',v_run.source,'device',v_run.device);
end $$;

revoke all on function public.sync_auto_lease(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.sync_auto_release(text,text,boolean) from public, anon, authenticated;
revoke all on function public.group_uid_sync_prepare(text,timestamptz,uuid,text,text) from public, anon, authenticated;
grant execute on function public.sync_auto_lease(text,text,integer,integer) to service_role;
grant execute on function public.sync_auto_release(text,text,boolean) to service_role;
grant execute on function public.group_uid_sync_prepare(text,timestamptz,uuid,text,text) to service_role;

comment on table public.sync_auto_settings is
  'Cấu hình đồng bộ tự động qua Extension (1 dòng): bật/tắt, nhịp gia tăng, khung giờ toàn bộ (giờ VN), ngưỡng tự áp dụng.';
comment on table public.sync_auto_leases is
  'Khoá thuê theo loại đồng bộ (sku, group_uid) để chỉ một máy chạy tự động tại một thời điểm.';
comment on column public.sku_sync_runs.run_source is
  'manual = Admin bấm trên web, auto = Extension tự chạy. Cột source cũ luôn là inside-extension.';

-- Dọn lịch sử: bản sao nguyên văn sync_history_purge từ sync_history_purge_v1.sql (10/10/2026, cùng chữ ký), chỉ thêm 'held'
-- vào các nhóm trạng thái đã kết thúc: held được đối xử như completed (changes giữ p_keep_changes, payload SKU p_keep_payload,
-- pages/staging xoá ngay, dòng lượt p_keep_runs). Không đổi lịch pg_cron 'sync-history-purge'.
create or replace function public.sync_history_purge(
  p_keep_changes interval default interval '30 days',
  p_keep_runs interval default interval '180 days',
  p_keep_payload interval default interval '1 day',
  p_keep_import_rows interval default interval '7 days'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  n_expired integer; n_failed_changes integer; n_pages integer; n_staging integer; n_old_changes integer;
  n_gu_runs integer; n_sku_payload integer; n_sku_changes integer; n_sku_runs integer;
  n_import_rows integer; n_import_runs integer; n_sku_expired integer; n_import_expired integer; v_result jsonb;
begin
  -- Lượt Group UID kẹt quá 30 phút: hết hạn (cùng quy tắc với group_uid_sync_prepare, để không chờ tới lượt kế tiếp).
  with gone as (
    update public.group_uid_sync_runs
       set status = 'expired', completed_at = v_now, error_message = coalesce(error_message, 'Hết hạn sau 30 phút (dọn định kỳ)')
     where (status = 'previewed' and previewed_at < v_now - interval '30 minutes')
        or (status = 'running' and created_at < v_now - interval '30 minutes')
    returning 1)
  select count(*) into n_expired from gone;

  -- Lượt thất bại / hết hạn: chi tiết không còn giá trị, xoá ngay.
  with gone as (
    delete from public.group_uid_sync_changes c using public.group_uid_sync_runs r
     where c.run_id = r.id and r.status in ('failed', 'expired') returning 1)
  select count(*) into n_failed_changes from gone;
  update public.group_uid_sync_runs set changes_purged_at = v_now
   where status in ('failed', 'expired') and changes_purged_at is null;

  -- Pages / staging chỉ cần trong lúc lượt đang chạy.
  with gone as (
    delete from public.group_uid_sync_pages p using public.group_uid_sync_runs r
     where p.run_id = r.id and r.status in ('completed', 'failed', 'expired', 'held') returning 1)
  select count(*) into n_pages from gone;
  with gone as (
    delete from public.group_uid_sync_staging s using public.group_uid_sync_runs r
     where s.run_id = r.id and r.status in ('completed', 'failed', 'expired', 'held') returning 1)
  select count(*) into n_staging from gone;

  -- Lượt thành công / giữ lại (held, sync_auto_v1): giữ chi tiết cũ→mới p_keep_changes rồi xoá.
  with gone as (
    delete from public.group_uid_sync_changes c using public.group_uid_sync_runs r
     where c.run_id = r.id and r.status in ('completed', 'held')
       and coalesce(r.completed_at, r.created_at) < v_now - p_keep_changes returning 1)
  select count(*) into n_old_changes from gone;
  update public.group_uid_sync_runs set changes_purged_at = v_now
   where status in ('completed', 'held') and changes_purged_at is null
     and coalesce(completed_at, created_at) < v_now - p_keep_changes;

  -- Dòng lượt Group UID quá p_keep_runs (changes/pages/staging còn sót đi theo on delete cascade).
  with gone as (
    delete from public.group_uid_sync_runs
     where status in ('completed', 'failed', 'expired', 'held') and created_at < v_now - p_keep_runs returning 1)
  select count(*) into n_gu_runs from gone;

  -- sku_sync_runs: bản xem trước bỏ dở quá p_keep_payload thì đóng (dữ liệu Inside đã cũ, lượt sau sẽ tạo bản mới);
  -- Edge Function từ chối apply lượt không còn 'previewed', nên không có đường nào nạp nhầm bản cũ.
  with gone as (
    update public.sku_sync_runs
       set status = 'failed', completed_at = v_now, error_message = coalesce(error_message, 'Bản xem trước bỏ dở, đã đóng khi dọn định kỳ')
     where status = 'previewed' and created_at < v_now - p_keep_payload returning 1)
  select count(*) into n_sku_expired from gone;
  -- Payload đã nạp chỉ cần tới lúc apply; chi tiết cũ→mới giữ p_keep_changes.
  with gone as (
    update public.sku_sync_runs
       set staged_skus = '[]'::jsonb, staged_combo_links = '[]'::jsonb, payload_purged_at = v_now
     where status in ('completed', 'failed', 'held') and payload_purged_at is null
       and coalesce(completed_at, created_at) < v_now - p_keep_payload returning 1)
  select count(*) into n_sku_payload from gone;
  with gone as (
    update public.sku_sync_runs
       set changes = '{}'::jsonb, changes_purged_at = v_now
     where status in ('completed', 'failed', 'held') and changes_purged_at is null
       and coalesce(completed_at, created_at) < v_now - p_keep_changes returning 1)
  select count(*) into n_sku_changes from gone;
  with gone as (
    delete from public.sku_sync_runs
     where status in ('completed', 'failed', 'held') and created_at < v_now - p_keep_runs returning 1)
  select count(*) into n_sku_runs from gone;

  -- Nạp Excel (màn web đã bỏ 07/10/2026; script CLI còn dùng bảng): lượt bỏ dở (uploading/validated/applying)
  -- quá p_keep_import_rows thì đóng — không còn màn nào tiếp tục được lượt đó.
  with gone as (
    update public.group_uid_import_runs
       set status = 'failed', completed_at = v_now, error_message = coalesce(error_message, 'Lượt nạp bỏ dở, đã đóng khi dọn định kỳ')
     where status in ('uploading', 'validated', 'applying') and created_at < v_now - p_keep_import_rows returning 1)
  select count(*) into n_import_expired from gone;
  -- Dòng của lượt đã kết thúc quá p_keep_import_rows.
  with gone as (
    delete from public.group_uid_import_rows r using public.group_uid_import_runs h
     where r.run_id = h.id and h.status in ('completed', 'failed')
       and h.created_at < v_now - p_keep_import_rows returning 1)
  select count(*) into n_import_rows from gone;
  with gone as (
    delete from public.group_uid_import_runs h
     where h.status in ('completed', 'failed') and h.created_at < v_now - p_keep_runs
       and not exists (select 1 from public.group_uid_import_rows r where r.run_id = h.id) returning 1)
  select count(*) into n_import_runs from gone;

  v_result := jsonb_build_object('ok', true, 'at', v_now,
    'groupUid', jsonb_build_object('expiredRuns', n_expired, 'failedChanges', n_failed_changes, 'pages', n_pages,
                                   'staging', n_staging, 'oldChanges', n_old_changes, 'runs', n_gu_runs,
                                   'remainingChanges', (select count(*) from public.group_uid_sync_changes)),
    'sku', jsonb_build_object('expiredPreviews', n_sku_expired, 'payloads', n_sku_payload, 'changes', n_sku_changes,
                              'runs', n_sku_runs, 'remainingRuns', (select count(*) from public.sku_sync_runs)),
    'import', jsonb_build_object('expiredRuns', n_import_expired, 'rows', n_import_rows, 'runs', n_import_runs,
                                 'remainingRows', (select count(*) from public.group_uid_import_rows)));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('sync_history_purge', v_now, v_result, v_now)
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end$$;
revoke all on function public.sync_history_purge(interval, interval, interval, interval) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
