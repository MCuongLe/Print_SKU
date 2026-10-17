-- Đồng bộ tự động: chuyển khung lượt toàn bộ từ ban đêm (00:00–05:00) sang buổi sáng 07:30–11:00 giờ Việt Nam (17/10/2026).
-- Vì sao: Extension chỉ chạy khi có tab WMS/Inside đang đăng nhập; ban đêm máy công ty tắt và ở nhà không vào được WMS,
-- nên lượt toàn bộ ban đêm không bao giờ chạy. Ban đêm cũng không có dữ liệu mới. Không có kết nối thì Extension bỏ qua lặng lẽ.
-- Tác động: lượt alarm đầu tiên trong 07:30–11:00 có tab mở sẽ chạy toàn bộ nếu 20 giờ qua chưa có lượt toàn bộ nào
-- (kể cả lượt Admin bấm tay). Không cần deploy Edge hay Reload Extension: Edge đọc full_window_* mỗi lần auto-config.
begin;
update public.sync_auto_settings
   set full_window_start = '07:30', full_window_end = '11:00', updated_at = now()
 where singleton = true;
alter table public.sync_auto_settings alter column full_window_start set default '07:30';
alter table public.sync_auto_settings alter column full_window_end set default '11:00';
commit;
