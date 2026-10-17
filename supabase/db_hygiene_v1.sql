-- Vệ sinh database theo Supabase advisors (17/10/2026, mức INFO, không đổi hành vi ứng dụng).
-- 1) Hai khoá ngoại chưa có index → thêm index để xoá/cập nhật bảng cha không quét toàn bảng con.
-- 2) sku_archive chưa có khoá chính → nâng unique index (sku, archived_at) có sẵn thành primary key.
--    Không dùng cột id: id chép từ SKU_Name nên một SKU lưu trữ nhiều lần (giữ lịch sử, sku_missing_archive_v1) sẽ trùng id.
--    Đo trước khi viết: 2.370 dòng, sku/archived_at NOT NULL, không trùng (sku, archived_at).
begin;
create index if not exists print_devices_activation_code_id_idx on public.print_devices (activation_code_id);
create index if not exists wms_group_uid_cuts_import_id_idx on public.wms_group_uid_cuts (import_id);
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sku_archive'::regclass and contype = 'p') then
    alter table public.sku_archive add constraint sku_archive_pkey primary key using index sku_archive_sku_idx;
  end if;
end $$;
commit;
