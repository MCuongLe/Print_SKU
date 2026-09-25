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
| Màn hình Sample | Được dùng | Được dùng | Được dùng |
| Trang Quản trị | Bị yêu cầu đăng nhập | Từ chối | Cho phép |
| Đọc vai trò của chính mình | Không | Có | Có |
| Sửa bảng `user_roles` từ trình duyệt | Không | Không | Không |

- Supabase Auth xác minh email/mật khẩu và phát hành token; ứng dụng không lưu mật khẩu.
- Token chỉ lưu trong `sessionStorage`, tự mất khi đóng tab. Publishable key được phép có ở frontend; secret/service-role key tuyệt đối không đưa vào `index.html`.
- Quyền `admin` được đối chiếu từ `public.user_roles` bằng token của người dùng và RLS `auth.uid() = user_id`.
- Lệnh in đi qua Supabase RPC và không yêu cầu mã quyền Web: bất kỳ ai có link ứng dụng đều có thể gửi lệnh. Agent máy trạm vẫn bắt buộc dùng token riêng; RLS tiếp tục chặn đọc/ghi trực tiếp các bảng hàng đợi.

## Khi nào xem lại

### Tra Group UID từ database

- Nhập/quét hoặc import Group UID gọi `group_uid_lookup` theo từng lô tối đa 100 mã chính xác.
- Object là tem Group UID. SKU từ `group_uid_details.sku`; tên chỉ từ `SKU_Name.product_name`; Lot từ `batch_code`, Roll từ `roll_code`.
- Có tên sản phẩm thì tự sang Sẵn sàng in, không cần thao tác gán SKU. Không có SKU vẫn cho in khi có tên; thiếu tên thì chờ bổ sung thủ công. Không tự bịa tên từ mã hoặc tên kho.
- Mỗi UID một tem; Qty trong database là số lượng hàng, không phải số bản in. Vẫn cần bấm Xác nhận in.
- UID trùng, kể cả đang tra, không thêm lần hai. Khi đang tra không gửi in. Lỗi mạng phải báo không tra được, không khẳng định mã không tồn tại.
- RPC chỉ đọc trường phục vụ tem, không trả người cập nhật, kho, vị trí hoặc số lượng tồn. Không cấp quyền trực tiếp lên bảng. Migration `group_uid_v2_lookup.sql` đã triển khai sau khi chủ ứng dụng xác nhận quyền tra cứu không đăng nhập ngày 22/09/2026.
- Migration `group_uid_v3_drop_product.sql` loại cột tên trùng `product` theo yêu cầu; Excel WMS vẫn có thể chứa Product Name nhưng script nhập bỏ qua. SKU chưa có tên trong `SKU_Name` phải chờ bổ sung tên thủ công, không tự chuyển sang Sẵn sàng in.
- Đã kiểm tra Chromium desktop 1280px/mobile 375px bằng dữ liệu giả: tự gán, giữ lot/roll, không SKU, mã trùng đang tra, không tìm thấy, thiếu tên, lỗi mạng, gán tay và payload in. Đã kiểm tra RPC thật qua frontend: tự chuyển sang Sẵn sàng in, đủ tên/SKU/lot/roll. CHƯA VERIFY: import Excel qua trình duyệt, máy quét và bản in thật.

### Admin nạp Excel Group UID

- Chỉ tài khoản Supabase Auth có `user_roles.role = admin` được gọi RPC import. Chốt quyền phải nằm trong mỗi RPC; ẩn nút trên giao diện không phải là phân quyền.
- Frontend không có `service_role`, personal access token hoặc quyền ghi trực tiếp `group_uid_details`, `group_uid_import_runs`, `group_uid_import_rows`.
- File tối đa 10 MB / 50.000 dòng, tải staging từng lô tối đa 500. Mã trùng, thiếu Group UID, Qty âm/sai, ngày sai hoặc Status trống là lỗi chặn.
- Product Name bị bỏ qua. Ánh xạ 10 trường theo `docs/GROUP_UID_ADMIN_IMPORT_DESIGN.md`; ngày không có timezone dùng UTC+07:00.
- Phải validate đủ `uploaded_rows = expected_rows`, không có mã trùng rồi mới bật nút commit. Commit là upsert nguyên tử, không xóa mã vắng mặt và không ghi đè `Updated Date` mới hơn.
- Hash SHA-256 dùng cảnh báo file đã nạp; import lại vẫn được phép và phải idempotent. Dữ liệu staging của lượt completed/failed quá 7 ngày được dọn khi tạo lượt mới; metadata lịch sử được giữ.
- Ô **Cập nhật** mở chi tiết theo trang qua RPC `group_uid_import_update_details`; mỗi UID phải hiển thị đúng trường thay đổi, giá trị database và giá trị file. RPC chỉ đọc lượt nạp do chính Admin tạo, hỗ trợ tìm theo Group UID/SKU và không cấp cho `anon`.
- Đã kiểm tra file WMS thật 8.148 dòng trên Chromium 1280px và 375px bằng RPC mock; đã kiểm tra RPC thật bằng transaction rollback, gồm start → chunk → validate → commit. Đã xác minh `anon` không gọi được RPC và `authenticated` không ghi trực tiếp bảng. CHƯA VERIFY: thao tác đăng nhập Admin và import thật qua trang production.

