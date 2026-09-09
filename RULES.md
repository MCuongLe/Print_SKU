# Quy tắc giao diện Slate Hasaki

## Phạm vi

Giao diện ứng dụng in tem SKU vẫn mở trực tiếp và giữ nguyên toàn bộ luồng nghiệp vụ hiện có. Phần thay đổi chỉ áp dụng cho bố cục, màu sắc và nhận diện thương hiệu.

## Object – Field – Value – Rule

| Object | Field | Field Value | Rule | Kết quả |
| --- | --- | --- | --- | --- |
| Nhận diện | Màu chủ đạo | `#005F41` | Dùng cho logo, nút chính và trạng thái nổi bật | Nhất quán thương hiệu Hasaki |
| Bố cục | Desktop | Hai cột từ 768 px | Form bên trái, danh sách chờ in bên phải | Giảm cuộn và tận dụng chiều ngang |
| Bố cục | Mobile | Một cột | Giữ nút và ô nhập dễ thao tác | Không tràn ngang ở 375 px trở lên |
| Header | Thông tin ứng dụng | Tên, logo và phiên bản | Luôn nhìn thấy ở đầu trang | Nhận diện rõ môi trường Production |
| Quản trị | Trường dữ liệu chỉ đọc | Nền slate, chữ xanh sáng | Không dùng chữ sáng trên nền trắng | Đường dẫn và mã cấu hình đọc rõ |

## Mức bằng chứng

- Giao diện và bố cục: N2 – kiểm tra trực tiếp trong trình duyệt cục bộ.
- Luồng nhập, danh sách và in: N3/N4 theo phản hồi ứng dụng và máy chủ hiện có.
- Các luồng máy in, camera và phân quyền không bị thay đổi bởi giao diện này.

## Quy tắc giao diện

- Ứng dụng không có màn hình đăng nhập; người dùng vào thẳng màn hình thao tác.
- Tên ứng dụng, logo và phiên bản phải nhìn thấy rõ ở header.
- Màu chủ đạo Hasaki `#005F41`, tương phản đủ rõ trên nền slate tối.
- Nút chính cao tối thiểu 48 px; form dùng được ở màn hình 375 px trở lên và hỗ trợ bàn phím.
- Không thay đổi dữ liệu, API, quyền in, camera, mã vạch hoặc cấu trúc tem.

## Phân quyền Quản trị

| Bề mặt | Chưa đăng nhập | `worker` | `admin` |
| --- | --- | --- | --- |
| Màn hình in tem | Được dùng | Được dùng | Được dùng |
| Trang Quản trị | Bị yêu cầu đăng nhập | Từ chối | Cho phép |
| Đọc vai trò của chính mình | Không | Có | Có |
| Sửa bảng `user_roles` từ trình duyệt | Không | Không | Không |

- Supabase Auth xác minh email/mật khẩu và phát hành token; ứng dụng không lưu mật khẩu.
- Token chỉ lưu trong `sessionStorage`, tự mất khi đóng tab. Publishable key được phép có ở frontend; secret/service-role key tuyệt đối không đưa vào `index.html`.
- Quyền `admin` được đối chiếu từ `public.user_roles` bằng token của người dùng và RLS `auth.uid() = user_id`.
- Lệnh in đi qua Supabase RPC và không yêu cầu mã quyền Web: bất kỳ ai có link ứng dụng đều có thể gửi lệnh. Agent máy trạm vẫn bắt buộc dùng token riêng; RLS tiếp tục chặn đọc/ghi trực tiếp các bảng hàng đợi.

## Khi nào xem lại

Xem lại các quy tắc này khi thay đổi cấu trúc form, danh sách chờ in, header, thanh hành động, kích thước tem in, vai trò Supabase hoặc cơ chế xác minh Apps Script.

## Agent máy trạm mới

