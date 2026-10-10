-- Bỏ 6 index chưa từng (hoặc gần như chưa) được dùng (10/10/2026, sau rà soát index theo thống kê
-- pg_stat_user_indexes từ 25/08/2026). Không index nào gắn ràng buộc; đã kiểm hàm RPC, Edge Function,
-- script và lời gọi REST trong repo: không chỗ nào lọc theo đúng các cột này.
--
--   group_uid_details_location_idx (warehouse, location)   856 kB   2 lần dùng
--   group_uid_details_status_idx   (status)                 784 kB  11 lần dùng
--   group_uid_products_sku_idx     (sku)                    264 kB   2 lần dùng
--   wms_group_uid_cuts_cut_at_idx  (cut_at desc)             56 kB   1 lần dùng (đối chiếu tra theo khoá chính)
--   xa_vai_log_sku_idx             (sku, started_at desc)    16 kB   0 lần (tìm bằng ilike '%…%', không dùng được)
--   cut_group_uid_deletions_code_idx (group_uid_code, deleted_at desc)  8 kB  0 lần (bảng chỉ ghi, chưa đọc)
--
-- Lợi ích chính: mỗi lượt đồng bộ WMS ghi ~28.000 dòng group_uid_details không phải cập nhật thêm 2 index.
-- Giữ nguyên: group_uid_details_sku_idx (1.095 lần dùng, tab Đối chiếu lọc theo SKU), các index unique/khoá chính.
-- Cần thêm lại khi có màn tra theo vị trí kho hoặc theo trạng thái Group UID.

drop index if exists public.group_uid_details_location_idx;
drop index if exists public.group_uid_details_status_idx;
drop index if exists public.group_uid_products_sku_idx;
drop index if exists public.wms_group_uid_cuts_cut_at_idx;
drop index if exists public.xa_vai_log_sku_idx;
drop index if exists public.cut_group_uid_deletions_code_idx;
