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

Phiên bản 0.6.1 đọc đầy đủ Combo nhiều thành phần, Group UID hiện tại, lịch sử cắt Group UID và dữ liệu kiểm kê SKU từ WMS theo lô 500 dòng. Tồn kho kiểm kê dùng báo cáo `Stock Location` đã gộp theo SKU/vị trí và chỉ giữ `count_inbin > 0`, tránh tải hàng trăm nghìn dòng UID. Bản này hỗ trợ phản hồi WMS dạng `records/count`, Group UID trạng thái `New` chưa có SKU và Group UID chứa nhiều SKU. Các SKU thành phần được lưu trong `group_uid_products`.

Dashboard kiểm kê SKU dành cho Admin:

1. Mở tab WMS và đăng nhập bằng tài khoản có quyền trên cả Mastige và Hasaki Garment.
2. Vào `#admin/kiem-ke` trong Print SKU.
3. Bấm **Đọc và đối chiếu WMS**.
4. Extension tự đọc `WH - MATERIAL - MTG` dưới công ty Mastige và chuyển header `company-ids` sang công ty Garment để đọc `WH - MATERIAL - GARMENT`; không thay đổi công ty đang chọn trên giao diện WMS.
5. Dashboard đối chiếu tồn kho `In-BIN`, `qty > 0` với kết quả kiểm kê SKU có trạng thái `APPROVED`, rồi chia nhóm chưa kiểm kê, trong 30 ngày và quá 30 ngày.

Nếu tài khoản thiếu quyền ở một công ty, dashboard vẫn hiện phần kho đọc được nhưng cảnh báo rõ kho còn thiếu; không được xem kết quả một kho là kết quả đủ hai kho.

Đồng bộ Group UID dành cho Admin:

1. Mở tab WMS và đăng nhập.
2. Vào `#admin/group-uid-sync` trong Print SKU.
3. Chọn **Kiểm tra thay đổi** hoặc **Đối chiếu toàn bộ**.
4. Xem báo cáo rồi bấm **Cập nhật Supabase**.

Luồng thay đổi đọc chồng lại 30 phút. Luồng toàn bộ vẫn được giữ để tìm UID thiếu hoặc sai lệch. Access token WMS không rời extension.

Đối chiếu UID đã cắt:

1. Đăng nhập WMS bằng tài khoản có quyền xem **Group UID → History**.
2. Mở `#cut-group-uid`, chọn **4 · Đối chiếu** và bấm **Đọc từ WMS**.
3. Extension chỉ đọc kho `warehouse_id=1177` (**WH - MATERIAL - MTG**), nhận diện dòng Cut theo Note và gửi dữ liệu đã chuẩn hóa về ứng dụng.
4. Ứng dụng nạp vào Supabase bằng phiên Admin, lùi mốc lần trước 30 phút và loại trùng theo Group UID + thời gian Cut.

Nút **Nạp ZIP/XLSX** vẫn dùng được để đối chiếu toàn bộ hoặc khi API WMS tạm thời không khả dụng.

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
