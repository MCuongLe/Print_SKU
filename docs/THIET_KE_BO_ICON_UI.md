# Thiết kế bộ icon cho Print SKU / WH-MATERIAL

> Trạng thái: đã tích hợp vào `index.html` ngày 02/10/2026 (chi tiết trong `RULES.md`); bảng dưới vẫn là đặc tả gốc.
> Bảng mẫu: [`icon-design/print-sku-icon-concept-board.svg`](./icon-design/print-sku-icon-concept-board.svg)

## 1. Hướng thiết kế được chọn

Tiếp tục dùng **Lucide** làm hệ icon duy nhất vì:

- Dự án hiện đã chứa Lucide trong bundle React.
- Icon là SVG, nhẹ và nét ở mọi mật độ màn hình.
- Hình dạng outline phù hợp giao diện WMS sáng hiện tại.
- Có thể dùng cùng một icon trong React và các đoạn HTML/JavaScript thuần.
- Không cần tải CDN hoặc thêm network call.

Nguồn tham khảo chính thức:

- [Lucide — bộ icon và trình tùy chỉnh](https://lucide.dev/)
- [Lucide Vanilla JavaScript](https://lucide.dev/guide/lucide)
- [Lucide Plus](https://lucide.dev/icons/plus)
- [Lucide Search](https://lucide.dev/icons/search)
- [Lucide Accessibility](https://lucide.dev/guide/lucide/accessibility)

Bảng concept dùng hình dạng từ package Lucide `1.8.0` có sẵn trong môi trường thiết kế, giấy phép ISC. Khi triển khai sau này cần dùng đúng phiên bản đã khóa trong source project.

## 2. Quy chuẩn thị giác

| Thuộc tính | Quy chuẩn đề xuất |
|---|---|
| ViewBox | `0 0 24 24` |
| Nét | `2px`, `round` linecap, `round` linejoin |
| Kích thước icon trong button | 20 px cho button compact; 24 px cho CTA/camera |
| Touch target | Tối thiểu 44×44 px; CTA chính 48–52 px |
| Màu hành động | `#005F41` |
| Màu nền icon nhẹ | `#E6F3EF` |
| Màu xóa/dừng | `#C2413B` trên nền `#FBECEB` |
| Màu cảnh báo | `#B7791F` trên nền `#FDF3E3` |
| Trạng thái disabled | Giữ hình dạng, giảm opacity; không đổi sang icon khác |
| Phong cách | Outline; không trộn icon filled, emoji, ký tự `×`, `+`, `−` rời rạc |

## 3. Mapping icon cho các nút chính

### Nhập liệu và danh sách

| Nút/chức năng hiện tại | Icon đề xuất | Tên Lucide | Ghi chú |
|---|---|---|---|
| Thêm vào danh sách | Dấu cộng | `Plus` | Dùng icon + nhãn; không dùng CirclePlus để CTA nhẹ hơn |
| Tăng số bản | Dấu cộng | `Plus` | Icon-only được phép vì có cặp với Giảm; cần `aria-label="Tăng"` |
| Giảm số bản | Dấu trừ | `Minus` | Không dùng ký tự `−` thuần |
| Xóa một dòng | Thùng rác | `Trash2` | Thay ký tự `×`; màu danger |
| Xóa hết | Thùng rác | `Trash2` | Bắt buộc kèm chữ “Xóa hết” |
| Sao chép | Hai khung chồng | `Copy` | Icon-only được phép nếu có tooltip/aria-label |
| Sửa | Bút chì | `Pencil` | Dùng cho tên thiết bị/vị trí, không dùng Settings |
| Xác nhận/Áp dụng | Dấu kiểm | `Check` | Không dùng cho trạng thái thành công tĩnh nếu dễ nhầm là button |

### Bàn phím và scanner

| Trạng thái/hành động | Icon đề xuất | Tên Lucide | Quy tắc |
|---|---|---|---|
| Bàn phím đang ẩn; bấm để hiện | Bàn phím | `Keyboard` | Icon thể hiện hành động sắp xảy ra |
| Bàn phím đang hiện; bấm để ẩn | Bàn phím gạch chéo | `KeyboardOff` | Không giữ nguyên một icon cho hai hành động ngược nhau |
| Quét barcode/QR/UID | Khung quét + đường | `ScanLine` | Dùng ở nút cạnh input |
| Tìm SKU bằng camera | Khung quét + kính lúp | `ScanSearch` | Phân biệt “tìm” với “quét lấy mã” |
| Chụp ngay | Máy ảnh | `Camera` | Nút shutter tròn vẫn có thể giữ riêng; nhãn phụ dùng Camera |
| Chọn ảnh | Khung ảnh | `Image` | Không dùng Camera vì nguồn là thư viện |
| Bật đèn | Đèn pin | `Flashlight` | Khi đang bật có thể dùng nền trắng/active; không cần icon filled |
| Đóng scanner/modal | Dấu X | `X` | Chỉ dùng cho đóng, không dùng thay xóa dữ liệu |

### In và dữ liệu

| Nút/chức năng | Icon đề xuất | Tên Lucide | Ghi chú |
|---|---|---|---|
| In tem | Máy in | `Printer` | Dùng nhất quán ở mọi màn |
| Tải lại | Hai mũi tên vòng | `RefreshCw` | Animation quay chỉ khi đang tải và tôn trọng reduced-motion |
| Tìm kiếm | Kính lúp | `Search` | Đặt đầu ô search hoặc button |
| Nhập Excel | Mũi tên lên | `Upload` | Có thể ghép nhãn “Nhập Excel” |
| Xuất Excel | File bảng tính hoặc mũi tên xuống | `FileSpreadsheet` + `Download` | Button có chữ dùng FileSpreadsheet; icon-only dùng Download với aria-label rõ |
| Cấu hình | Hai thanh chỉnh | `Settings2` | Nhẹ và đúng ngữ cảnh hơn bánh răng cho bộ lọc/cấu hình nhỏ |
| Quay lại | Mũi tên trái | `ArrowLeft` | Thay ký tự `←`; aria-label “Về WH-MATERIAL” hoặc đích cụ thể |

### Nghiệp vụ kho

| Chức năng | Icon đề xuất | Tên Lucide |
|---|---|---|
| PRINT SKU / In tem SKU | Máy in | `Printer` |
| PRINT UID / In tem Group UID | Chồng nhãn | `Tags` |
| Tem xả vải | Đồng hồ làm mới | `TimerReset` |
| Cắt Group UID | Kéo + đường đứt | `ScissorsLineDashed` |
| Tìm SKU | Khung quét + kính lúp | `ScanSearch` |
| Theo dõi xả vải | Đồng hồ làm mới | `TimerReset` |
| Bắt đầu xả vải | Tam giác chạy | `Play` |
| Kết thúc xả vải | Stop trong vòng tròn | `CircleStop` |
| Kiểm tra đầu vào | Clipboard + check | `ClipboardCheck` |
| Gom hàng mẫu | Kiện hàng + check | `PackageCheck` |
| Rủi ro lưu trữ | Tam giác cảnh báo | `TriangleAlert` |
| Mất kết nối | Wi-Fi gạch chéo | `WifiOff` |

## 4. Quy tắc dùng icon trên button

### CTA chính

- Icon đặt bên trái nhãn.
- Khoảng cách icon–chữ: 8 px.
- Icon 20–22 px, button cao 48–52 px.
- Ví dụ: `Plus + Thêm vào danh sách`, `Printer + In 12 tem`.

### Button phụ

- Icon 18–20 px, button cao tối thiểu 44 px.
- Dùng nền trắng, border trung tính, icon xanh thương hiệu.
- Ví dụ: `Keyboard + Hiện bàn phím`, `RefreshCw + Tải lại`.

### Icon-only

Chỉ dùng cho thao tác quen thuộc và khi không đủ chỗ:

- Quay lại, đóng, sao chép, camera, đèn pin, tăng/giảm.
- Target vẫn phải 44×44 px trở lên dù icon chỉ 20–24 px.
- Bắt buộc có `aria-label` mô tả hành động, không chỉ tên hình.
- Trên desktop nên có tooltip; mobile không được phụ thuộc tooltip để hiểu.

### Danger

- Chỉ `Trash2`, `CircleStop` và lỗi phá hủy mới dùng đỏ.
- Không tô đỏ icon X đóng dialog.
- Nút xóa có chữ khi hậu quả lớn: “Xóa hết”, “Xóa vị trí”.

## 5. Những icon/ký tự nên thay

- Ký tự `×` xóa dòng → `Trash2`.
- Ký tự `×` đóng dialog → `X`, giữ màu trung tính.
- Ký tự `+`/`−` trong nút số lượng → SVG `Plus`/`Minus`.
- Ký tự `←` quay lại → `ArrowLeft`.
- Icon bàn phím tự vẽ hiện tại → cặp `Keyboard`/`KeyboardOff` có trạng thái rõ.
- Icon tải lại tự vẽ → `RefreshCw`.
- Không dùng chung một icon “camera” cho cả quét mã, chụp ảnh và chọn ảnh.

## 6. Các lựa chọn chưa nên dùng

- Không trộn Material Icons, Font Awesome, emoji và Lucide trong cùng ứng dụng.
- Không dùng icon filled ở menu nhưng outline ở button.
- Không dùng icon không có nhãn cho hành động nghiệp vụ hiếm gặp.
- Không dùng màu để phân biệt hai hành động nếu hình dạng giống nhau.
- Không thêm icon vào mọi dòng chữ; icon chỉ dành cho hành động, trạng thái hoặc loại đối tượng cần nhận diện nhanh.
- Không đưa SVG từ CDN; khi triển khai phải bundle hoặc nhúng nội bộ.

## 7. Danh sách thiết kế trong bảng concept

Bảng SVG đã thiết kế 30 icon:

1. Plus
2. Keyboard
3. KeyboardOff
4. ScanLine
5. Camera
6. Image
7. Printer
8. Minus
9. Trash2
10. RefreshCw
11. Search
12. Check
13. X
14. ArrowLeft
15. Settings2
16. FileSpreadsheet
17. Upload
18. Download
19. Copy
20. Flashlight
21. TimerReset
22. Play
23. CircleStop
24. TriangleAlert
25. PackageCheck
26. ScissorsLineDashed
27. Tags
28. ClipboardCheck
29. ScanSearch
30. WifiOff

## 8. Bước tiếp theo khi được duyệt

Chưa thực hiện trong yêu cầu này. Khi bộ thiết kế được duyệt, nên triển khai theo ba đợt nhỏ:

1. Thay ký tự thô `×`, `+`, `−`, `←` và icon bàn phím.
2. Chuẩn hóa icon cho CTA: thêm, in, tải lại, import/export.
3. Chuẩn hóa icon trang chủ và trạng thái scanner.

Mỗi đợt phải giữ nguyên nhãn chữ, `aria-label`, ID, route và logic hiện tại; kiểm tra desktop/mobile/keyboard trước khi chuyển đợt tiếp theo.
