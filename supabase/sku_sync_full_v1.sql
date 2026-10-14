-- Đồng bộ SKU: chế độ "Đối chiếu toàn bộ" (14/10/2026).
-- Lượt gia tăng chỉ đọc SKU có Modified mới hơn mốc; lượt toàn bộ đọc hết Inside để so với cả bảng SKU_Name
-- (bắt SKU đổi mà Modified không đổi, SKU không còn trên Inside, lệch do nguồn ghi khác, và nạp bù SKU ngừng hoạt động).
--   * sku_sync_runs.mode: 'incremental' (mặc định, lượt cũ giữ nguyên) | 'full'.
--   * Trần dòng chờ ghi 2.000 → 30.000: lượt toàn bộ đầu tiên có thể thêm vài nghìn SKU ngừng hoạt động
--     và các quan hệ Combo trước đây bị loại vì thiếu SKU. Edge Function vẫn giữ 2.000 cho lượt gia tăng.
begin;

alter table public.sku_sync_runs
  add column if not exists mode text not null default 'incremental';

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.sku_sync_runs'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) like '%jsonb_array_length(staged_skus)%'
         or pg_get_constraintdef(oid) like '%jsonb_array_length(staged_combo_links)%'
         or conname = 'sku_sync_runs_mode_check')
  loop
    execute format('alter table public.sku_sync_runs drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.sku_sync_runs
  add constraint sku_sync_runs_mode_check check (mode in ('incremental', 'full')),
  add constraint sku_sync_runs_staged_skus_limit check (jsonb_array_length(staged_skus) <= 30000),
  add constraint sku_sync_runs_staged_links_limit check (jsonb_array_length(staged_combo_links) <= 30000);

-- Mốc "Toàn bộ gần nhất" cho dải thông tin và chốt chặn giảm bất thường: chỉ cần lượt toàn bộ đã hoàn tất.
create index if not exists sku_sync_runs_full_done_idx
  on public.sku_sync_runs (completed_at desc)
  where mode = 'full' and status = 'completed';

comment on column public.sku_sync_runs.mode is
  'incremental: SKU có Modified mới hơn mốc (mặc định); full: đọc hết Inside, so với cả bảng SKU_Name, báo SKU không còn trên Inside (không xoá).';

commit;
