-- SKU rời nhóm đồng bộ → tự lưu trữ (17/10/2026).
-- Vì sao: lượt Đối chiếu toàn bộ SKU so cả bảng SKU_Name với 7 nhóm Inside đang đồng bộ; SKU còn trong database mà Inside không
-- còn trả về (chuyển sang nhóm khác như 942 "Thời trang (Bán thành phẩm)", hoặc bị xoá) trước đây chỉ được báo "Thiếu trên Inside"
-- và làm lượt toàn bộ tự động bị giữ lại (ngưỡng maxMissing = 0; sự kiện thật 12:47 17/10/2026 vì 1 SKU chuyển nhóm).
-- Người dùng chốt 17/10/2026: lượt toàn bộ (tay lẫn tự động) tự lưu trữ những SKU này như đã làm tay hôm 14/10 (bảng sku_archive),
-- lượt tự động chỉ giữ lại khi thiếu > 20 mã một lượt.
-- Tác động:
--   1. sku_sync_runs thêm cột staged_missing_skus (jsonb, NULL = lượt cũ / gia tăng): danh sách đầy đủ SKU thiếu lúc xem trước
--      [{sku, product_name, category_name, status}], Edge sku-sync dùng khi áp dụng lượt toàn bộ. Dọn cùng payload.
--      Thêm missing_sku_codes text[] (mọi mã SKU thiếu lúc xem trước lượt toàn bộ) và archive_kept_codes text[] (mọi mã bị giữ lại
--      khi lưu trữ): chỉ mã, đầy đủ (không cắt 1.000 như changes), KHÔNG dọn cùng payload/changes. Edge tính skuMissingNew = SKU thiếu
--      lần này trừ hai danh sách của lượt toàn bộ hoàn tất gần nhất (ngưỡng tự động 20 tính trên SKU thiếu mới).
--   2. RPC mới sku_archive_missing(p_skus, p_reason default 'left_sync_scope') — chỉ service_role (Edge): mỗi SKU còn trong
--      SKU_Name, nếu qua đủ 4 điều kiện bảo vệ như sku_inactive_archive (sku_inactive_v1.sql: không còn Group UID
--      Available/New/Processing, không trong Combo Active, không ở phiên xả vải đang mở, không cắt trong 90 ngày) thì chép sang
--      sku_archive (archive_reason = p_reason) rồi xoá khỏi SKU_Name; không qua thì giữ, trả lý do ngắn. Giữ lịch sử lưu trữ:
--      dòng sku_archive cũ cùng SKU (inactive, moved_category, lần rời nhóm trước) không bị xoá; khoá duy nhất (sku, archived_at)
--      cho phép nhiều dòng cùng SKU.
--      SKU quay lại 7 nhóm thì lượt đồng bộ sau thêm lại như SKU mới (dòng sku_archive vẫn còn làm lịch sử).
--   3. sync_auto_settings.thresholds.sku.maxMissing: 0 → 20 (dòng hiện có + mặc định cột).
--   4. sync_history_purge thay bản trong sync_auto_v1.sql (cùng chữ ký, thân y hệt) chỉ thêm staged_missing_skus = null ở bước
--      dọn payload SKU. Lịch pg_cron 'sync-history-purge' giữ nguyên.
-- Thứ tự lên: (1) chạy migration này → (2) deploy Edge sku-sync (Edge mới ghi staged_missing_skus; chạy trên database chưa có
-- cột sẽ lỗi khi lưu bản xem trước) → (3) web. Edge cũ vẫn chạy được sau migration (cột mới để NULL, không lưu trữ).
-- Chạy lại nhiều lần được (if not exists / create or replace / jsonb_set).
-- Chạy: python scripts/apply_supabase_sql.py supabase/sku_missing_archive_v1.sql
begin;

alter table public.sku_sync_runs add column if not exists staged_missing_skus jsonb;
alter table public.sku_sync_runs add column if not exists missing_sku_codes text[]
  check (missing_sku_codes is null or cardinality(missing_sku_codes) <= 30000);
alter table public.sku_sync_runs add column if not exists archive_kept_codes text[]
  check (archive_kept_codes is null or cardinality(archive_kept_codes) <= 30000);
comment on column public.sku_sync_runs.missing_sku_codes is
  'Lượt toàn bộ: mọi mã SKU có trong SKU_Name mà Inside không trả về lúc xem trước (đầy đủ, không bị dọn). Dùng tính skuMissingNew ở lượt sau.';
comment on column public.sku_sync_runs.archive_kept_codes is
  'Lượt toàn bộ đã áp dụng: mọi mã SKU rời nhóm bị giữ lại khi lưu trữ (còn Group UID / Combo Active / xả vải / mới cắt). Không bị dọn.';
