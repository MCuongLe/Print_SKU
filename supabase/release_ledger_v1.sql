-- Sổ phát hành (26/10/2026, scripts/release.py mô hình A, kế hoạch docs/plans/2026-10-26-release-script.md).
-- Vì sao: thứ tự lên (migration → deploy Edge → Reload Extension → push web, AGENTS luật 4) đang làm tay; không có chỗ ghi tệp
--   migration nào đã chạy, Edge nào đã deploy từ nguồn nào, bản Extension nào đã Reload. release.py đọc sổ này để tính việc chờ
--   và giữ khoá để chỉ một máy phát hành tại một thời điểm.
-- Tác động:
--   * Bảng mới release_ledger, khoá chính (kind, name): kind ∈ migration | edge | extension | lock; sha256 = hex 64 ký tự của nội
--     dung đã đổi CRLF → LF (null cho khoá); commit_sha = HEAD rút gọn; applied_by = tên máy + "#" + mã ngẫu nhiên;
--     note = bản Edge / Extension.
--   * Dòng kind = lock, name = release là khoá phát hành, hạn 30 phút kể từ applied_at (release.py gia hạn ở mỗi bước).
--   * RLS bật, không policy, chỉ service_role; release.py đọc / ghi qua Management API. Không thay hàm nào, không xoá dữ liệu;
--     chạy lại nhiều lần được (if not exists).
-- Lệnh: python scripts/release.py --init (chạy tệp này, rồi ghi nhận các tệp migration và Edge hiện có; gõ SEED để xác nhận).
-- kiem: select coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.release_ledger')), false) as ok
-- Rút lui (chỉ khi bỏ release.py; mất sổ thì --init lại):
--   drop table if exists public.release_ledger;
begin;

create table if not exists public.release_ledger (
  kind text not null check (kind in ('migration', 'edge', 'extension', 'lock')),
  name text not null check (char_length(name) between 1 and 200),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,40}$'),
  applied_at timestamptz not null default now(),
  applied_by text check (applied_by is null or char_length(applied_by) <= 120),
  note text check (note is null or char_length(note) <= 500),
  primary key (kind, name)
);

alter table public.release_ledger enable row level security;
revoke all on public.release_ledger from public, anon, authenticated;
grant select, insert, update, delete on public.release_ledger to service_role;

comment on table public.release_ledger is
  'Sổ phát hành của scripts/release.py: migration / edge / extension đã lên (sha256 nội dung CRLF→LF, commit, máy, giờ, bản) và khoá phát hành (kind lock, name release, hạn 30 phút). Chỉ service_role.';

notify pgrst, 'reload schema';
commit;
