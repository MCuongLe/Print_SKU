# HASAKI Inside PO Connector

Tiện ích Chrome chỉ đọc, dùng phiên Inside đã đăng nhập để lấy PO/SKU cho màn `#inspection` và lấy dữ liệu SKU/Combo cho màn `#admin/sku-sync` của Print SKU.

## Người dùng có phải tự cài không?

Có. Chrome không cho một website tự cài extension. Với bản nội bộ trong repo, mỗi máy chỉ cần cài một lần:

1. Tải hoặc clone repository `Print_SKU` về máy.
2. Mở `chrome://extensions`.
3. Bật **Chế độ dành cho nhà phát triển / Developer mode**.
4. Chọn **Tải tiện ích đã giải nén / Load unpacked**.
5. Chọn đúng thư mục `extension/inside-po-connector`.
6. Tải lại tab Inside và tab Print SKU.

Sau khi repository được cập nhật, mở `chrome://extensions` và bấm **Tải lại / Reload** trên tiện ích để nhận mã mới.

## Cách sử dụng

1. Mở `https://inside.mastige.vn/` và đăng nhập.
2. Mở Print SKU tại một trong các địa chỉ được phép:
   - `http://localhost:<port>/#inspection`
   - `http://127.0.0.1:<port>/#inspection`
   - `https://mcuongle.github.io/Print_SKU/#inspection`
3. Nhập mã PO và bấm **Lấy từ Inside**.

Đồng bộ SKU dành cho Admin:

1. Mở tab Inside và đăng nhập.
2. Vào `#admin/sku-sync` trong Print SKU.
3. Bấm **Kiểm tra dữ liệu Inside** để xem trước thay đổi.
4. Xem danh sách SKU và quan hệ Normal–Combo, sau đó bấm **Cập nhật Supabase**.

Extension chỉ đọc Inside. Mọi ghi dữ liệu chạy trong Edge Function `sku-sync`, yêu cầu phiên Supabase có vai trò `admin` và luôn xác minh lại sau khi upsert.

Phiên bản 0.3.3 đọc đầy đủ Combo nhiều thành phần dạng `Combo A=B+C`, chỉ kết thúc phân trang theo số dòng gốc và báo cáo từng lỗi nguồn: quan hệ không hợp lệ, mô tả sai dạng `Combo A=B+C` và thành phần không đọc được. Lỗi không bị bỏ lặng lẽ; chúng được gửi kèm bản xem trước.

## Triển khai cho nhiều người

- Giai đoạn thử nghiệm: gửi repository và để từng máy dùng **Load unpacked**.
- Muốn người dùng bấm một lần để cài và tự cập nhật: phát hành extension qua Chrome Web Store, có thể để chế độ **Unlisted**.
- Máy do công ty quản lý: IT có thể cài bắt buộc bằng Chrome Enterprise Policy. Đây là cách phù hợp nhất nếu không muốn từng người tự cài.

Không thể tạo nút trên `index.html` để bỏ qua màn xác nhận cài đặt của Chrome.

## Bảo mật và phạm vi

- Chỉ đọc dữ liệu PO/SKU; không ghi ngược vào Inside.
- Không đọc hoặc lưu cookie/token. Request chạy trong tab Inside đã đăng nhập.
- App chỉ nhận dữ liệu đã chuẩn hóa: PO, kho, NCC, ngày giao và các dòng SKU.
- Extension không chứa Supabase secret/service-role key.
- Chỉ kết nối với Inside và các địa chỉ Print SKU đã khai báo trong `manifest.json`.
- Import `.xls/.xlsx` vẫn là phương án dự phòng.

Nếu triển khai Print SKU trên domain khác, phải thêm domain đó đồng thời vào `manifest.json`, `background.js` và `app-bridge.js`.
