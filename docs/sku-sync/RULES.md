# Quy tắc đồng bộ SKU qua Extension

## Object → Field → Value → Rule → OK/NG

| Object | Field | Nguồn Value | Rule | OK/NG |
| --- | --- | --- | --- | --- |
| SKU | Mã, tên, category, trạng thái | Inside qua Extension | Category thuộc `954, 957, 960, 961, 962, 963, 964`; mã và tên không rỗng | Hợp lệ → OK; sai/trùng → NG |
| Quan hệ Normal–Combo | Combo, Normal, số lượng, trạng thái | Inside qua Extension | Hai SKU có category trong database; số lượng > 0 | Đúng phạm vi → OK; ngoài phạm vi → bỏ qua |
| Lượt đồng bộ | Nguồn, thay đổi, người chạy, thời gian | Edge Function | Phải tạo bản xem trước trước khi cập nhật | Có preview → OK; gọi ghi trực tiếp → NG |
| Xác minh | SKU và quan hệ vừa ghi | Đọc lại Supabase | Khớp toàn bộ trường vừa ghi | Khớp → hoàn tất; lệch → failed |

## Quy tắc vận hành

- Extension chỉ đọc dữ liệu từ phiên Inside đang đăng nhập.
- Edge Function xác minh người dùng có `user_roles.role = admin` ở mọi request.
- Không lưu cookie hoặc token Inside; không đặt service-role key trong extension hay `index.html`.
- Không tự xóa SKU hoặc quan hệ vắng mặt trong dữ liệu nguồn.
- Từ chối nguồn Combo dưới 1.000 hoặc trên 12.000 dòng.
- Từ chối lượt có trên 2.000 SKU hoặc 2.000 quan hệ cần ghi.
- Chỉ cập nhật các dòng mới hoặc thay đổi; luôn đọc lại sau upsert.
- Mỗi lượt lưu lịch sử, số lượng nguồn, số thay đổi, chi tiết cũ/mới và kết quả xác minh.

## Khi nào xem lại

- Inside đổi URL, tiêu đề cột, chuỗi mô tả Combo hoặc cách phân trang.
- Danh sách category nghiệp vụ thay đổi.
- Supabase đổi schema `SKU_Name`, `sku_combo_links` hoặc `user_roles`.
- Số quan hệ Combo hợp lệ giảm gần ngưỡng an toàn.
