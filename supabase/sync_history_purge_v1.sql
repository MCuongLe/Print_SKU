-- Dọn lịch sử đồng bộ (10/10/2026). Sau rà soát database: group_uid_sync_changes tăng 4,3 MB trong 3 ngày
-- (lượt thất bại giữ 1.810 dòng / 1,5 MB mãi mãi), sku_sync_runs giữ nguyên payload 40 kB mỗi lượt,
-- group_uid_import_rows còn 24.881 dòng từ 25/09 vì chỉ được dọn khi có lượt nạp Excel mới (màn đó đã bỏ 07/10).
-- group_uid_sync_prepare đã hết hạn lượt kẹt sau 30 phút và dọn pages/staging sau 7 ngày, nhưng KHÔNG dọn changes.
--
-- Chính sách (một hàm, pg_cron gọi mỗi ngày 03:30 giờ VN, kết quả ghi vào print_maintenance):
--   * Lượt Group UID thất bại / hết hạn: xoá ngay changes, pages, staging; giữ dòng lượt (error_message) để xem lịch sử.
--   * Lượt Group UID thành công: giữ chi tiết cũ→mới 30 ngày rồi xoá, ghi changes_purged_at; change_counts trong dòng lượt
--     vẫn còn nên dashboard vẫn đếm được số thêm/cập nhật/thiếu.
--   * sku_sync_runs: 1 ngày sau khi kết thúc xoá staged_skus / staged_combo_links (chỉ cần tới lúc apply), ghi payload_purged_at;
--     30 ngày sau xoá `changes` (chi tiết cũ→mới), ghi changes_purged_at.
--   * group_uid_import_rows: xoá dòng của lượt nạp đã kết thúc quá 7 ngày (cùng quy tắc với group_uid_import_start).
--   * Dòng lượt (runs) của cả ba loại: xoá sau 180 ngày.
-- Không đụng tới dữ liệu chính (group_uid_details, group_uid_products, SKU_Name, sku_combo_links) hay lượt đang chạy.

begin;

alter table public.group_uid_sync_runs add column if not exists changes_purged_at timestamptz;
alter table public.sku_sync_runs add column if not exists payload_purged_at timestamptz;
alter table public.sku_sync_runs add column if not exists changes_purged_at timestamptz;

create table if not exists public.print_maintenance (
  task text primary key,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

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
     where p.run_id = r.id and r.status in ('completed', 'failed', 'expired') returning 1)
  select count(*) into n_pages from gone;
  with gone as (
    delete from public.group_uid_sync_staging s using public.group_uid_sync_runs r
     where s.run_id = r.id and r.status in ('completed', 'failed', 'expired') returning 1)
  select count(*) into n_staging from gone;

  -- Lượt thành công: giữ chi tiết cũ→mới p_keep_changes rồi xoá.
  with gone as (
    delete from public.group_uid_sync_changes c using public.group_uid_sync_runs r
     where c.run_id = r.id and r.status = 'completed'
       and coalesce(r.completed_at, r.created_at) < v_now - p_keep_changes returning 1)
  select count(*) into n_old_changes from gone;
  update public.group_uid_sync_runs set changes_purged_at = v_now
   where status = 'completed' and changes_purged_at is null
     and coalesce(completed_at, created_at) < v_now - p_keep_changes;

  -- Dòng lượt Group UID quá p_keep_runs (changes/pages/staging còn sót đi theo on delete cascade).
  with gone as (
    delete from public.group_uid_sync_runs
     where status in ('completed', 'failed', 'expired') and created_at < v_now - p_keep_runs returning 1)
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
     where status in ('completed', 'failed') and payload_purged_at is null
       and coalesce(completed_at, created_at) < v_now - p_keep_payload returning 1)
  select count(*) into n_sku_payload from gone;
  with gone as (
    update public.sku_sync_runs
       set changes = '{}'::jsonb, changes_purged_at = v_now
     where status in ('completed', 'failed') and changes_purged_at is null
       and coalesce(completed_at, created_at) < v_now - p_keep_changes returning 1)
  select count(*) into n_sku_changes from gone;
  with gone as (
    delete from public.sku_sync_runs
     where status in ('completed', 'failed') and created_at < v_now - p_keep_runs returning 1)
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

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
-- 20:30 UTC = 03:30 giờ VN, sau print-jobs-purge 30 phút. Cùng tên thì pg_cron cập nhật lịch cũ.
select cron.schedule('sync-history-purge', '30 20 * * *', $$select public.sync_history_purge()$$);

commit;
