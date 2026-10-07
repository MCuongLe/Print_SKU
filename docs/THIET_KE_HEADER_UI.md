# Thiết kế hệ thống header cho Print SKU

> Trạng thái: **biến thể 4.2 (header tác nghiệp) đã triển khai ngày 07/10/2026** cho các màn con theo kiểu IN TEM SKU (README mục "Header các màn hình"). Trang chủ, header Quản trị (React) và header camera/scanner chưa đổi; chưa có pill trạng thái máy in ở các màn ngoài IN TEM SKU và IN TEM GROUP UID.

## 1. Mục tiêu

- Tạo một ngôn ngữ header thống nhất cho trang chủ, màn hình tác nghiệp, quản trị và camera/scanner.
- Làm rõ ba thông tin quan trọng ngay khi mở màn hình: đang ở đâu, thiết bị có sẵn sàng không, thao tác tiếp theo là gì.
- Giảm số kiểu header riêng lẻ, loại bỏ nút quay lại dạng nổi và giữ trải nghiệm nhất quán trên desktop/mobile.
- Ưu tiên thao tác nhanh trong môi trường kho: vùng chạm lớn, tương phản rõ, trạng thái có chữ và không phụ thuộc duy nhất vào màu.

## 2. Bảng thiết kế

- Bản xem nhanh PNG: [print-sku-header-system.png](./header-design/print-sku-header-system.png)
- Bản vector SVG: [print-sku-header-system.svg](./header-design/print-sku-header-system.svg)

## 3. Cấu trúc dùng chung

Mỗi header được chia thành bốn vùng cố định:

1. **Start:** nút quay lại hoặc logo ứng dụng.
2. **Identity:** nhãn ngữ cảnh nhỏ, tiêu đề màn hình và mô tả ngắn khi cần.
3. **Status:** trạng thái máy in, đồng bộ hoặc kết nối hệ thống.
4. **Actions:** tối đa hai thao tác có tần suất cao; thao tác còn lại đưa vào menu.

Quy tắc bố cục:

| Thuộc tính | Desktop | Mobile |
| --- | --- | --- |
| Chiều cao cơ sở | 72 px | 64 px + `safe-area-inset-top` |
| Padding ngang | 24 px | 16 px |
| Nút icon | 44 × 44 px | 44 × 44 px |
| Khoảng cách tối thiểu | 8 px | 8 px |
| Tiêu đề | 18–20 px, đậm 700 | 16–18 px, đậm 700 |
| Nhãn ngữ cảnh | 10–11 px, chữ hoa | 9–10 px, chữ hoa |
| Bo góc nút | 12–14 px | 12–14 px |
| Đường phân cách | 1 px `#D9E2DE` | 1 px `#D9E2DE` |

## 4. Bốn biến thể header

### 4.1. Header trang chủ

Áp dụng cho màn hình chọn chức năng `WH-MATERIAL`.

- Dùng nền xanh thương hiệu để tạo điểm nhận diện mạnh ngay tại cấp cao nhất.
- Bên trái gồm logo, nhãn “KHO NGUYÊN PHỤ LIỆU” và tên `WH-MATERIAL`.
- Bên phải desktop hiển thị trạng thái tổng thể của hệ thống; mobile rút gọn thành chấm trạng thái có nhãn hỗ trợ cho trình đọc màn hình.
- Không đặt nút quay lại vì đây là cấp điều hướng gốc.
- Không dùng nền xanh thương hiệu cho mọi màn hình con; cách này giữ phân cấp rõ và tránh giao diện nặng.

### 4.2. Header tác nghiệp

Áp dụng cho `IN TEM SKU`, UID, bàn cắt, vải, mẫu, vị trí kho và các màn hình thao tác tương tự.

- Nút quay lại nằm trong header, thay cho nút xanh nổi đang tách khỏi thanh tiêu đề.
- Sau nút quay lại là icon module 44 × 44 px, nhãn ngữ cảnh và tiêu đề công việc.
- Trạng thái máy in hiển thị bằng chấm + chữ: “Máy in sẵn sàng”, “Đang bận” hoặc “Mất kết nối”.
- Desktop có thể hiển thị hàng đợi và cài đặt. Mobile chỉ giữ một trạng thái rút gọn cùng một action chính.
- Tiêu đề mobile chỉ một dòng; nếu quá dài thì cắt bằng dấu ba chấm, không tăng chiều cao header tùy ý.

### 4.3. Header quản trị

Áp dụng cho các màn hình quản trị, lịch sử và cấu hình vận hành.

- Dùng cùng cấu trúc với header tác nghiệp để không tạo thêm một hệ UI khác.
- Thêm vạch xanh 4–6 px ở cạnh trái vùng header để nhận biết khu vực quản trị.
- Desktop hiển thị pill vai trò “Quản trị viên”; mobile chuyển thành avatar chữ viết tắt.
- Trạng thái ưu tiên là đồng bộ dữ liệu hoặc sức khỏe hệ thống, không dùng trạng thái máy in nếu màn hình không liên quan.

### 4.4. Header camera/scanner

Áp dụng khi camera hoặc trình quét mã đang chiếm toàn màn hình.