Xem lại các quy tắc này khi thay đổi cấu trúc form, danh sách chờ in, header, thanh hành động, kích thước tem in, vai trò Supabase hoặc cơ chế xác minh Apps Script.

## Agent máy trạm mới

- Source agent độc lập nằm trong `workstation-agent/` và dự kiến cài tại `C:\PrintSKUAgent`.
- Agent mới hỗ trợ `sku:v1` và `group_uid:v1`; không được đọc hoặc sửa `C:\AuditFactory`.
- Quy tắc dữ liệu, bảo mật, queue lease và mức bằng chứng nằm trong `workstation-agent/RULES.md`.
- Web dùng lớp tương thích để chuyển ba thao tác hàng đợi cũ sang Supabase mà không sửa rộng bundle React đã minify.
- Màn hình `#group-uid` cho phép bỏ trống SKU; nếu nhập SKU hợp lệ thì tên sản phẩm được tra từ `public.SKU_Name`, nếu không người dùng nhập tên thủ công.
- Trang đầu `#home` hiển thị bốn lựa chọn `PRINT SKU`, `PRINT UID`, `INSPECTION` và `SAMPLE` dưới tiêu đề `WH-MATERIAL` (tiêu đề tab trình duyệt cũng là `WH-MATERIAL`).
- Màn `#inspection` (Sub-Material Inspection Report): người dùng import file PO phụ liệu (.xls BIFF8 hoặc .xlsx, đọc thuần trên trình duyệt không thư viện ngoài), app tách cột STT/SKU/Tên/Mã NCC/Số lượng rồi tách Tên phụ liệu / Trim Supplier / Màu theo quy chuẩn đặt tên SKU. Bảng cho sửa tay từng ô; SL kiểm tự tính theo bảng AQL (0.4). Xuất ra file `.xlsx` bằng cách copy template `BÁO CÁO KIỂM TRA ĐẦU VÀO PHỤ LIỆU` nhúng sẵn (base64) và chỉ ghi đè giá trị ô, giữ nguyên style/border/merge. Tách NCC/Màu: NCC lấy phần sau dấu `_` của đoạn `<mã>_<tên NCC>` (mã cho phép chứa dấu chấm/gạch, vd `W.TT.S-07-323H_Triều Vĩ` → `Triều Vĩ`); Màu lấy đoạn có chữ và cắt bỏ mã NCC ở đuôi (vd `Be ca cao-Etherea WKF-12473` → `Be ca cao-Etherea`), dự phòng theo đoạn trước `Size` hoặc đoạn dạng `Tên màu_Mã`. Cột Tên (B) giữ nguyên tên đầy đủ từ PO. Web chỉ hiển thị ba trường: P/O (sửa được), Rcvd date (sửa được) và Tổng SL (chỉ đọc). Ánh xạ ô khi xuất: C5 Buyer = MASTIGE cố định, C6 Invoice để trống, C7 Style để trống, C8 P/O (text) = số PO, C9 tổng SL, F5 Rcvd date, F6 Insp date để trống; vùng dữ liệu dòng 14–49 (A SKU, B Tên, C Supplier, D Màu, E SL hóa đơn, F Rec'd Qty = E, H SL kiểm theo AQL). Nâng cỡ chữ vùng dữ liệu lên 12pt (patch font Times New Roman index 4 & 7 trong `styles.xml` lúc xuất). Giữ nguyên độ rộng cột và toàn bộ định dạng của template — chỉ ghi giá trị vào các ô có sẵn, không được chèn ô mới (sai thứ tự cột sẽ hỏng file).
- Màn `#sample` (gom hàng mẫu vào bao): người đóng bao quét mã QR SKU trên hàng mẫu bằng máy Honeywell. SKU không có trong danh mục tổng `public."SKU_Name"` bị báo `SKU này inactive` và không mở bao. SKU hợp lệ quét lần đầu sinh bao mới rồi hiện popup chặn màn hình có nút `Xác nhận` để ghi số bao lên bao thật; quét lần 2 trở đi chỉ hiện thẻ `SKU này đã có bao` kèm số bao và số mẫu đang có, không chặn màn hình để quét liên tục.
- Mỗi SKU chiếm đúng một bao. Số bao chạy từ 1 trên **một danh sách duy nhất**, không reset theo ngày hay theo đợt — do chủ hệ thống chốt ngày 19/09/2026. Muốn chia đợt thì phải thêm cột đợt vào `sample_bags` chứ không sửa được bằng giao diện.
- Dữ liệu bao nằm ở bảng `public.sample_bags` (`bag_no`, `sku`, `quantity`), tạo bằng `supabase/sample_bag_v1.sql`. Bảng bật RLS và bị thu hồi quyền với `anon`/`authenticated`; web chỉ đi qua bốn RPC security definer `sample_scan`, `sample_list`, `sample_decrement`, `sample_delete` — cùng khuôn với hàng đợi in.
- `sample_scan` khoá bằng `pg_advisory_xact_lock` trước khi cấp số bao mới nên hai máy quét cùng lúc không giành trùng số. Số bao mới lấy `max(bag_no) + 1`: xoá bao cuối rồi quét lại thì số đó được dùng lại, còn xoá bao giữa thì để lại khoảng trống — cố ý, vì số bao đã ghi lên bao thật không được đánh lại.
- Chốt chặn SKU inactive nằm ở **cả hai đầu**: giao diện hiển thị thông báo, còn `sample_scan` từ chối ghi. Không bỏ chốt phía RPC — nó là thứ duy nhất giữ cho bảng bao không dính SKU lạ.
- Sửa quét nhầm ngay trên danh sách chỉ còn **một** thao tác: nút `−` bớt 1 mẫu (bao còn đúng 1 mẫu thì biến mất luôn vì bao rỗng vô nghĩa). Mỗi lần bấm tối đa hỏng 1 mẫu.
- **Xoá cả bao đã bị gỡ khỏi giao diện và thu hồi quyền dưới database** (`supabase/sample_bag_v2_lock_delete.sql`). Lý do: app không có màn hình đăng nhập, nên bất kỳ ai có link cũng gọi được mọi RPC đang mở cho `anon` — bỏ nút thôi là vô nghĩa, phải `revoke execute` mới thật sự chặn. Đã kiểm chứng: gọi thẳng `sample_delete` bằng publishable key trả `42501 permission denied for function sample_delete`. Hàm vẫn còn đó cho người quản trị chạy qua SQL Editor hoặc `scripts/apply_supabase_sql.py`.
- Hệ quả phải chấp nhận: huỷ một bao đang có 20 mẫu phải bấm `−` 20 lần. Đó là chủ ý — thao tác phá dữ liệu phải chậm và có giới hạn thiệt hại mỗi lần bấm.
- Bảng bao không lưu tên sản phẩm; tên luôn tra lại từ `public."SKU_Name"` để danh sách và file xuất không mang tên cũ.
- `Xuất Excel theo dõi` dựng file `.xlsx` từ đầu (không template) bằng bộ ghi zip `window.PrintSkuZip.buildZip` dùng chung với màn Inspection: cột `STT bao / SKU / Tên sản phẩm / Số lượng / Mở bao lúc / Cập nhật lúc`, dòng cuối là `TỔNG`.
- **Cách chỉnh trên máy Honeywell, đã xác minh ngày 19/09:** `Settings → Honeywell Settings → Scanning → Internal Scanner → Default Profile → Data Processing Settings → Wedge Method`, đổi từ **Standard** sang **Keyboard**. `Standard` bơm phím giả ở tầng hệ thống — ô nhập gốc Android nhận được nhưng nội dung web trong Chrome thì không. `Keyboard` gõ qua IME Honeywell nên trang web nhận được như gõ tay. Đây là cách duy nhất làm máy quét chạy với app, không phải việc của code.
- Ô SKU mặc định đặt `inputmode="none"` để bàn phím ảo Android không bật lên che màn hình. Nhưng máy quét chế độ Keyboard gõ qua chính IME đó, nên **bắt buộc phải có nút bật lại** — trạng thái nhớ trong `localStorage` của từng máy. Đừng biến nó thành hằng số: nếu giấu bàn phím làm mất luôn đường nhập thì người vận hành kẹt cứng.
- Khung `Danh sách bao` dạng thả: bấm đầu khung mở ra, bấm lần nữa thu gọn; trạng thái nhớ trong `localStorage`, mặc định thu gọn cho gọn màn hình máy cầm tay. Badge đếm số bao, tổng mẫu và nút xuất Excel **luôn nhìn thấy** kể cả khi đang thu gọn.
- **Không được chờ đúng phím Enter.** Mỗi máy quét cấu hình một kiểu: có máy gửi Enter ở cuối, có máy không, có máy nhét cả cụm qua IME Android mà không sinh phím nào. Ô SKU tự chốt khi đứng yên 320 ms sau một cụm nhập nhanh (khoảng cách giữa hai ký tự dưới 60 ms, hoặc cả cụm vào một lúc) và dài từ 5 ký tự. Gõ tay chậm thì không tự chốt — phải Enter hoặc bấm nút, để không chốt hụt giữa chừng khi người ta đang gõ dở.
- `cleanScan` cắt tiền tố AIM identifier (`]Q0`, `]C1`…) mà nhiều máy quét bật sẵn, và lọc ký tự điều khiển / vô hình lọt vào theo cấu hình suffix. Hàm này **cố ý không dùng escape regex nào** (`\uXXXX`, `\]`) — viết bằng so sánh chuỗi và mã số ký tự — vì escape bị biến dạng khi đi qua lớp công cụ và đã một lần làm cả màn Sample chết vì regex hỏng.
- `scanner-check.html` là trang chẩn đoán máy quét, mở trực tiếp cạnh `index.html`. Nó hiện chuỗi thô, số ký tự, ký tự kết thúc, nhật ký từng phím, và tự tra `SKU_Name` để phân biệt ba ca: máy quét không gửi gì, gửi thiếu Enter, hay mã QR chứa nhiều thứ ngoài SKU. Trang này chỉ đọc, không ghi vào bảng bao.
- **Máy Honeywell ngoài hiện trường (đo 19/09) KHÔNG đưa được ký tự vào trình duyệt — lỗi nằm ở cấu hình máy, không phải ở app.** Đo hai lần bằng `scanner-check.html`: mỗi lần quét sinh 4–5 sự kiện `keydown` mang `key="Unidentified"`, `keyCode = 0`, và **không có một sự kiện chữ nào** (`beforeinput`, `input`, `compositionstart/update/end`, `paste` đều trống), ô nhập rỗng. Số phím (4, rồi 5) không khớp độ dài SKU (9 ký tự) nên đó không phải mã đang được gõ. Kết luận: máy đang chạy chế độ Intent/broadcast chứ không phải Keyboard Wedge, hoặc dùng kiểu inject phím mà nội dung web không dịch ra ký tự. **Không có thay đổi nào trong trang web lấy được mã ở chế độ đó** — đừng mất công sửa app, phải đổi cấu hình trên máy.
- **Máy quét đi qua IME Android, không phải bàn phím HID thuần.** Đo thật ngày 19/09 bằng `scanner-check.html`: một lần quét sinh 5 sự kiện phím cách nhau ~50 ms nhưng **mọi phím đều mang `key="Unidentified"`, `keyCode = 0`** — ký tự thật không nằm trong sự kiện phím, nó chỉ chui vào ô đang được focus. Hệ quả: lọc phím theo `key.length === 1` là bỏ sót đúng loại máy này, và focus rơi ra ngoài ô là mất nguyên mã, không cứu lại được. Vì vậy màn `#sample` vừa bắt cả `Unidentified`/`Process`, vừa kéo con trỏ về ô mỗi khi nó rơi ra ngoài (trừ lúc người dùng đang bấm nút trong màn hoặc popup đang mở).
- **Timeout phía client không chứng minh được là server chưa ghi.** Đo thật ngày 19/09: một lệnh xoá bao báo `signal timed out` nhưng đã xoá xong trên database. Vì vậy thông báo lỗi tuyệt đối không được nói "chưa ghi gì" — nó phải nói là chưa rõ, và tự tải lại danh sách để người dùng nhìn sự thật từ server. Nói chắc ở đây thì người quét sẽ quét lại và bao bị đếm gấp đôi.
- Máy quét Honeywell gõ như bàn phím nên mất focus là mất nguyên mã: màn `#sample` kéo mọi phím ký tự lạc về ô SKU. Lúc popup bao mới đang mở thì ô SKU bị chặn — phải bấm `Xác nhận` (hoặc `Esc`) rồi mới quét tiếp, nên mã quét trong lúc popup mở sẽ mất.
- **Ô tên hàng ở `PRINT SKU` phải bị đặt lại mỗi khi ô SKU đổi giá trị**, và phải bị xoá khi tra cứu danh mục thất bại. Ngày 23/09/2026 đã in ra tem mang **số của mã này nhưng tên của mã khác**: tên của `[SKU_DA_XOA]` (`…/38/`) nằm trên tem số `[SKU_DA_XOA]`, tên của `[SKU_DA_XOA]` (`…/30/`) nằm trên tem số `[SKU_DA_XOA]`. Người vận hành nhập đúng; lỗi do mã cũ chỉ điền tên khi ô tên đang rỗng (`ae&&!e.trim()`) nên sửa số mà tên ở nguyên, còn nhánh tra cứu lỗi mạng (`S("mang")`) thì thoát mà không đụng tới tên. Tệ hơn, `pl(Y,j)` ghi cặp sai đó vào `localStorage` `tem-sotay`, khiến máy đó lặp lại lỗi mãi mà không cần mạng. Bộ nhớ `tem-sotay` chỉ còn là gợi ý hiện nhanh, **không bao giờ đi vào tem**: tên nào chưa được danh mục xác nhận cho đúng SKU đó thì bị chặn không cho thêm vào danh sách in. Nhờ vậy bộ nhớ có nhiễm bẩn cũng vô hại và không phải xoá tay.

Bốn quy tắc bắt buộc giữ, tương ứng bốn đường vào:
  - **gõ tay** đổi ô SKU → đặt lại tên theo đúng SKU mới (tên nhớ của chính nó hoặc rỗng), đánh dấu chưa xác nhận
  - **quét mã** → y như trên, tuyệt đối không giữ tên của mã trước
  - **danh mục trả về tên** → ghi tên và đánh dấu đã xác nhận
  - **tra cứu lỗi mạng, hoặc mã không có trong danh mục** → xoá tên, bắt nhập tay có chủ đích
Người dùng tự gõ tên thì luôn được phép in — đó là chủ ý, vì mã mới chưa lên danh mục vẫn phải in được.
- Màn hình in tem SKU (`#worker`) mang tiêu đề `PRINT SKU` kèm dòng phiên bản; nút `← WH-MATERIAL` ghim ở mép trên bên phải (desktop trong dải header, mobile thành nút tròn `←` ngay dưới header). Ba dòng hướng dẫn tĩnh dưới ô nhập đã bỏ; dòng nhắc động chỉ hiện khi có nội dung (đang tra/kết quả tra SKU). Font toàn app thống nhất Arial.
- Màn `#group-uid` dùng thanh header dính giống `PRINT SKU`: logo máy in + tên `PRINT UID` + dòng phiên bản, pill trạng thái máy in (tự cập nhật 20 giây/lần từ hàng đợi: `Máy in rảnh` / thông báo lỗi máy in / `Chưa rõ máy in` khi agent mất liên lạc quá 15 giây) và nút `← WH-MATERIAL`.
- `PRINT UID` chia đúng 4 cụm đánh số: `1 Thêm Group UID` và `3 Chưa gán SKU` ở cột trái; `2 Gán SKU` và `4 Sẵn sàng in` ở cột phải (mobile xếp dọc 1 → 3 → 2 → 4 theo trình tự thao tác).
- Cụm 1 nhận UID theo hai cách: quét/nhập từng mã (Enter thêm liên tục) hoặc `Import từ file Excel` — đọc file export Group UID từ WMS (.xlsx), tự tìm cột `Group UID Code`, bỏ qua UID trùng và UID không hợp lệ; parser dùng DecompressionStream sẵn có của Chromium, không thêm thư viện ngoài.
- Cụm 2 có hai chế độ gán nằm trong hai tab riêng (`Gán theo tick chọn` mặc định, `Gán tự động`); mỗi lúc chỉ hiện một tab. Gán theo tick chọn: tick UID ở cụm 3 (hoặc `Chọn tất cả`) rồi nhập SKU (bỏ trống được, hiện nhãn `Không SKU`) và tên sản phẩm; Enter trong ô SKU/tên sản phẩm cũng kích hoạt gán. Gán tự động: nhập nhiều dòng `SKU + số UID + Tên SP` (mỗi dòng 1–500), hệ thống chia UID theo thứ tự danh sách cụm 3 từ trên xuống; tổng số UID các dòng không được vượt số UID đang chờ. Tên SP tự tra từ `public.SKU_Name` khi gõ SKU và có thể sửa/nhập tay; SKU được bỏ trống nếu đã có Tên SP (ô Tên SP gợi ý sẵn hai tên kho `WH - MATERIAL - GARMENT` và `WH - MATERIAL - MTG`); dòng nào thiếu cả SKU lẫn Tên SP, hoặc có SKU nhưng tra không được và không nhập tay, thì báo lỗi và không gán dòng nào.
- Tab `Gán theo tick chọn` có thêm hai ô `Lot` và `Roll` (tối đa 20 ký tự, được bỏ trống). Giá trị gán theo từng UID và in ở đáy tem, thay cho việc ghi bút. Khung 4 hiện kèm `Lot …` / `Roll …` để soát trước khi in. Tab `Gán tự động` không có hai ô này.
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

`apply` ghi nhận file JSON đã nạp nhưng giữ file trong Downloads. `sync` chỉ dọn đúng các file JSON đã nạp sau khi **toàn bộ lô upsert Supabase thành công**; file mới/chưa nạp hoặc đã bị sửa nội dung được giữ lại. `sync --dry-run` và lần sync lỗi không xoá file. Nếu `apply` dùng `--downloads` khác mặc định, truyền cùng thư mục đó cho `sync --downloads`. Không dùng `apply --cleanup` vì xoá trước khi đồng bộ có thể làm mất dữ liệu cần thử lại.

**Đường đối chiếu — tải Excel toàn bộ, chạy khi cần kiểm chứng:**

```
python scripts/refresh_skus.py snippet
python scripts/refresh_skus.py merge --cleanup
python scripts/refresh_skus.py sync
```

- Trang danh sách sắp theo `Modified` giảm dần và nhận tham số `&limit=` (mặc định 100, chạy tốt tới 3.000), nên `quick` chỉ đọc từ trên xuống tới khi chạm dòng cũ hơn mốc cắt rồi dừng. Đo thật ngày 18/09: **21 giây, 361 dòng, file JSON 112 KB** — so với ~10 phút và 5 MB Excel.
- Mốc cắt lấy theo `--days` (mặc định 7) chứ không lưu trạng thái lần chạy trước: nạp lại dòng không đổi là vô hại, còn mất trạng thái thì không bao giờ gây sót.
- Đổi tên SKU **có** làm `Modified` nhảy — đã kiểm chứng với 3 SKU đổi tên ngày 17/09, cả ba đều mang mốc `26-09-17 10:58`.

**Hai giả định do chủ hệ thống chốt ngày 18/09/2026:**

1. Inside **sẽ không đổi cấu trúc** bảng danh sách.
2. `Modified` **sẽ không bỏ sót** bất kỳ loại thay đổi nào.

Vì vậy đường Excel không cần chạy định kỳ nữa, chỉ chạy **khi được yêu cầu đối chiếu**. Hai chốt chặn trong `apply` vẫn giữ nguyên vì chúng không tốn gì khi giả định còn đúng — cầu dao đổi tên chưa bao giờ nổ trong vận hành bình thường, và chốt chặn chống ghi rỗng cũng vậy. Chúng chỉ có tác dụng đúng vào ngày một trong hai giả định trên sai, và khi đó biến sự cố âm thầm thành một lần dừng ồn ào.

Nếu về sau `apply` báo dừng vì đổi tên hàng loạt, hoặc một đợt đối chiếu Excel cho ra chênh lệch, thì chính là một trong hai giả định trên đã hết đúng — xem lại từ đó.

- Danh sách category nằm ở `scripts/sku_categories.json`. Thêm/bớt category chỉ sửa file này, không sửa code. `id` phải khớp `category_id` trên Inside, `name` phải khớp tên đang dùng trong Supabase.
- `merge` chỉ nhận file export chứa **đúng một** category và tự đối chiếu `category_id` bên trong file với cấu hình — không bao giờ nạp file dưới nhãn category sai. File nhiều category bị bỏ qua và liệt kê trong `ignored_files`.
- `merge` vừa thêm SKU mới vừa **cập nhật SKU đã có** khi tên, trạng thái, category, barcode, thương hiệu hoặc giá khác với file export; báo cáo có `updated` và `changed_fields` cho biết cột nào đổi bao nhiêu dòng. `--no-update` giữ hành vi chỉ thêm như bản đầu. Không có bước này thì tên sản phẩm đổi trên Inside sẽ không bao giờ tới được Supabase và tem in ra mang tên cũ.
- Cột số (`price`, `latest_cost`, `product_average_cost`) so theo **giá trị số** chứ không so chuỗi: bản nạp cũ lưu chuỗi rỗng còn export ghi `0`, so thô sẽ báo "đã đổi" cho gần như mọi dòng (đo thật: 7.752 dòng báo đổi trong khi chỉ 84 dòng đổi thật).
- Category nào chưa có file sẽ nằm trong `missing` và lệnh thoát khác 0; chạy lại snippet cho những category đó.
- Chỉ xét file tải trong 180 phút gần nhất (đổi bằng `--since-minutes`) để không nạp nhầm file export cũ. Khi có nhiều file cùng category thì lấy file mới nhất.
- Sao lưu trước khi nạp bằng `merge --backup data/sku.before-refresh.db` (chỉ sao lưu một lần cho cả lượt chạy).
- `merge --cleanup` xoá file export sau khi nạp xong. Chỉ xoá file của category đã nạp thành công, kể cả các bản trùng; file không đọc được, file nhiều category, file của category còn thiếu và mọi file khác trong thư mục đều giữ nguyên. Mặc định tắt vì đây là xoá file trong thư mục Downloads của người dùng.
- Mỗi lần bấm Download, Inside kích hoạt tải **hai lần** nên một category thường để lại 2 file trùng; `merge` luôn lấy file mới nhất nên không ảnh hưởng kết quả, nhưng không dọn thì Downloads phình dần.
- **Cảnh báo tên vượt 180 ký tự (25/09/2026).** Cả `apply` (đường quick) và `merge` (đường Excel) đều quét `product_name` của mọi dòng nạp và in danh sách SKU nào dài hơn `AGENT_PRODUCT_NAME_LIMIT = 180` ra stderr (không chặn nạp — đây chỉ là cảnh báo, khác với cầu dao đổi tên ở trên). Lý do: `workstation-agent/src/job-validator.mjs` cắt cứng `productName` ở 180 ký tự lúc nhận lệnh in; tên dài hơn mức đó vẫn nạp/sync bình thường vào Supabase nhưng sẽ bị agent tự cắt mất đuôi khi lên tem, âm thầm giống lỗi SKU [SKU_DA_XOA] ngày 24/09/2026 (khi đó là web tự cắt ở 140, không phải agent — nhưng agent vẫn sẽ cắt nếu tên THẬT SỰ dài hơn 180). Kiểm chứng ngày 18/09/2026 từng thấy tên dài nhất trong catalog là 191 ký tự, tức là đã có tiền lệ vượt mức này. Thấy cảnh báo này thì cân nhắc nâng `cleanText(item.productName, 180)` trong `job-validator.mjs` lên mức phù hợp rồi phát hành agent bản mới.

Ràng buộc của Inside — đã kiểm chứng, đừng mất công thử lại:

- Không gọi được endpoint export từ ngoài: request trực tiếp trả **401**, nó chỉ chạy khi được nạp như script con từ trang inside đã đăng nhập. Vì vậy bắt buộc phải qua trình duyệt, không viết được script Python thuần.
- URL export dựng từ **địa chỉ trang**, không phải ô select category; muốn đổi category phải đổi trang (snippet dùng iframe cùng origin nên không phải tải lại tab đang mở).
- Server **cache file export theo từng category mỗi ngày** nên export lại gần như tức thì — retry không tốn gì.
- HTTP **503 khi tải nghĩa là file chưa tạo xong**, không phải lỗi quyền; gọi lại là được. Snippet tự thử tối đa 3 lần bằng cách đọc nội dung iframe.
- Export không lọc category (toàn bộ catalog) chạy quá 8 phút chưa xong — không dùng.
- **Tên sản phẩm trong bảng HTML nằm trong thẻ `<a>` của ô Product Name; chữ đứng trước thẻ đó là tên thương hiệu và KHÔNG thuộc `product_name`.** Ô đó là `No brand - <a>Chỉ quấn chân nút/...</a>`. Lấy `textContent` cả ô sẽ dính tiền tố và làm đổi sai toàn bộ 21.000 tên; phải lấy đúng nội dung thẻ `<a>`.
- **Bảng HTML render RỖNG các cột Barcode, LatestCost, Average Cost** — giá chỉ có trong file Excel. Vì vậy `apply` chỉ được phép cập nhật `product_name`, `status`, `category_id`, `category_name`. Lúc chạy thử đã đưa cả cột giá vào và ghi rỗng đè mất giá vốn của 44 dòng. Ngoài việc giới hạn danh sách cột, `apply` còn có chốt chặn thứ hai: không bao giờ ghi giá trị rỗng đè lên dữ liệu cũ.
- **Cầu dao đổi tên hàng loạt.** `apply` huỷ cả lượt nạp nếu số dòng đổi tên vượt `max(25 dòng, 20% số dòng đối chiếu)`. Lý do: lỗi đọc dữ liệu luôn làm gần như MỌI dòng "đổi tên", còn người thật sửa tên chỉ vài chục dòng. Đã thử lại bằng cách giả lập đúng lỗi tiền tố thương hiệu trên 300 dòng — cầu dao chặn và rollback. Chỉ dùng `--force` sau khi đã nhìn tận mắt danh sách tên mới.
- Kết quả kiểm chứng ngày 18/09 trên 1.666 dòng thuộc cả 7 category: tên đọc từ HTML **khớp tuyệt đối 1.666/1.666** với tên lấy từ Excel. Không có dòng nào bị cắt ngắn (dài nhất 191 ký tự), không có HTML entity, mỗi ô đúng một thẻ `<a>`. Phân trang cũng sạch: `page=1&limit=200` cho dòng 0–199, `page=2&limit=200` cho dòng 200–399, không trùng không sót.
- Nút Download thật là `#download-products`; trong trang còn link `Products` khác ở breadcrumb, click nhầm sẽ không kích hoạt export.

### Hạn chế còn lại: SKU ngừng Active

Export luôn lọc `status=1`, nên SKU bị ngừng Active **biến mất khỏi file** thay vì xuất hiện với trạng thái mới. Hệ quả: `merge` không thấy nó để cập nhật, và `sync` (chỉ gửi dòng `status = '1'`, upsert theo `sku`, không xoá) cũng không đụng tới bản ghi cũ trên Supabase. Bản ghi đó nằm lại vĩnh viễn với trạng thái Active.

Hiện tại đã có 3 SKU như vậy ở category 954 (`[SKU_DA_XOA]`, `[SKU_DA_XOA]`, `[SKU_DA_XOA]`) — Supabase 21.161 dòng so với 21.158 dòng local.

Chưa xử lý tự động vì phải quyết định trước: xoá hẳn khỏi Supabase thì tem đã in không tra được tên nữa, nên hướng đúng là đánh dấu ngừng Active chứ không xoá. Muốn làm thì cần đối chiếu danh sách SKU của từng category giữa local và export rồi đẩy trạng thái mới lên, và phải có chốt chặn không cho một file export lỗi/thiếu dòng làm ngừng hàng loạt SKU.


## Fabric Relaxation (23/09/2026)

- Nguồn yêu cầu: ảnh tem xả vải và chỉ đạo dùng cùng giấy/agent SKU, UID.
- Object: lệnh in `fabric_relaxation:v1`; mã hàng nhập tay, chưa đối chiếu danh mục (N3).
- Mã hàng: 1–40 ký tự chữ/số/chấm/gạch ngang/gạch dưới; giữ số 0 đầu. Rỗng hoặc ký tự khác: NG, chặn in.
- Số tem: số nguyên 1–500; ngoài phạm vi: NG. Giới hạn kế thừa hàng đợi hiện có.
- Tem 40 × 60 mm; 2 cột, khe ngang 2 mm, khe hàng 3 mm, 8 dot/mm, cùng renderer TSPL SKU/UID.
- Ngày, Giờ, Lot luôn là dòng chấm trống; không điền thời gian hệ thống hoặc dữ liệu Lot.
- Mã dài chia dòng mỗi 16 ký tự, tối đa 3 dòng; font monospace để không cắt mã rộng.
- Gửi qua PrintSkuQueue; khi lỗi mạng giữ nonce cho cùng dữ liệu để thử lại không tạo job trùng.
- Agent cũ không claim Fabric; cần migration v2 và agent 0.5.0. Giữ nguyên cơ chế quyền, lease và spooler hiện có.
- CHƯA VERIFY: chất lượng trên máy in vật lý, căn tem và độ đậm với cuộn giấy thực tế. Xem lại khi đổi giấy, driver, máy in hoặc quy tắc mã hàng.

### Fabric Relaxation v2 — nhiều mã trên một tem

- Object: lệnh in `fabric_relaxation:v2`; `itemCodes` là mảng 1–5 mã nhập riêng trên frontend (N3).
- Mỗi mã nằm đúng một dòng; font tự giảm để mã tối đa 40 ký tự không xuống dòng.
- Theo ảnh mẫu được người dùng đính chính: mã xếp liên tiếp phía trên; chỉ một bộ Ngày/Giờ/Lot dùng chung phía dưới, mỗi mục một dòng trống dài để ghi tay.
- Agent 0.6.1 sửa bố cục v2, hỗ trợ cả v1 và v2; không đổi payload hoặc migration. Máy trạm cần nâng 0.6.1 để in đúng mẫu mới.
- Migration áp dụng: `print_queue_v3_fabric_relaxation_multi_item.sql`; có thể chạy trực tiếp sau schema v1 hoặc v2.
- CHƯA VERIFY: khả năng ghi tay trên năm hàng ở tem thật 40 × 60 mm; phải in thử 1 và 5 mã trước khi dùng sản xuất.

### Fabric Relaxation v3 — tem viết tay hoàn toàn

- Frontend chỉ nhận số lượng 1–500; không còn ô nhập Mã hàng.
- Payload cố định `{handwritten:true}` với `templateVersion:3`; agent capability là `fabric_relaxation:v3`.
- Tem in: Mã hàng ở đầu tem và chừa khoảng hai dòng để viết; Lot nằm bên dưới; Ngày có mẫu `..... / .....`; Giờ có mẫu `..... : .....`.
- Cỡ chữ Mã hàng, Lot, Ngày và Giờ là 28, tăng 2 so với bố cục v2.
- Agent 0.7.0 vẫn giữ khả năng in job Fabric v1/v2 đang chờ. Migration áp dụng: `print_queue_v4_fabric_relaxation_handwritten.sql`.
- CHƯA VERIFY: khoảng viết tay và độ rõ cỡ chữ trên tem thật 40 × 60 mm; in thử trước khi dùng sản xuất.

## Cắt Group UID (23/09/2026)

- Object: một bản ghi `cut_group_uids`, khóa duy nhất là `group_uid_code`. Field snapshot gồm SKU, UID, Lot, Roll, Tên SP, thời gian cắt, trạng thái in và mã job in.
- Nguồn Field Value: `group_uid_details` cung cấp UID/SKU/Lot/Roll; `SKU_Name` cung cấp Tên SP. Dữ liệu được chụp lại lúc cắt để lịch sử không đổi theo danh mục về sau (N4: đối chiếu database nội bộ).
- Rule OK: UID dài 1–40 ký tự, tồn tại trong Group UID, có SKU và có Tên SP. Lot/Roll được phép rỗng vì mẫu tem hiện tại đã hỗ trợ trường hợp này.
- Rule NG: UID không tồn tại hoặc thiếu SKU/Tên SP thì chặn lưu và yêu cầu cập nhật dữ liệu Group UID. UID đã có trong bảng cắt bị chặn, kể cả tem cũ đã in, để tránh cắt hai lần.
- Trạng thái: `pending` (chờ in), `queued` (đã gửi agent), `printed` (agent hoàn tất), `failed` (agent báo lỗi). Chỉ `pending`/`failed` được chọn in hoặc xóa khỏi danh sách chờ.
- Một job tối đa 100 UID theo giới hạn batch `group_uid:v1`; mỗi UID đúng 1 tem và dùng nguyên format Group UID hiện tại.
- Tra cứu theo SKU dùng so khớp chứa, tối đa 5.000 dòng/lượt. Excel chỉ xuất đúng kết quả đang lọc với 5 cột SKU, UID, Lot, Roll, Tên SP; worksheet dùng Arial 12, header xanh dương, đóng khung từng ô và tự xuống dòng. Khổ A4 ngang chỉ co vừa một trang theo chiều rộng; nhiều UID tiếp tục sang trang 2, 3… và lặp lại header trên mỗi trang.
- Backend bật RLS và thu hồi quyền bảng trực tiếp; frontend anon chỉ gọi các RPC `cut_group_uid_*`, theo mô hình truy cập hiện hữu của ứng dụng.
- CHƯA VERIFY: bản in vật lý sau khi đi qua máy trạm và cách Excel phân trang trên phiên bản Microsoft Excel tại kho. Xem lại sau lần in/xuất thật đầu tiên.
