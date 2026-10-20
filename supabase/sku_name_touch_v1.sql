-- Đóng dấu updated_at của SKU_Name bằng giờ database (19/10/2026).
--
-- Vì sao: danh mục SKU trên máy (khối sku-catalog-script, Tìm SKU / In tem SKU / Chuyển đổi đơn vị / Gán tự động) hỏi phần đổi theo
-- `updated_at > maxUpdatedAt` của bản đang giữ (sku_catalog_changes, snapshot_cache_v1.sql). Trước đây Edge sku-sync tự đặt `updated_at = now`
-- (giờ Edge) cho MỌI mẻ 400 dòng của một lượt: máy kiểm phiên bản đúng lúc giữa hai mẻ nhận maxUpdatedAt = now, các mẻ sau cùng mốc
-- (không lớn hơn) nên bị bỏ sót tới lần tải toàn bộ 12 giờ; ngày 14/10 có lượt 612 dòng = 2 mẻ. Ngoài ra updated_at theo giờ Edge còn
-- inactive_since / archived_at theo giờ database; và đường sửa tên khác (SQL tay, màn Admin sau này) không đổi updated_at thì máy không
-- bao giờ biết tên đã đổi (co-van Fable đã phải dựa vào giả định "mọi đường đổi tên đều qua sku-sync").
--
-- Trigger BEFORE INSERT OR UPDATE từng dòng:
--   * thêm dòng, hoặc 1 trong 5 cột dữ liệu đổi (sku, product_name, category_id, category_name, status — các trường sku-sync so, cộng mã)
--     → updated_at = clock_timestamp(): giờ database tại lúc ghi TỪNG dòng, nên trong MỘT đường ghi nối tiếp (các mẻ của một lượt sku-sync,
--     rồi sku_archive_missing) mẻ sau luôn lớn hơn mẻ trước;
--   * ghi lại y nguyên (upsert trùng dữ liệu) → giữ updated_at cũ, không đẩy dòng vào phần đổi.
-- updated_at Edge gửi lên bị thay. Nơi đọc SKU_Name.updated_at (grep 19/10/2026): sku_catalog_changes (cache web) và agent máy trạm
-- workstation-agent/src/sku-catalog.mjs (so max(updated_at) BẰNG NHAU để biết khi nào tải lại danh mục đo chữ) — cả hai đúng với trigger;
-- ai sửa trigger sau này (ví dụ bỏ đóng dấu khi đổi tên) phải xét cả hai.
-- Rủi ro còn lại (review 19/10, chấp nhận): hai đường ghi CHẠY ĐỒNG THỜI (Admin đồng bộ tay chen lượt tự động, SQL tay) có thể commit
-- lệch thứ tự mốc → máy kiểm đúng lúc đó sót tên tới lần tải toàn bộ 12 giờ; tên trên tem vẫn đúng (print_enqueue_unchecked đặt lại).
-- Đổi MÃ SKU (cột sku) bằng SQL tay: mã mới vào phần đổi nhưng mã cũ không vào removed — đổi mã phải qua lưu trữ (sku_archive) rồi thêm mã mới.
-- Không đụng trigger sku_name_inactive_since (chạy trước theo thứ tự tên; cột inactive_since không nằm trong phép so).
-- Tác động: chỉ thêm hàm + trigger; không đổi dữ liệu có sẵn, không drop bảng. Không cần --allow-destructive.
-- Chạy: python scripts/apply_supabase_sql.py supabase/sku_name_touch_v1.sql
begin;

create or replace function public.sku_name_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := clock_timestamp();
  elsif (new.sku, new.product_name, new.category_id, new.category_name, new.status)
        is distinct from (old.sku, old.product_name, old.category_id, old.category_name, old.status) then
    new.updated_at := clock_timestamp();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;
revoke all on function public.sku_name_touch() from public, anon, authenticated;

-- create or replace trigger (Postgres 14+): chạy lại được mà không cần DROP (apply_supabase_sql.py chặn mọi DROP).
create or replace trigger sku_name_touch before insert or update on public."SKU_Name"
  for each row execute function public.sku_name_touch();

commit;
notify pgrst, 'reload schema';
