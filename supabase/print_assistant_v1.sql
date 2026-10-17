-- TRỢ LÝ IN (17/10/2026): nhật ký câu nói của Admin gửi Edge Function print-assistant.
--
-- Vì sao: trợ lý trong trang Print SKU tách ý định "in tem SKU theo phiếu IT" bằng mô hình Anthropic (khoá chỉ ở
-- Secrets của Edge). Cần lưu câu nói + ý định đã tách + số token để soát lại khi trợ lý hiểu sai và theo dõi chi phí.
-- Tác động:
--   * Thêm bảng public.print_assistant_log. RLS bật, KHÔNG có policy, chỉ service_role (Edge) ghi/đọc;
--     anon/authenticated không đọc được. Không chứa token; câu nói đã cắt ≤ 300 ký tự ở Edge.
--   * Hàm public.print_assistant_purge(p_keep) xoá dòng cũ hơn p_keep (mặc định 90 ngày, tối thiểu 1 ngày),
--     ghi kết quả vào print_maintenance (tạo nếu chưa có, cùng khuôn sync_history_purge_v1).
--   * pg_cron 'print-assistant-purge' 20:50 UTC (03:50 giờ VN) mỗi ngày, sau sync-history-purge 20 phút.
--     Không đụng các lịch cron hay bảng hiện có.
-- Chạy lại được (idempotent).

begin;

create table if not exists public.print_assistant_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  user_email text,
  message text,
  intent text,
  it_number text,
  copies integer,
  reply text,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);
create index if not exists print_assistant_log_created_at_idx on public.print_assistant_log (created_at);

alter table public.print_assistant_log enable row level security;
revoke all on table public.print_assistant_log from public, anon, authenticated;
grant select, insert, delete on table public.print_assistant_log to service_role;

create table if not exists public.print_maintenance (
  task text primary key,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.print_assistant_purge(p_keep interval default interval '90 days')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_keep interval := greatest(coalesce(p_keep, interval '90 days'), interval '1 day');
  n_deleted integer;
  v_result jsonb;
begin
  with gone as (
    delete from public.print_assistant_log where created_at < v_now - v_keep returning 1)
  select count(*) into n_deleted from gone;
  v_result := jsonb_build_object('ok', true, 'at', v_now, 'keep', v_keep::text, 'deleted', n_deleted,
                                 'remaining', (select count(*) from public.print_assistant_log));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('print_assistant_purge', v_now, v_result, v_now)
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end$$;
revoke all on function public.print_assistant_purge(interval) from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
-- 20:50 UTC = 03:50 giờ VN. Cùng tên thì pg_cron cập nhật lịch cũ (chạy lại tệp không tạo lịch trùng).
select cron.schedule('print-assistant-purge', '50 20 * * *', $$select public.print_assistant_purge()$$);

notify pgrst, 'reload schema';

commit;
