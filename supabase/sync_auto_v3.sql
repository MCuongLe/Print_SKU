-- Đồng bộ tự động qua Extension, bản 3 (26/10/2026, Extension 0.10.10): ghi nhận bản Extension của từng máy và cổng bản tối thiểu.
-- Vì sao: nhiều Admin đồng bộ bằng các bản Extension khác nhau (nạp tay, không tự cập nhật). Bản cũ có thể đọc sai mà vẫn ghi
--   (kế hoạch docs/plans/2026-10-26-nhieu-admin-khac-ban-extension.md, kiểu hỏng A–E). Server chưa biết máy nào đang ở bản nào và
--   không có chỗ đặt mức tối thiểu. Từ 0.10.10 Extension (và web) gửi extVersion cho Edge sku-sync / group-uid-sync.
-- Tác động:
--   * Bảng mới sync_auto_devices (1 dòng / holder = tên máy + "#" + mã máy): device, ext_version (null = chưa khai báo), first_seen_at,
--     last_seen_at, last_kind. RLS bật, không policy, chỉ service_role (Edge ghi ở lease / preview / prepare, đọc cho auto-config).
--   * sku_sync_runs.ext_version, group_uid_sync_runs.ext_version (null cho mọi lượt cũ và lượt không khai báo bản).
--   * sync_auto_settings.min_extension jsonb {"sku","group_uid","cut_adj","storage_risk"} → "x.y.z"; mặc định {} = KHÔNG chặn loại nào.
--     Mức sai dạng (giá trị không phải "x.y.z" hay null, mảng, số, khoá lồng) hoặc khoá lạ (gõ sai tên loại, vd. "skus") bị CHECK từ chối
--     ngay khi update, không còn bỏ qua lặng.
--     Edge chặn 409 EXTENSION_OUTDATED khi bản gửi lên thấp hơn hoặc chưa khai báo (lượt tự động lẫn lượt tay). Edge không cho đổi
--     min_extension (auto-config chỉ nhận enabled / intervalMinutes): mức tối thiểu chỉ đặt bằng SQL tay bên dưới.
--   * Không thay hàm nào (sync_auto_lease / sync_auto_release giữ nguyên), không xoá dữ liệu; chạy lại nhiều lần được (if not exists).
-- Lệnh (không có DROP / DELETE nên không cần cờ):
--   python scripts/apply_supabase_sql.py supabase/sync_auto_v3.sql
-- Thứ tự lên: migration này → python scripts/deploy_sku_sync.py và python scripts/deploy_group_uid_sync.py → Reload Extension 0.10.10
--   mọi máy Admin (tải lại tab Inside / WMS) → push web. Edge mới mà chưa chạy migration vẫn chạy như cũ (ghi nhận máy bị bỏ qua).
-- Nâng mức tối thiểu (bước 2, chỉ khi bảng máy cho thấy mọi máy thấy trong 7 ngày đã khai báo ≥ 0.10.10):
--   update public.sync_auto_settings set min_extension = '{"sku":"0.10.10","group_uid":"0.10.10","cut_adj":"0.10.10","storage_risk":"0.10.10"}';
-- Rút lui (cổng mở lại ngay, không cần deploy):
--   update public.sync_auto_settings set min_extension = '{}';
begin;

create table if not exists public.sync_auto_devices (
  holder text primary key check (char_length(holder) between 1 and 80),
  device text not null check (char_length(device) <= 60),
  ext_version text check (ext_version is null or char_length(ext_version) <= 20),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_kind text check (last_kind is null or last_kind in ('sku','group_uid','cut_adj','storage_risk'))
);

alter table public.sync_auto_devices enable row level security;
revoke all on public.sync_auto_devices from public, anon, authenticated;
grant select, insert, update, delete on public.sync_auto_devices to service_role;

alter table public.sku_sync_runs
  add column if not exists ext_version text check (ext_version is null or char_length(ext_version) <= 20);
alter table public.group_uid_sync_runs
  add column if not exists ext_version text check (ext_version is null or char_length(ext_version) <= 20);

alter table public.sync_auto_settings
  add column if not exists min_extension jsonb not null default '{}'::jsonb
    check (jsonb_typeof(min_extension) = 'object'
      and not jsonb_path_exists(min_extension, 'strict $.* ? (@.type() != "null" && (@.type() != "string" || !(@ like_regex "^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$")))')
      and not jsonb_path_exists(min_extension, 'strict $.keyvalue() ? (@.key != "sku" && @.key != "group_uid" && @.key != "cut_adj" && @.key != "storage_risk")'));

comment on table public.sync_auto_devices is
  'Máy đồng bộ (Extension): holder = tên máy + "#" + mã máy, bản Extension khai báo (null = chưa khai báo), lần đầu / lần cuối thấy, loại gần nhất. Edge sku-sync / group-uid-sync ghi ở lease, preview, prepare.';
comment on column public.sync_auto_settings.min_extension is
  'Bản Extension tối thiểu theo loại {"sku","group_uid","cut_adj","storage_risk"} → "x.y.z" hoặc null; loại vắng khoá hoặc {} = không chặn loại đó; giá trị sai dạng hoặc khoá lạ bị CHECK từ chối. Chỉ đặt bằng SQL tay.';
comment on column public.sku_sync_runs.ext_version is
  'Bản Extension khai báo khi tạo lượt (Extension / web từ 0.10.10); null = chưa khai báo hoặc lượt cũ.';
comment on column public.group_uid_sync_runs.ext_version is
  'Bản Extension khai báo khi tạo lượt (Extension / web từ 0.10.10); null = chưa khai báo hoặc lượt cũ.';

notify pgrst, 'reload schema';
commit;