- Nền đen 92% giúp nút điều khiển luôn rõ trên hình ảnh camera.
- Nút đóng ở trái, tiêu đề căn giữa tuyệt đối, đèn pin ở phải.
- Hai nút đều có vùng chạm tối thiểu 44 × 44 px và hỗ trợ safe area trên thiết bị có tai thỏ.
- Dòng hướng dẫn nằm dưới header, ngắn và trực tiếp: “Đưa mã vào giữa khung”.
- Không đưa thêm cài đặt, lịch sử hoặc hành động phụ vào thanh scanner.

## 5. Màu và trạng thái

| Token | Giá trị | Mục đích |
| --- | --- | --- |
| Brand | `#005F41` | nhận diện, action chính |
| Brand dark | `#004D36` | gradient trang chủ |
| Brand subtle | `#E6F3EF` | nền icon, trạng thái nhẹ |
| Background | `#F4F7F6` | nền ứng dụng |
| Text | `#17251F` | tiêu đề, nội dung chính |
| Muted | `#60736B` | breadcrumb, mô tả |
| Border | `#D9E2DE` | đường phân cách |
| Success | `#16865D` | sẵn sàng, đã đồng bộ |
| Warning | `#B7791F` | đang bận, cần chú ý |
| Danger | `#C2413B` | mất kết nối, lỗi |

Trạng thái không được truyền đạt chỉ bằng màu. Mỗi trạng thái phải có tối thiểu chấm hoặc icon cùng nhãn chữ. Ví dụ:

- Chấm xanh + “Máy in sẵn sàng”.
- Chấm vàng + “Máy in đang bận”.
- Chấm đỏ + “Mất kết nối máy in”.

## 6. Icon đề xuất

Tiếp tục dùng ngôn ngữ icon đã thiết kế cho dự án: khung 24 × 24 px, nét 2 px, đầu nét tròn, không trộn icon đặc và icon nét trong cùng một header.

| Chức năng | Icon |
| --- | --- |
| Quay lại | `ArrowLeft` |
| In tem | `Printer` |
| Cài đặt | `Settings2` |
| Trạng thái kết nối | `Wifi` hoặc `CircleCheck` |
| Quản trị | `ShieldCheck` |
| Đóng máy quét | `X` |
| Đèn pin | `Flashlight` |
| Hàng đợi | `ListOrdered` |

## 7. Hành vi responsive

### Desktop từ 1024 px

- Hiển thị đầy đủ nhãn ngữ cảnh, tiêu đề, trạng thái và tối đa hai action.
- Nội dung header nằm trong cùng chiều rộng tối đa với nội dung trang.
- Header sticky ở đầu viewport, có đường viền dưới; chỉ thêm bóng rất nhẹ sau khi người dùng cuộn.

### Tablet 600–1023 px

- Giữ tiêu đề và trạng thái chính.
- Rút gọn hoặc ẩn breadcrumb dài trước khi giảm cỡ chữ.
- Các action ít dùng chuyển vào menu “Thêm”.

### Mobile dưới 600 px

- Giữ nút quay lại, tiêu đề, trạng thái ngắn và một action chính.
- Ẩn subtitle nếu chiều rộng không đủ; không thu nút xuống dưới 44 px.
- Không để pill trạng thái đẩy tiêu đề xuống dòng. Khi thiếu chỗ, dùng chấm trạng thái bên dưới tiêu đề kèm nhãn ngắn.

## 8. Khả năng tiếp cận và nội dung

- Mọi icon button cần `aria-label` tiếng Việt rõ nghĩa, ví dụ “Quay lại trang chọn chức năng”.
- Trạng thái động nên có `aria-live="polite"`; không thông báo lặp lại khi giá trị không đổi.
- Focus ring dùng viền 2 px `#238A67`, cách phần tử 2 px.
- Duy trì độ tương phản chữ; chữ phụ không dùng màu nhạt hơn `#60736B` trên nền trắng.
- Không dùng toàn bộ chữ hoa cho tiêu đề dài. Chữ hoa chỉ dành cho nhãn ngữ cảnh ngắn.
- Tên màn hình nên mô tả nhiệm vụ, ví dụ “In tem SKU” thay vì chỉ “Print”.

## 9. Đối chiếu với giao diện hiện tại

Các thay đổi thiết kế nên thực hiện khi có source gốc hoặc khi dự án cho phép triển khai:

1. Hợp nhất các kiểu `.uid-topbar`, `.cut-head`, header in tem và header quản trị thành một component/contract chung.
2. Đưa nút quay lại dạng nổi vào vùng `Start` của header tác nghiệp.
3. Chuẩn hóa chiều cao 72 px desktop và 64 px mobile thay vì mỗi module dùng một kích thước.
4. Chuẩn hóa status pill; không dùng chỉ một chấm màu hoặc câu trạng thái đặt rời rạc.
5. Giữ tối đa hai action bên phải desktop và một action trên mobile.
6. Dùng header nền xanh chỉ ở trang chủ; màn hình con dùng nền trắng để nội dung và trạng thái dễ đọc hơn.
7. Dùng header tối riêng cho camera/scanner, không tái sử dụng header trắng trên hình ảnh camera.

## 10. Phạm vi bàn giao

Tài liệu này chỉ mô tả thiết kế và hành vi đề xuất. Chưa có CSS, React component hoặc thay đổi nào được đưa vào ứng dụng. Khi triển khai, nên ưu tiên khôi phục source React gốc thay vì chỉnh sửa diện rộng trong bundle đã minify.