-- Ràng buộc thêm một lần (chạy lại không DROP): mảng hoặc NULL, tối đa 30.000 dòng như staged_skus (sku_sync_full_v1.sql).
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sku_sync_runs'::regclass and conname = 'sku_sync_runs_staged_missing_skus_check') then
    alter table public.sku_sync_runs add constraint sku_sync_runs_staged_missing_skus_check
      check (staged_missing_skus is null or (jsonb_typeof(staged_missing_skus) = 'array' and jsonb_array_length(staged_missing_skus) <= 30000));
  end if;
end $$;
comment on column public.sku_sync_runs.staged_missing_skus is
  'Lượt toàn bộ: danh sách đầy đủ SKU có trong SKU_Name mà Inside không còn trả về lúc xem trước; áp dụng thì lưu trữ qua sku_archive_missing. Dọn cùng staged_skus.';

-- Lưu trữ SKU rời nhóm đồng bộ (chỉ Edge sku-sync gọi bằng service_role, sau khi ghi xong lượt toàn bộ).
create or replace function public.sku_archive_missing(p_skus text[], p_reason text default 'left_sync_scope')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'left_sync_scope'), 40);
  v_sku text;
  v_kept_reason text;
  v_archived text[] := '{}';
  v_kept jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_skus), 0) > 30000 then
    raise exception 'TOO_MANY_SKUS';
  end if;
  for v_sku in
    select distinct btrim(x) from unnest(coalesce(p_skus, '{}')) x where nullif(btrim(x), '') is not null order by 1
  loop
    -- Khoá dòng SKU để lượt khác không ghi chen giữa lúc kiểm và lúc chuyển; SKU không còn trong bảng thì bỏ qua.
    perform 1 from public."SKU_Name" s where s.sku = v_sku for update;
    if not found then continue; end if;
    v_kept_reason := case
      when exists (select 1 from public.group_uid_details g where g.sku = v_sku and g.status in ('Available','New','Processing')) then 'còn Group UID'
      when exists (select 1 from public.sku_combo_links l where l.combo_status = 'Active' and (l.combo_sku = v_sku or l.normal_sku = v_sku)) then 'còn combo'
      when exists (select 1 from public.xa_vai_log x where x.sku = v_sku and x.ended_at is null) then 'đang xả vải'
      when exists (select 1 from public.cut_group_uids c where c.sku = v_sku and c.cut_at > now() - interval '90 days') then 'mới cắt'
    end;
    if v_kept_reason is not null then
      v_kept := v_kept || jsonb_build_array(jsonb_build_object('sku', v_sku, 'reason', v_kept_reason));
      continue;
    end if;
    insert into public.sku_archive select s.*, now(), v_reason from public."SKU_Name" s where s.sku = v_sku;
    delete from public."SKU_Name" s where s.sku = v_sku;
    v_archived := v_archived || v_sku;
  end loop;
  return jsonb_build_object('archived', cardinality(v_archived), 'archivedSkus', to_jsonb(v_archived),
                            'kept', jsonb_array_length(v_kept), 'keptSkus', v_kept);
end $$;
revoke all on function public.sku_archive_missing(text[], text) from public, anon, authenticated;
grant execute on function public.sku_archive_missing(text[], text) to service_role;

-- Ngưỡng tự động: lượt toàn bộ tự động chỉ giữ lại khi > 20 SKU rời nhóm một lượt.
alter table public.sync_auto_settings alter column thresholds set default
  '{"group_uid":{"maxChanges":3000,"maxMissing":0,"maxIssues":0},"sku":{"maxUpdated":500,"maxAdded":500,"maxMissing":20,"maxOrphaned":0}}'::jsonb;
update public.sync_auto_settings
   set thresholds = jsonb_set(case when jsonb_typeof(thresholds->'sku') = 'object' then thresholds
                                   else jsonb_set(thresholds, '{sku}', '{}'::jsonb) end,
                              '{sku,maxMissing}', '20'::jsonb),
       updated_at = now()
 where singleton;

-- Dọn lịch sử: bản sao nguyên văn sync_history_purge từ sync_auto_v1.sql (17/10/2026, cùng chữ ký), chỉ thêm
-- staged_missing_skus = null ở bước dọn payload SKU (sku_missing_archive_v1). Không đổi lịch pg_cron 'sync-history-purge'.
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
       set staged_skus = '[]'::jsonb, staged_combo_links = '[]'::jsonb, staged_missing_skus = null, payload_purged_at = v_now
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
