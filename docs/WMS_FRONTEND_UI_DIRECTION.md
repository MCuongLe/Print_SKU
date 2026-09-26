# Hướng cải thiện giao diện Frontend theo WMS

## 1. Mục tiêu

Cải thiện giao diện ứng dụng theo phong cách WMS chuyên nghiệp, dễ đọc và dễ thao tác trong môi trường kho, đồng thời giữ nguyên cấu trúc ứng dụng và toàn bộ nghiệp vụ hiện tại.

## 2. Phạm vi giữ nguyên

- Giữ các route hiện tại như `#home`, `#worker`, `#group-uid`, `#cut-group-uid`.
- Giữ nguyên DOM ID đang được JavaScript sử dụng.
- Không thay đổi API Supabase, dữ liệu, quyền truy cập hoặc hàng đợi in.
- Không thay đổi luồng máy quét, camera, bàn phím và in tem.
- Giữ ứng dụng chạy độc lập từ một file `index.html`.
- Giữ màu thương hiệu Hasaki `#005F41`.

## 3. Hướng thiết kế chính

### Bố cục

- Dùng header xanh đậm, vùng nội dung sáng để tăng khả năng đọc form và bảng.
- Giới hạn chiều rộng nội dung khoảng `1280px` trên desktop.
- Desktop sử dụng grid; mobile chuyển thành một cột từ `375px`.
- Thanh hành động quan trọng được ghim ở cuối màn hình khi cần.
- Giảm khoảng trống không cần thiết để hiển thị nhiều thông tin hơn.

### Thành phần giao diện

- Chuẩn hóa card, input, button, tab, table, badge và thông báo trạng thái.
- Card bo góc `12–16px`; input và button bo góc `8–12px`.
- Nút thao tác chính cao tối thiểu `48px`.
- Tăng tương phản cho label, placeholder, ghi chú và đường viền.
- Trạng thái phải có icon, chữ và màu; không chỉ phân biệt bằng màu.
- Bảng dữ liệu có toolbar lọc, header cố định, hover và empty state rõ ràng.

### Trang chủ

Nhóm chức năng theo nghiệp vụ thay vì hiển thị tất cả ngang hàng:

- **In tem:** PRINT SKU, PRINT UID, FABRIC RELAXATION.
- **Vận hành kho:** CẮT GROUP UID, THEO DÕI XẢ VẢI.
- **Kiểm tra:** INSPECTION, SAMPLE.

Mỗi card gồm icon thống nhất, tên tác vụ, mô tả ngắn và badge trạng thái nếu cần.

### Màn tác nghiệp

Áp dụng cấu trúc chung:

1. Header tác vụ và trạng thái thiết bị.
2. Step hoặc tab thể hiện tiến trình.
3. Vùng quét/nhập chính nổi bật.
4. Phản hồi ngay sau thao tác.
5. Danh sách kết quả hoặc dữ liệu chờ xử lý.
6. Thanh hành động chính dễ nhìn và dễ bấm.

### Màn quản trị và tra cứu

Áp dụng cấu trúc chung:

1. Tiêu đề và thống kê tổng quan.
2. Thanh tìm kiếm và bộ lọc.
3. Bảng dữ liệu có mật độ vừa phải.
4. Badge thể hiện trạng thái.
5. Phân trang hoặc tổng số kết quả.
6. Hành động hàng loạt đặt phía trên bảng.

## 4. Design tokens đề xuất

```css
--wms-brand: #005f41;
--wms-brand-hover: #087b58;
--wms-bg: #f4f7f6;
--wms-surface: #ffffff;
--wms-text: #17251f;
--wms-muted: #60736b;
--wms-border: #d9e2de;
--wms-success: #16845b;
--wms-warning: #b7791f;
--wms-danger: #c2413b;
```

Tên class dùng chung có thể gồm:

```text
.wms-header
.wms-card
.wms-input
.wms-button
.wms-tabs
.wms-table
.wms-status
.wms-action-bar
```

## 5. Hướng triển khai

Do repository không còn source React gốc, không nên dịch ngược hoặc viết lại toàn bộ bundle minify. Nên triển khai theo từng lớp:

### Giai đoạn 1 — Chuẩn hóa nền tảng

- Thêm design tokens và lớp CSS WMS dùng chung ở cuối `index.html`.
- Không thay đổi JavaScript, route hoặc nghiệp vụ.
- Chuẩn hóa typography, màu, spacing, border và focus state.

### Giai đoạn 2 — Cải thiện từng màn

Thứ tự ưu tiên:

1. Trang chủ.
2. PRINT SKU.
3. CẮT GROUP UID.
4. PRINT UID.
5. THEO DÕI XẢ VẢI.
6. INSPECTION, SAMPLE và FABRIC RELAXATION.

Mỗi lần chỉ chỉnh một màn để giữ diff nhỏ và dễ kiểm tra hồi quy.

### Giai đoạn 3 — Đồng bộ toàn ứng dụng

- Hợp nhất các mẫu card, tab, form, table và trạng thái.
- Loại bỏ các biến thể CSS không cần thiết sau khi đã xác minh giao diện.
- Không reformat hoặc re-minify toàn bộ `index.html`.

## 6. Kiểm tra bắt buộc

- Chạy `git diff --check` và kiểm tra kích thước diff.
- Phục vụ trang bằng HTTP local.
- Kiểm tra desktop khoảng `1280px` và mobile `375px`.
- Kiểm tra bàn phím, máy quét và camera trên các màn bị ảnh hưởng.
- Kiểm tra trạng thái rỗng, loading, thành công, cảnh báo và lỗi.
- Với thay đổi liên quan tem, kiểm tra print preview, kích thước giấy, clipping và phân trang.

## 7. Kết luận

Hướng phù hợp là xây một lớp **WMS Design System** thống nhất trên cấu trúc hiện tại. Cách này giúp giao diện chuyên nghiệp hơn nhưng giảm rủi ro ảnh hưởng tới nghiệp vụ, máy quét, camera và hệ thống in tem đang vận hành.