- Source agent độc lập nằm trong `workstation-agent/` và dự kiến cài tại `C:\PrintSKUAgent`.
- Agent mới hỗ trợ `sku:v1` và `group_uid:v1`; không được đọc hoặc sửa `C:\AuditFactory`.
- Quy tắc dữ liệu, bảo mật, queue lease và mức bằng chứng nằm trong `workstation-agent/RULES.md`.
- Web dùng lớp tương thích để chuyển ba thao tác hàng đợi cũ sang Supabase mà không sửa rộng bundle React đã minify.
- Màn hình `#group-uid` cho phép bỏ trống SKU; nếu nhập SKU hợp lệ thì tên sản phẩm được tra từ `public.SKU_Name`, nếu không người dùng nhập tên thủ công.
- Trang đầu `#home` hiển thị ba lựa chọn `PRINT SKU`, `PRINT UID` và `INSPECTION` dưới tiêu đề `WH-MATERIAL` (tiêu đề tab trình duyệt cũng là `WH-MATERIAL`).
- Màn `#inspection` (Sub-Material Inspection Report): người dùng import file PO phụ liệu (.xls BIFF8 hoặc .xlsx, đọc thuần trên trình duyệt không thư viện ngoài), app tách cột STT/SKU/Tên/Mã NCC/Số lượng rồi tách Tên phụ liệu / Trim Supplier / Màu theo quy chuẩn đặt tên SKU. Bảng cho sửa tay từng ô; SL kiểm tự tính theo bảng AQL (0.4). Xuất ra file `.xlsx` bằng cách copy template `BÁO CÁO KIỂM TRA ĐẦU VÀO PHỤ LIỆU` nhúng sẵn (base64) và chỉ ghi đè giá trị ô, giữ nguyên style/border/merge. Web chỉ hiển thị ba trường: P/O (sửa được), Rcvd date (sửa được) và Tổng SL (chỉ đọc); Invoice, Buyer, Style không hiện trên web. Ánh xạ ô khi xuất: C5 Buyer = MASTIGE cố định, C6 Invoice (text) = số PO, C7 Style để trống, C8 P/O (text) = số PO, C9 tổng SL, F5 Rcvd date, F6 Insp date để trống; vùng dữ liệu dòng 14–49 (A SKU, B Tên, C Supplier, D Màu, E SL hóa đơn, H SL kiểm). Giữ nguyên độ rộng cột và toàn bộ định dạng của template — chỉ ghi giá trị vào các ô có sẵn, không được chèn ô mới (sai thứ tự cột sẽ hỏng file).
- Màn hình in tem SKU (`#worker`) mang tiêu đề `PRINT SKU` kèm dòng phiên bản; nút `← WH-MATERIAL` ghim ở mép trên bên phải (desktop trong dải header, mobile thành nút tròn `←` ngay dưới header). Ba dòng hướng dẫn tĩnh dưới ô nhập đã bỏ; dòng nhắc động chỉ hiện khi có nội dung (đang tra/kết quả tra SKU). Font toàn app thống nhất Arial.
- Màn `#group-uid` dùng thanh header dính giống `PRINT SKU`: logo máy in + tên `PRINT UID` + dòng phiên bản, pill trạng thái máy in (tự cập nhật 20 giây/lần từ hàng đợi: `Máy in rảnh` / thông báo lỗi máy in / `Chưa rõ máy in` khi agent mất liên lạc quá 15 giây) và nút `← WH-MATERIAL`.
- `PRINT UID` chia đúng 4 cụm đánh số: `1 Thêm Group UID` và `3 Chưa gán SKU` ở cột trái; `2 Gán SKU` và `4 Sẵn sàng in` ở cột phải (mobile xếp dọc 1 → 3 → 2 → 4 theo trình tự thao tác).
- Cụm 1 nhận UID theo hai cách: quét/nhập từng mã (Enter thêm liên tục) hoặc `Import từ file Excel` — đọc file export Group UID từ WMS (.xlsx), tự tìm cột `Group UID Code`, bỏ qua UID trùng và UID không hợp lệ; parser dùng DecompressionStream sẵn có của Chromium, không thêm thư viện ngoài.
- Cụm 2 có hai chế độ gán nằm trong hai tab riêng (`Gán theo tick chọn` mặc định, `Gán tự động`); mỗi lúc chỉ hiện một tab. Gán theo tick chọn: tick UID ở cụm 3 (hoặc `Chọn tất cả`) rồi nhập SKU (bỏ trống được, hiện nhãn `Không SKU`) và tên sản phẩm; Enter trong ô SKU/tên sản phẩm cũng kích hoạt gán. Gán tự động: nhập nhiều dòng `SKU + số UID + Tên SP` (mỗi dòng 1–500), hệ thống chia UID theo thứ tự danh sách cụm 3 từ trên xuống; tổng số UID các dòng không được vượt số UID đang chờ. Tên SP tự tra từ `public.SKU_Name` khi gõ SKU và có thể sửa/nhập tay; SKU được bỏ trống nếu đã có Tên SP (ô Tên SP gợi ý sẵn hai tên kho `WH - MATERIAL - GARMENT` và `WH - MATERIAL - MTG`); dòng nào thiếu cả SKU lẫn Tên SP, hoặc có SKU nhưng tra không được và không nhập tay, thì báo lỗi và không gán dòng nào.
- SKU có thể bỏ trống ở chế độ tick chọn. Tên sản phẩm và Group UID luôn bắt buộc; mỗi Group UID cố định in đúng 1 tem.
- Trong cụm 4 `Sẵn sàng in`, mỗi dòng có nút bỏ gán (trả UID về khung chờ, xóa mapping) và nút xóa hẳn. Nút `Xác nhận in` chỉ gửi các UID trong khung sẵn sàng; khung chờ giữ nguyên.
- Một lần xác nhận trên giao diện gửi toàn bộ danh sách thành một lệnh `group_uid:v1` dạng batch (`payload.items`, tối đa 100 UID mỗi lệnh; vượt quá thì tự chia thành nhiều lệnh).
- Agent từ 0.3.0 trải phẳng mọi tem của một lệnh rồi ghép 2 tem liền kề — kể cả 2 Group UID khác nhau — lên cùng một hàng giấy 2 tem, nên không còn phí tem bên phải; chỉ tem cuối cùng của lệnh có tổng lẻ mới để trống nửa hàng. Agent 0.2.2 trở xuống không đọc được lệnh batch và phải được cài lại.
- Muốn sửa mapping của một UID đã gán: bấm bỏ gán để trả về khung chờ rồi gán lại; không chỉnh riêng trên từng dòng.
- Khung 3 và 4 hiển thị dạng danh sách gọn, có badge đếm số dòng; nội dung dài rút gọn bằng dấu ba chấm nhưng vẫn có tooltip xem đầy đủ. Danh sách dài cuộn bên trong khung, khu vực gán và nút in luôn nhìn thấy.
