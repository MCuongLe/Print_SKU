-- Dọn index bảng SKU_Name + dựng lại index staging (08/10/2026, sau đánh giá database).
--
-- Hiện trạng đo trên Supabase thật (pg_stat_user_indexes, thống kê từ 25/08/2026):
--   * Ba index UNIQUE trùng nhau trên cột sku: "SKU_Name_sku_key" (ràng buộc gốc, 452k lần dùng),
--     sku_name_sku_uniq (ràng buộc thêm sau, 14k) và "SKU_Name_sku_unique" (index rời, 33k).
--     Mỗi lần đồng bộ SKU phải ghi cả ba, tốn ~2,8 MB. Chỉ cần một.
--   * sku_name_ten là GIN to_tsvector(product_name), nặng 6 MB nhưng 0 lần dùng vì web tìm tên
--     bằng `product_name ilike '%...%'`. Truy vấn đó là truy vấn chậm nhất với người dùng:
--     2.486 lần, trung bình 115 ms, quét toàn bảng 21.865 dòng.
--     Thử trong giao dịch tự huỷ: index GIN pg_trgm đưa cùng truy vấn từ 70 ms xuống 1,4 ms
--     (Bitmap Index Scan). pg_trgm có sẵn trên Supabase, cài vào schema extensions.
--   * group_uid_sync_staging: heap 0 byte nhưng index khoá chính còn 3,4 MB (xoá theo run_id
--     rồi nạp lại nhiều lần). REINDEX cho gọn; bảng trống nên khoá không ảnh hưởng ai.
--
-- Giữ nguyên: "SKU_Name_sku_key" (ON CONFLICT(sku) của script đồng bộ vẫn dùng được),
-- "SKU_Name_pkey", sku_name_tien_to (tìm theo tiền tố sku, 10,8k lần dùng), RLS và grant.
-- Không có khoá ngoại nào trỏ tới SKU_Name (đã kiểm tra pg_constraint) nên bỏ ràng buộc an toàn.

create extension if not exists pg_trgm with schema extensions;

-- Tạo index mới trước, bỏ index cũ sau: nếu tạo lỗi thì bảng vẫn còn nguyên index.
create index if not exists sku_name_ten_trgm
  on public."SKU_Name" using gin (product_name extensions.gin_trgm_ops);

drop index if exists public.sku_name_ten;

alter table public."SKU_Name" drop constraint if exists sku_name_sku_uniq;
drop index if exists public."SKU_Name_sku_unique";

reindex index public.group_uid_sync_staging_pkey;

analyze public."SKU_Name";
