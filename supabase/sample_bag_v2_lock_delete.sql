-- Khoá quyền xoá cả bao khỏi trình duyệt.
-- Chạy sau sample_bag_v1.sql.
--
-- Lý do: app không có màn hình đăng nhập, nên bất kỳ ai có link cũng gọi được mọi RPC
-- đang mở cho anon. Xoá cả bao là hành động không giới hạn thiệt hại — mất luôn số
-- lượng đã đếm của một SKU — khác hẳn sample_decrement chỉ bớt đúng 1 mẫu mỗi lần gọi.
-- Bỏ nút trên giao diện là chưa đủ: RPC vẫn gọi thẳng được bằng publishable key.
--
-- Hàm sample_delete được GIỮ LẠI, chỉ thu hồi quyền gọi từ anon/authenticated. Cần huỷ
-- một bao thì chạy trong SQL Editor hoặc qua scripts/apply_supabase_sql.py, nơi thao tác
-- có người chịu trách nhiệm và có vết.

revoke execute on function public.sample_delete(text,text) from anon,authenticated;

-- sample_scan, sample_list và sample_decrement giữ nguyên quyền: đó là ba thao tác
-- người đóng bao cần dùng liên tục, và mỗi lần gọi chỉ đổi được 1 mẫu.
