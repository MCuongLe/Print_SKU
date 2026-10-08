# HASAKI Inside PO Connector

Tiện ích Chrome chỉ đọc, dùng phiên Inside/WMS đã đăng nhập để lấy PO/SKU, dữ liệu SKU/Combo và Group UID cho Print SKU.

## Người dùng có phải tự cài không?

Có. Chrome không cho một website tự cài extension. Với bản nội bộ trong repo, mỗi máy chỉ cần cài một lần:

1. Tải hoặc clone repository `Print_SKU` về máy.
2. Mở `chrome://extensions`.
3. Bật **Chế độ dành cho nhà phát triển / Developer mode**.
4. Chọn **Tải tiện ích đã giải nén / Load unpacked**.
5. Chọn đúng thư mục `extension/inside-po-connector`.
6. Tải lại tab Inside, tab WMS và tab Print SKU.

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

Phiên bản 0.4.1 đọc đầy đủ Combo nhiều thành phần và bổ sung Group UID từ WMS theo lô 500 dòng. Bản này hỗ trợ đúng phản hồi WMS dạng `records/count`, kể cả Group UID trạng thái `New` chưa có SKU.

Đồng bộ Group UID dành cho Admin:

1. Mở tab WMS và đăng nhập.
2. Vào `#admin/group-uid-sync` trong Print SKU.
3. Chọn **Kiểm tra thay đổi** hoặc **Đối chiếu toàn bộ**.
4. Xem báo cáo rồi bấm **Cập nhật Supabase**.

Luồng thay đổi đọc chồng lại 30 phút. Luồng toàn bộ vẫn được giữ để tìm UID thiếu hoặc sai lệch. Access token WMS không rời extension.

## Triển khai cho nhiều người

- Giai đoạn thử nghiệm: gửi repository và để từng máy dùng **Load unpacked**.
- Muốn người dùng bấm một lần để cài và tự cập nhật: phát hành extension qua Chrome Web Store, có thể để chế độ **Unlisted**.
- Máy do công ty quản lý: IT có thể cài bắt buộc bằng Chrome Enterprise Policy. Đây là cách phù hợp nhất nếu không muốn từng người tự cài.

Không thể tạo nút trên `index.html` để bỏ qua màn xác nhận cài đặt của Chrome.

## Bảo mật và phạm vi

- Chỉ đọc dữ liệu PO/SKU/Group UID; không ghi ngược vào Inside hoặc WMS.
- Token WMS chỉ được đọc tạm trong tab WMS để gọi API và không gửi tới Print SKU hoặc Supabase.
- App chỉ nhận dữ liệu đã chuẩn hóa: PO, kho, NCC, ngày giao và các dòng SKU.
- Extension không chứa Supabase secret/service-role key.
- Chỉ kết nối với Inside, WMS và các địa chỉ Print SKU đã khai báo trong `manifest.json`.
- Import `.xls/.xlsx` vẫn là phương án dự phòng.

Nếu triển khai Print SKU trên domain khác, phải thêm domain đó đồng thời vào `manifest.json`, `background.js` và `app-bridge.js`.
