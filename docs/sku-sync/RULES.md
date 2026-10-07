# Quy tắc đồng bộ SKU qua Extension

## Object → Field → Value → Rule → OK/NG

| Object | Field | Nguồn Value | Rule | OK/NG |
| --- | --- | --- | --- | --- |
| SKU | Mã, tên, category, trạng thái | Inside qua Extension | Category thuộc `954, 957, 960, 961, 962, 963, 964`; mã và tên không rỗng | Hợp lệ → OK; sai/trùng → NG |
| Quan hệ Normal–Combo | Combo, Normal, số lượng, trạng thái | Inside qua Extension | Hai SKU có category trong database; số lượng > 0 | Đúng phạm vi → OK; ngoài phạm vi → bỏ qua |
| Lượt đồng bộ | Nguồn, thay đổi, người chạy, thời gian | Edge Function | Phải tạo bản xem trước trước khi cập nhật | Có preview → OK; gọi ghi trực tiếp → NG |
| Xác minh | SKU và quan hệ vừa ghi | Đọc lại Supabase | Khớp toàn bộ trường vừa ghi | Khớp → hoàn tất; lệch → failed |
| Combo thừa | Quan hệ có trong database nhưng không còn trong nguồn | Đối chiếu toàn bộ nguồn Combo với `sku_combo_links` | Chỉ báo, không xóa: "Thành phần không còn" (Combo còn nhưng đổi thành phần) hoặc "Combo không còn" (cả Combo vắng) | Có → Admin xem; xóa chạy quy trình riêng |
| Thiếu SKU | Quan hệ bị loại vì chỉ một đầu có trong database | Edge Function | Liệt kê tối đa 1.000 dòng; cả hai đầu thiếu hoặc ngoài category chỉ đếm | Có → kiểm tra SKU chưa vào database |
| Lỗi nguồn | Quan hệ không hợp lệ, mô tả sai dạng `Combo A=B+C`, thành phần không đọc được | Extension | Lưu cùng lượt (tối đa 1.000 dòng, đếm đủ); không chặn bản xem trước | Có → xem lại dữ liệu trên Inside |
| Bản xem trước | Thời điểm tạo | Edge Function | Chỉ áp dụng trong 30 phút và khi chưa có lượt khác hoàn tất sau khi tạo | Quá hạn hoặc có lượt mới hơn → `STALE_PREVIEW`, phải kiểm tra lại |
| Mốc đọc tiếp theo | `source_generated_at` | Lượt `completed` gần nhất | Mốc cắt = thời điểm đọc nguồn của lượt đó − 1 ngày; không dùng lúc bấm cập nhật | Chưa có lượt hoàn tất → đọc 7 ngày gần nhất |

## Quy tắc vận hành

- Extension chỉ đọc dữ liệu từ phiên Inside đang đăng nhập.
- Edge Function xác minh người dùng có `user_roles.role = admin` ở mọi request.
- Không lưu cookie hoặc token Inside; không đặt service-role key trong extension hay `index.html`.
- Không tự xóa SKU hoặc quan hệ vắng mặt trong dữ liệu nguồn.
- Từ chối nguồn Combo dưới 1.000 hoặc trên 12.000 dòng.
- Từ chối lượt có trên 2.000 SKU hoặc 2.000 quan hệ cần ghi.
- Bản xem trước phản ánh database tại lúc tạo; ghi bản cũ sẽ đè dữ liệu mới bằng dữ liệu cũ nên Edge Function từ chối khi quá 30 phút hoặc đã có lượt hoàn tất sau đó. Giao diện hiển thị lượt đó là "Hết hạn" và khóa nút cập nhật.
- Mốc đọc của lượt sau tính từ thời điểm đọc nguồn (không phải lúc áp dụng), lấy bằng truy vấn riêng nên không phụ thuộc 20 lượt gần nhất; thời điểm ở tương lai (đồng hồ máy lệch) bị đưa về hiện tại.
- Chỉ cập nhật các dòng mới hoặc thay đổi; luôn đọc lại sau upsert.
- Mỗi lượt lưu lịch sử, số lượng nguồn, số thay đổi, chi tiết cũ/mới và kết quả xác minh.

## Khi nào xem lại

- Inside đổi URL, tiêu đề cột, chuỗi mô tả Combo hoặc cách phân trang.
- Danh sách category nghiệp vụ thay đổi.
- Supabase đổi schema `SKU_Name`, `sku_combo_links` hoặc `user_roles`.
- Số quan hệ Combo hợp lệ giảm gần ngưỡng an toàn.
