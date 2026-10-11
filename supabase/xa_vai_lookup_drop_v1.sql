-- Bỏ hàm xa_vai_lookup (11/10/2026). Hàm này do xa_vai_log_v1 tạo để màn Xả vải tra trạng thái UID sau khi quét,
-- nhưng màn hiện chỉ gọi xa_vai_start / xa_vai_end / xa_vai_list_open / xa_vai_search (index.html), và v2..v5 không gọi lại nó.
-- Đã kiểm toàn repo (SQL, index.html, extension, scripts, tests, docs): không còn chỗ nào gọi.
-- Hàm đang được cấp quyền execute cho anon nên bỏ đi cũng làm bớt một lối truy cập công khai vào group_uid_details.

drop function if exists public.xa_vai_lookup(text);

notify pgrst, 'reload schema';
