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
- Màn `#inspection` (Sub-Material Inspection Report): người dùng import file PO phụ liệu (.xls BIFF8 hoặc .xlsx, đọc thuần trên trình duyệt không thư viện ngoài), app tách cột STT/SKU/Tên/Mã NCC/Số lượng rồi tách Tên phụ liệu / Trim Supplier / Màu theo quy chuẩn đặt tên SKU. Bảng cho sửa tay từng ô; SL kiểm tự tính theo bảng AQL (0.4). Xuất ra file `.xlsx` bằng cách copy template `BÁO CÁO KIỂM TRA ĐẦU VÀO PHỤ LIỆU` nhúng sẵn (base64) và chỉ ghi đè giá trị ô, giữ nguyên style/border/merge. Tách NCC/Màu: NCC lấy phần sau dấu `_` của đoạn `<mã>_<tên NCC>` (mã cho phép chứa dấu chấm/gạch, vd `W.TT.S-07-323H_Triều Vĩ` → `Triều Vĩ`); Màu lấy đoạn có chữ và cắt bỏ mã NCC ở đuôi (vd `Be ca cao-Etherea WKF-12473` → `Be ca cao-Etherea`), dự phòng theo đoạn trước `Size` hoặc đoạn dạng `Tên màu_Mã`. Cột Tên (B) giữ nguyên tên đầy đủ từ PO. Web chỉ hiển thị ba trường: P/O (sửa được), Rcvd date (sửa được) và Tổng SL (chỉ đọc). Ánh xạ ô khi xuất: C5 Buyer = MASTIGE cố định, C6 Invoice để trống, C7 Style để trống, C8 P/O (text) = số PO, C9 tổng SL, F5 Rcvd date, F6 Insp date để trống; vùng dữ liệu dòng 14–49 (A SKU, B Tên, C Supplier, D Màu, E SL hóa đơn, F Rec'd Qty = E, H SL kiểm theo AQL). Nâng cỡ chữ vùng dữ liệu lên 12pt (patch font Times New Roman index 4 & 7 trong `styles.xml` lúc xuất). Giữ nguyên độ rộng cột và toàn bộ định dạng của template — chỉ ghi giá trị vào các ô có sẵn, không được chèn ô mới (sai thứ tự cột sẽ hỏng file).
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

## Làm mới SKU từ Mastige Inside

Nguồn dữ liệu `SKU_Name` là màn `Products` trên `inside.mastige.vn`. Có hai đường, dùng cho hai mục đích khác nhau.

**Đường thường dùng — đọc thẳng bảng danh sách, không qua Excel:**

```
python scripts/refresh_skus.py quick     # in đoạn JS, dán vào Console tab inside đã đăng nhập
python scripts/refresh_skus.py apply     # nạp sku-changes-*.json vào data/sku.db
python scripts/refresh_skus.py sync      # upsert lên Supabase (không xoá dòng nào)
```

**Đường đối chiếu — tải Excel toàn bộ, chạy khi cần kiểm chứng:**

```
python scripts/refresh_skus.py snippet
python scripts/refresh_skus.py merge --cleanup
python scripts/refresh_skus.py sync
```

- Trang danh sách sắp theo `Modified` giảm dần và nhận tham số `&limit=` (mặc định 100, chạy tốt tới 3.000), nên `quick` chỉ đọc từ trên xuống tới khi chạm dòng cũ hơn mốc cắt rồi dừng. Đo thật ngày 18/09: **21 giây, 361 dòng, file JSON 112 KB** — so với ~10 phút và 5 MB Excel.
- Mốc cắt lấy theo `--days` (mặc định 7) chứ không lưu trạng thái lần chạy trước: nạp lại dòng không đổi là vô hại, còn mất trạng thái thì không bao giờ gây sót.
- Đổi tên SKU **có** làm `Modified` nhảy — đã kiểm chứng với 3 SKU đổi tên ngày 17/09, cả ba đều mang mốc `26-09-17 10:58`. Chưa có mẫu thật để xác nhận đổi trạng thái hay chuyển category có nhảy hay không, nên **vẫn phải chạy đường Excel định kỳ để đối chiếu**.

- Danh sách category nằm ở `scripts/sku_categories.json`. Thêm/bớt category chỉ sửa file này, không sửa code. `id` phải khớp `category_id` trên Inside, `name` phải khớp tên đang dùng trong Supabase.
- `merge` chỉ nhận file export chứa **đúng một** category và tự đối chiếu `category_id` bên trong file với cấu hình — không bao giờ nạp file dưới nhãn category sai. File nhiều category bị bỏ qua và liệt kê trong `ignored_files`.
- `merge` vừa thêm SKU mới vừa **cập nhật SKU đã có** khi tên, trạng thái, category, barcode, thương hiệu hoặc giá khác với file export; báo cáo có `updated` và `changed_fields` cho biết cột nào đổi bao nhiêu dòng. `--no-update` giữ hành vi chỉ thêm như bản đầu. Không có bước này thì tên sản phẩm đổi trên Inside sẽ không bao giờ tới được Supabase và tem in ra mang tên cũ.
- Cột số (`price`, `latest_cost`, `product_average_cost`) so theo **giá trị số** chứ không so chuỗi: bản nạp cũ lưu chuỗi rỗng còn export ghi `0`, so thô sẽ báo "đã đổi" cho gần như mọi dòng (đo thật: 7.752 dòng báo đổi trong khi chỉ 84 dòng đổi thật).
- Category nào chưa có file sẽ nằm trong `missing` và lệnh thoát khác 0; chạy lại snippet cho những category đó.
- Chỉ xét file tải trong 180 phút gần nhất (đổi bằng `--since-minutes`) để không nạp nhầm file export cũ. Khi có nhiều file cùng category thì lấy file mới nhất.
- Sao lưu trước khi nạp bằng `merge --backup data/sku.before-refresh.db` (chỉ sao lưu một lần cho cả lượt chạy).
- `merge --cleanup` xoá file export sau khi nạp xong. Chỉ xoá file của category đã nạp thành công, kể cả các bản trùng; file không đọc được, file nhiều category, file của category còn thiếu và mọi file khác trong thư mục đều giữ nguyên. Mặc định tắt vì đây là xoá file trong thư mục Downloads của người dùng.
- Mỗi lần bấm Download, Inside kích hoạt tải **hai lần** nên một category thường để lại 2 file trùng; `merge` luôn lấy file mới nhất nên không ảnh hưởng kết quả, nhưng không dọn thì Downloads phình dần.

Ràng buộc của Inside — đã kiểm chứng, đừng mất công thử lại:

- Không gọi được endpoint export từ ngoài: request trực tiếp trả **401**, nó chỉ chạy khi được nạp như script con từ trang inside đã đăng nhập. Vì vậy bắt buộc phải qua trình duyệt, không viết được script Python thuần.
- URL export dựng từ **địa chỉ trang**, không phải ô select category; muốn đổi category phải đổi trang (snippet dùng iframe cùng origin nên không phải tải lại tab đang mở).
- Server **cache file export theo từng category mỗi ngày** nên export lại gần như tức thì — retry không tốn gì.
- HTTP **503 khi tải nghĩa là file chưa tạo xong**, không phải lỗi quyền; gọi lại là được. Snippet tự thử tối đa 3 lần bằng cách đọc nội dung iframe.
- Export không lọc category (toàn bộ catalog) chạy quá 8 phút chưa xong — không dùng.
- **Tên sản phẩm trong bảng HTML nằm trong thẻ `<a>` của ô Product Name; chữ đứng trước thẻ đó là tên thương hiệu và KHÔNG thuộc `product_name`.** Ô đó là `No brand - <a>Chỉ quấn chân nút/...</a>`. Lấy `textContent` cả ô sẽ dính tiền tố và làm đổi sai toàn bộ 21.000 tên; phải lấy đúng nội dung thẻ `<a>`.
- **Bảng HTML render RỖNG các cột Barcode, LatestCost, Average Cost** — giá chỉ có trong file Excel. Vì vậy `apply` chỉ được phép cập nhật `product_name`, `status`, `category_id`, `category_name`. Lúc chạy thử đã đưa cả cột giá vào và ghi rỗng đè mất giá vốn của 44 dòng. Ngoài việc giới hạn danh sách cột, `apply` còn có chốt chặn thứ hai: không bao giờ ghi giá trị rỗng đè lên dữ liệu cũ.
- Nút Download thật là `#download-products`; trong trang còn link `Products` khác ở breadcrumb, click nhầm sẽ không kích hoạt export.

### Hạn chế còn lại: SKU ngừng Active

Export luôn lọc `status=1`, nên SKU bị ngừng Active **biến mất khỏi file** thay vì xuất hiện với trạng thái mới. Hệ quả: `merge` không thấy nó để cập nhật, và `sync` (chỉ gửi dòng `status = '1'`, upsert theo `sku`, không xoá) cũng không đụng tới bản ghi cũ trên Supabase. Bản ghi đó nằm lại vĩnh viễn với trạng thái Active.

Hiện tại đã có 3 SKU như vậy ở category 954 (`[SKU_DA_XOA]`, `[SKU_DA_XOA]`, `[SKU_DA_XOA]`) — Supabase 21.161 dòng so với 21.158 dòng local.

Chưa xử lý tự động vì phải quyết định trước: xoá hẳn khỏi Supabase thì tem đã in không tra được tên nữa, nên hướng đúng là đánh dấu ngừng Active chứ không xoá. Muốn làm thì cần đối chiếu danh sách SKU của từng category giữa local và export rồi đẩy trạng thái mới lên, và phải có chốt chặn không cho một file export lỗi/thiếu dòng làm ngừng hàng loạt SKU.
