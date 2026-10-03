# Print SKU

Ứng dụng in tem SKU chạy trực tiếp từ `index.html`.

## Database SKU

Xuất danh sách sản phẩm từ Mastige Inside bằng menu **Download → File**, sau đó nhập file XLSX vào SQLite:

```powershell
python scripts/import_sku_xlsx.py "C:\path\to\hasaki-product-all-sku-cate.xlsx"
```

Database được tạo tại `data/sku.db`. Mỗi lần chạy, bảng `products` được thay bằng dữ liệu từ bản xuất mới nhất. Bảng `column_map` lưu ánh xạ tên cột Excel sang tên cột SQLite và `import_runs` lưu lịch sử nhập.

Để bổ sung một category đã lọc trên Mastige mà không ghi đè dữ liệu hiện có, tải bằng **Download → Category** rồi chạy:

```powershell
python scripts/merge_sku_category_xlsx.py "C:\path\to\product-list.xlsx" `
  --category-id 957 `
  --category-name "Thời Trang (NVL)" `
  --backup data/sku.before-merge.db
```

Lệnh ghép dùng SKU làm khóa, bỏ qua SKU trùng và lưu category đang chọn trên Mastige vào `category_id`/`category_name`.

Ví dụ tra cứu:

```sql
SELECT * FROM products WHERE sku = '100000001';
```

File database chứa dữ liệu nội bộ và được loại khỏi Git theo mặc định.

## Agent máy trạm

Source agent Windows độc lập dành cho ứng dụng này nằm trong [`workstation-agent`](workstation-agent/README.md). Agent mới có template riêng cho tem SKU và Group UID, không đọc hay sửa thư mục AuditFactory.

Agent hỗ trợ preview PNG, dựng TSPL không in, kiểm tra dữ liệu, kiểm tra máy in và hàng đợi Supabase có lease. Web chuyển các lệnh SKU sang queue mới và có màn hình `#group-uid`; SKU trong tem Group UID là tùy chọn, tên sản phẩm có thể tra tự động từ Supabase hoặc nhập thủ công.

## Màn Sample — gom hàng mẫu vào bao

Màn `#sample` quét mã QR SKU trên hàng mẫu, gom các mẫu cùng SKU vào một bao và báo SKU inactive.

Trước khi dùng, nạp schema một lần:

```powershell
python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql
python scripts/apply_supabase_sql.py supabase/sample_bag_v2_lock_delete.sql
```

Hoặc dán tay nội dung `supabase/sample_bag_v1.sql` vào Supabase SQL Editor nếu không muốn dùng token.

File này tạo bảng `public.sample_bags` (`bag_no`, `sku`, `quantity`) cùng bốn RPC `sample_scan`, `sample_list`, `sample_decrement`, `sample_delete`. Bảng bật RLS và không cho `anon` đọc/ghi trực tiếp — web chỉ gọi RPC, giống hàng đợi in. Chưa chạy file này thì màn Sample báo `Không đọc được danh sách bao`.

Số bao chạy từ 1 trên một danh sách duy nhất, không reset theo ngày hay theo đợt. Nút `Xuất Excel theo dõi` tạo file `.xlsx` ngay trên trình duyệt, không cần thư viện ngoài.

## Nạp schema lên Supabase

`scripts/apply_supabase_sql.py` chạy một file `.sql` lên project qua Management API — không cần `psql`, không cần Supabase CLI, chỉ dùng thư viện chuẩn của Python.

Một lần duy nhất: tạo **personal access token** ở https://supabase.com/dashboard/account/tokens (bắt đầu bằng `sbp_`), rồi đặt vào biến môi trường `SUPABASE_ACCESS_TOKEN` hoặc vào file `.env` ở gốc repo (`.env` đã nằm trong `.gitignore`).

```
SUPABASE_ACCESS_TOKEN=sbp_...
```

Token này khác publishable key và secret key: hai key kia chỉ tới được PostgREST nên không chạy được `create table`. Script không bao giờ in token ra màn hình.

```powershell
python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql --dry-run   # xem trước, không gọi Supabase
python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql             # chạy thật
```

Project ref lấy tự động từ `SUPABASE_URL`, ghi đè bằng `--project-ref`. Chạy xong script liệt kê lại toàn bộ bảng và hàm trong schema `public` để đối chiếu.

**Cầu dao:** file chứa `DROP`, `TRUNCATE` hay `DELETE FROM` ở cấp cao nhất bị chặn, phải thêm `--allow-destructive` mới chạy. Câu lệnh nằm trong thân hàm `$$ ... $$` không tính — đó là định nghĩa chứ không phải lệnh chạy, và nếu chặn cả hai thì ai cũng gõ `--allow-destructive` theo phản xạ, lúc đó cầu dao hết tác dụng.

## Database Group UID

`public.group_uid_details` lưu 10 trường: `group_uid_code`, `batch_code`,
`roll_code`, `warehouse`, `location`, `sku`, `qty`, `updated_by`,
`updated_date`, `status`. Khóa chính là Group UID Code; mã lưu dạng text để giữ
số 0 đầu. `qty` lấy từ Qty (không phải SKU Qty). Tên sản phẩm được tra qua
`SKU_Name.product_name` bằng SKU, không lưu lại trong bảng Group UID. SKU, vị trí
và người cập nhật có thể trống. Không ràng buộc SKU vào danh mục Active vì file
WMS có thể chứa SKU ngoài danh mục đó.

Tạo bảng một lần trên project hiện tại:

```powershell
python scripts/apply_supabase_sql.py supabase/group_uid_v1.sql
python scripts/apply_supabase_sql.py supabase/group_uid_v2_lookup.sql
python scripts/apply_supabase_sql.py supabase/group_uid_v3_drop_product.sql --allow-destructive
```

Kiểm tra rồi nhập file export (chỉ cần Python standard library):

```powershell
python scripts/import_group_uid_xlsx.py "C:\path\to\GROUP_UID_DETAIL.xlsx"
python scripts/import_group_uid_xlsx.py "C:\path\to\GROUP_UID_DETAIL.xlsx" --apply
```

Lệnh nhập dùng `SUPABASE_URL` và personal access token giống script nạp schema.
Toàn bộ file được kiểm tra trước khi gửi và upsert theo lô 500 dòng để nằm trong
giới hạn Management API; mỗi lô là một giao dịch nguyên tử. Nếu gián đoạn, các lô
đã xong vẫn được giữ; chạy lại cùng file để hoàn tất mà không tạo dòng trùng.
Mã trùng trong file, số lượng âm/không hợp lệ hoặc ngày thiếu/sai sẽ bị từ chối.
File cũ không ghi đè bản ghi có Updated Date mới hơn; mã không có trong file
không bị xóa. Ngày không có múi giờ được hiểu là UTC+07:00. Updated By và
Updated Date giữ thông tin WMS, không tự đổi thành người/giờ nhập Supabase.
Status giữ nguyên văn bản WMS để tiếp nhận trạng thái mới.

Bảng bật RLS; chưa mở quyền đọc/ghi cho `anon` hoặc `authenticated`.
Quản trị truy cập bằng SQL Editor/Management API hoặc backend `service_role`.
Không lưu file dữ liệu thật vào Git.

Màn `#group-uid` tự gọi RPC `group_uid_lookup` khi thêm mã hoặc import Excel,
chuyển UID đủ tên sản phẩm sang Sẵn sàng in. Tên lấy từ `SKU_Name`;
Batch Code → Lot, Roll Code → Roll. Mỗi UID vẫn in
một tem, không lấy Qty tồn kho làm số bản in. Thiếu tên/chưa có mã/lỗi mạng thì
chuyển về chờ gán thủ công; SKU, lot và roll đã tra được vẫn giữ khi bổ sung tên.

RPC được định nghĩa trong `supabase/group_uid_v2_lookup.sql`, chỉ trả thông tin
tem theo danh sách tối đa 100 mã chính xác, không trả người cập nhật hoặc vị trí kho.
Migration v2 đã triển khai sau khi chủ ứng dụng xác nhận quyền tra cứu thông tin
tem cho người không đăng nhập (`anon`). Bảng vẫn không mở quyền đọc/ghi trực tiếp.
Migration v3 xóa cột `product` và sửa RPC để chỉ dùng tên từ `SKU_Name`.
Các UID có SKU chưa có tên trong `SKU_Name` sẽ chờ gán tên thủ công.
Đã kiểm tra frontend với RPC thật: UID có dữ liệu tự chuyển sang Sẵn sàng in,
đủ SKU, tên sản phẩm, lot và roll. Frontend báo lỗi và cho gán tay nếu RPC không truy cập được.

### Nạp Excel Group UID trên Admin

Admin mở `#admin/group-uid-data`, chọn file `.xlsx` xuất từ WMS rồi xem trước số
dòng thêm mới, cập nhật, không thay đổi, dữ liệu cũ, SKU trống và SKU chưa có trong
`SKU_Name`. Khi bấm **Cập nhật database**, dữ liệu đã kiểm tra mới được upsert;
không xóa Group UID vắng mặt trong file.

Sau khi kiểm tra, ô **Cập nhật** có thể bấm để xem danh sách UID và từng trường
sẽ đổi theo dạng giá trị hiện tại → giá trị từ file. Danh sách có tìm kiếm theo
Group UID/SKU và phân trang 25 UID; backend chỉ trả dữ liệu thuộc lượt nạp của Admin.

Backend nằm trong `supabase/group_uid_v4_admin_import.sql`: bảng staging, lịch sử
và năm RPC `start/chunk/validate/commit/history`. RPC chỉ cấp cho `authenticated`
và tự kiểm tra `auth.uid()` có role `admin`; web không có quyền ghi trực tiếp vào
bảng chính hoặc bảng staging. File chia lô 500 dòng, tối đa 10 MB / 50.000 dòng.
Product Name trong Excel bị bỏ qua, ngày không có múi giờ được hiểu là UTC+07:00.

Triển khai hoặc cập nhật backend bằng migration:

```powershell
python scripts/apply_supabase_sql.py supabase/group_uid_v4_admin_import.sql
python scripts/apply_supabase_sql.py supabase/group_uid_v5_update_details.sql
```

Tài liệu kiến trúc và quy tắc phục hồi nằm tại
[`docs/GROUP_UID_ADMIN_IMPORT_DESIGN.md`](docs/GROUP_UID_ADMIN_IMPORT_DESIGN.md).

## Đồng bộ danh mục SKU lên Supabase

Đặt `SUPABASE_URL` và `SUPABASE_SECRET_KEY` trong biến môi trường của máy chạy đồng bộ. Không lưu secret key trong source code hoặc Git.

Kiểm tra dữ liệu local mà không gọi Supabase:

```powershell
python scripts/sync_sku_to_supabase.py --database data/sku.db --dry-run
```

Upsert các SKU Active lên bảng `SKU_Name`:

```powershell
python scripts/sync_sku_to_supabase.py --database data/sku.db
```

Đồng bộ chỉ thêm mới hoặc cập nhật theo khóa `sku`; script không tự xóa bản ghi trên Supabase.


## Fabric Relaxation — tem xả vải

Mở **TEM XẢ VẢI** (trước đây tên FABRIC RELAXATION) ở WH-MATERIAL hoặc `#fabric-relaxation`.
Chỉ nhập số tem (1–500), xem trước rồi bấm In. Mã hàng, Lot, Ngày và Giờ
đều để trống để ghi tay; Lot nằm dưới Mã hàng và cách khoảng hai dòng. Sử dụng agent SKU/UID,
giấy 40 × 60 mm, hai tem mỗi hàng; số lẻ để trắng tem bên phải hàng cuối.

Kích hoạt trên hệ thống đang chạy:

1. Áp dụng `supabase/print_queue_v4_fabric_relaxation_handwritten.sql` trong Supabase SQL Editor.
   Migration chạy trong transaction, chỉ mở rộng loại tem và cập nhật enqueue/claim;
   không xóa job. Nếu dùng `scripts/apply_supabase_sql.py`, cần `--allow-destructive`
   vì migration thay CHECK constraint (không xóa dữ liệu).
2. Cập nhật agent lên 0.7.0 tại máy in, giữ nguyên `config/.env`, token và cấu hình máy in.
   Khởi động lại agent sau khi hàng đợi hiện tại đã hoàn tất. Agent tự báo capability mới.
3. Cập nhật `index.html` trên nơi phục vụ ứng dụng. In thử 1, 2 và 3 tem để kiểm tra căn giấy.

Kiểm tra không in thật: `npm test` trong `workstation-agent`,
`node src/cli.mjs dry-run --type fabric_relaxation` tạo PNG và TSPL.
Browser test: `node tests/fabric_relaxation_browser.cjs` khi server local chạy cổng 8000;
đặt `PLAYWRIGHT_MODULE` nếu Playwright nằm ngoài repo. Test chặn mọi kết nối ngoài local.

## Mã vị trí — tem QR dán kệ

Mở **MÃ VỊ TRÍ** ở WH-MATERIAL (nhóm In tem) hoặc `#location`. Nhập **Mã vị trí** (chữ hoa không dấu,
số và `. _ / -`, tối đa 40 ký tự — gõ chữ thường tự đổi hoa), **Tên vị trí** (tối đa 60 ký tự, không bắt
buộc: trống thì tem chỉ in QR và mã) và **Số tem** (1–500), xem trước rồi bấm In. Enter ở ô mã (máy quét
cầm tay) chuyển sang ô tên, không in ngay. In xong nội dung vẫn giữ, ô mã được bôi đen để gõ/quét vị trí kế tiếp.

**Không lưu danh mục vị trí** (03/10/2026 — người dùng hiếm khi in lại một vị trí): không có danh sách,
không nhập Excel, không bảng riêng trên Supabase. Web gửi thẳng lệnh `location` (mã + tên + số tem) vào
hàng đợi in như các màn khác; `print_enqueue` kiểm tra định dạng, nội dung đã in vẫn nằm trong
`print_jobs.payload`. Gửi lại sau lỗi mạng với đúng nội dung dùng cùng nonce, không tạo lệnh trùng.

Tem 40 × 60 mm (giấy đang lắp, 2 tem/hàng): QR chứa đúng mã vị trí ở trên, mã Arial đậm, tên Arial
thường. Chữ được **đo thật** để không tràn tem và không mất ký tự: agent đo tên bằng GDI+ (cùng bộ đo
và cache với tên sản phẩm), mã đo theo bảng bề rộng Arial Bold; mã dài thì ép ngang, tên dài thì xuống
dòng/giảm cỡ, không bao giờ cắt bớt. Ô xem trước trên web dựng đúng bố cục đó (đo bằng canvas khi máy
có font Arial) và báo ngắn khi chữ bị ép hẹp. Chi tiết: `workstation-agent/README.md` mục 0.8.7–0.8.8.

Triển khai theo đúng thứ tự:

1. Áp dụng migration — `print_enqueue` nhận mã/tên trực tiếp (các loại tem khác giữ nguyên từng dòng),
   bỏ trigger đếm tem và 6 hàm của danh mục vị trí, xoá bảng `warehouse_locations` **chỉ khi** mọi mã
   trong bảng đã có trong một lệnh in (còn mã chưa từng in thì cả migration dừng, không đổi gì):

   ```powershell
   python scripts/apply_supabase_sql.py supabase/warehouse_location_v3_no_table.sql --allow-destructive
   ```

   Phải chạy **trước** khi cập nhật `index.html` (print_enqueue cũ chỉ in mã có trong bảng). Từ lúc chạy
   tới lúc cập nhật web, màn MÃ VỊ TRÍ bản cũ báo lỗi đọc danh sách; các màn khác không ảnh hưởng.
   Dự án mới chỉ cần file này — `warehouse_location_v1/v2` là lịch sử bản có danh mục.
2. Agent máy trạm **0.8.7** trở lên (capability `location:v1`); tem không tên cần **0.8.8**
   (`location:name-optional`). Web kiểm tra capability và **không gửi** lệnh khi chưa có agent phù hợp.
3. Cập nhật `index.html`. In thử 1–3 tem và quét QR bằng máy quét WMS.

Kiểm thử không cần mạng: `node --test` trong `workstation-agent` (tem, đo chữ, lệnh in) và
`node tests/location_browser.cjs` khi server local chạy cổng 8000 (mọi kết nối Supabase/in bị giả lập).

## Cắt Group UID

Mở **CẮT GROUP UID** ở WH-MATERIAL hoặc `#cut-group-uid`. Người dùng quét một
UID, hệ thống tra `group_uid_details` và `SKU_Name`, rồi lưu snapshot SKU, UID,
Lot, Roll và tên sản phẩm vào danh sách tem chờ in. Màn này dùng lại đúng lệnh
`group_uid:v1`, vì vậy agent 0.6.1 hiện tại không cần cập nhật.

Áp dụng backend một lần trước khi sử dụng:

```powershell
python scripts/apply_supabase_sql.py supabase/cut_group_uid_v1.sql
```

Danh sách chờ in nằm trên Supabase nên vẫn còn khi tải lại trang hoặc đổi thiết
bị. Phần tra cứu lọc theo SKU, Lot và **ngày cắt** (từ ngày → đến ngày, giờ Việt Nam; để
trống là không lọc) và xuất `.xlsx` có thiết lập giấy A4 ngang, gồm SKU, UID, Lot, Roll và
Tên SP. Bộ lọc ngày cần hàm tra cứu bản v4 (đã áp dụng 30/09/2026):

```powershell
python scripts/apply_supabase_sql.py supabase/cut_group_uid_v4_search_date_filter.sql --allow-destructive
```

`--allow-destructive` chỉ vì file `drop` chữ ký hàm v3 để tạo lại với 2 tham số ngày; hai
tham số có mặc định nên trang web cũ vẫn gọi được hàm mới.

**Đã xuất ADJ.** Bấm UID ở bảng Tra cứu để mở popup barcode, quét mã trên màn hình vào phiếu ADJ
trên WMS rồi tick **Đã xuất ADJ xong** — cột `cut_group_uids.adj_exported_at` ghi thời điểm tick
(bỏ tick phải xác nhận, trả về trống). Bảng có cột **ADJ** và bộ lọc *ADJ: Tất cả / Chưa xuất ADJ /
Đã xuất ADJ*. Cần migration v5 (thêm cột, RPC `cut_group_uid_mark_adj`, tham số `p_adj` cho hàm
tra cứu); chạy migration **trước** khi cập nhật `index.html`:

```powershell
python scripts/apply_supabase_sql.py supabase/cut_group_uid_v5_adj_export.sql --allow-destructive
```

`--allow-destructive` chỉ vì file `drop` chữ ký hàm tra cứu v4 để tạo lại với `p_adj` (có mặc định,
trang web cũ vẫn gọi được). Web chỉ gửi `p_adj` khi có chọn lọc ADJ.

## Quét mã ở PRINT SKU

Nút camera cạnh ô **Mã SKU** mở lớp quét toàn màn hình `window.PrintSkuScanUI` (script
`print-sku-scan-ui` trong `index.html`; component React cũ trong bundle chỉ còn là vỏ gọi nó):
khung 4 góc, đèn pin nếu máy hỗ trợ, 1×/2×/3×, "Gõ tay mã SKU"; nút Back của điện thoại đóng lớp
quét. Chỉ đọc mã nằm trong khung (tem có nhiều mã không bị đọc nhầm). Đọc được mã thì tra
`SKU_Name` trước: đúng SKU → khung xanh + bíp + rung rồi điền vào ô (hộp gợi ý Combo vẫn chạy như
cũ); không có trong danh mục → giữ camera, hỏi "Vẫn dùng mã này" / "Quét tiếp".

Bộ đọc dùng chung `window.PrintSkuScanner.Jp()` → `doc(video, vung?)` (cả PRINT SKU, Xả vải, TÌM SKU):
`vung` là `{x, y, w, h}` theo tỉ lệ khung hình, nhiều mã thì lấy mã gần tâm nhất. Máy không có
`BarcodeDetector` (iPhone/iPad, Chrome trên Windows) dùng ZXing — trước 01/10/2026 nhánh này gần như
không đọc được QR và mã vạch ngang do lỗi đảo màu của ZXing khi đọc thẳng từ `<video>`, và không đọc
được Code 128 toàn số (SKU, UID) mỗi khi bên trái mã vạch có điểm tối trên cùng hàng do lỗi
`Code128Reader.findStartPattern` của ZXing 0.21.3 (đã vá ngay trong bundle).

Ô Mã SKU có nút **"Hiện bàn phím" / "Ẩn bàn phím"** (icon Keyboard / KeyboardOff; như Cắt UID, Sample, Xả vải) để dùng máy
quét cầm tay không bị bàn phím che; mặc định ẩn, nhớ theo từng máy (`print-sku-ban-phim`). Bấm
"Gõ tay mã SKU" trong lớp quét thì bàn phím tự bật lại.

## Tìm SKU bằng camera

Mở **TÌM SKU** ở WH-MATERIAL hoặc `#find-sku`. Ba bước, bố cục như CẮT GROUP UID / XẢ VẢI:

1. **Quét nhận diện** — bật camera (toàn màn hình như ứng dụng quét: trên là Đóng · đèn pin nếu
   máy hỗ trợ, giữa là khung 4 góc + dòng trạng thái, dưới là 1×/2×/3× và nút chụp tròn giữa
   "Ảnh" (thư viện) · "Gõ mã"; nút Back của điện thoại đóng camera), đưa tem nhà cung cấp vào khung: máy **tự chụp** khi ảnh nét
   và đứng yên rồi gửi Edge Function `sku-vision` (Gemini) đọc chữ; khớp mã thì camera tự đóng và
   cuộn tới kết quả, chưa khớp thì hiện "Xem N gợi ý" và tự chụp lại,
   tối đa 3 lần/phiên camera (mỗi lần 1 lượt AI). QR/mã vạch được đọc trực tiếp không tốn lượt
   (bộ quét chung với XẢ VẢI). Có thể "Chụp ngay", "Chọn ảnh", hoặc gõ mã in trên tem (`N0144`,
   `C3966 Tex 27`) — không cần AI. Bộ đối chiếu `NDS_ENGINE` (chép nguyên từ tab "Nhận diện SKU"
   của AuditFactory) gợi ý 3 SKU từ `SKU_Name` ngay trong trình duyệt; danh mục tải một lần, lưu
   IndexedDB, 12 giờ tự tải lại. Mỗi thẻ gợi ý ghi mức khớp bằng chữ ("Khớp mã" / "Cần kiểm
   tra") và **đơn vị** của SKU — bản Normal và Combo cùng mã hàng thường ra cùng điểm, khác nhau
   ở đơn vị (vd `mm` và `cuộn`); % và từ khoá khớp nằm trong "Vì sao gợi ý".
   **Chọn SKU Combo** thì hiện hộp gợi ý SKU Normal — cùng hộp và cùng RPC `sku_combo_lookup`
   với PRINT SKU / PRINT UID (`window.SkuComboPicker.chooseNormal`): chọn Normal thì bước 2
   tính theo đơn vị của Normal và ghi "Đổi từ SKU Combo … · 1 Combo = …"; "Tiếp tục với SKU
   Combo" giữ Combo; "Hủy" ở lại bước 1.
2. **Tính toán số lượng** — SKU đơn vị `mm` (ô cuối tên) mở sẵn bảng **quy đổi cân → mm** theo
   đúng công thức tab "Chuyển đổi cân" của AuditFactory: quy cách cuộn nguyên (tự đọc `5000m` từ
   tên), tổng khối lượng (kg/gr), số cuộn thừa, khối lượng lõi, khối lượng cuộn nguyên (cân cả
   lõi / chỉ riêng chỉ) → mm, kèm phiếu tính và cờ đỏ khi số liệu vô lý. Lõi và cuộn nguyên
   được nhớ cho lô sau. Đơn vị khác (`pcs`, `cuộn`, `g`…) gõ số thẳng. Nhập số tem rồi
   "Thêm vào chờ in". Phần logic này nằm trong `FSK_CORE` (giữa hai dấu mốc trong `index.html`).
3. **Chờ in** — danh sách lưu trên máy đang dùng (localStorage), tick chọn rồi "In tem đã chọn":
   gửi lệnh `sku` vào hàng đợi Supabase như PRINT SKU (tối đa 100 SKU · 500 tem/lượt), theo dõi
   tới khi agent báo xong (tự rời danh sách) hoặc lỗi (tick lại để in lại). Gửi lại sau lỗi mạng
   dùng cùng nonce nên không tạo lệnh trùng.

Triển khai một lần:

```powershell
python scripts/apply_supabase_sql.py supabase/sku_vision_v1.sql   # bộ đếm lượt đọc tem
python scripts/apply_supabase_sql.py supabase/print_queue_v5_realtime_wake.sql --allow-destructive   # agent 0.8.4: Realtime đánh thức (DROP chỉ là drop trigger if exists)
python scripts/deploy_sku_vision.py                               # token cần quyền "Edge Functions: write"
```

Khoá Gemini tạo miễn phí ở Google AI Studio (nên tạo project riêng để có hạn mức riêng), người
quản trị tự nhập ở Supabase Dashboard → Edge Functions → Secrets với tên `GEMINI_API_KEY` (không
bao giờ nằm trong `index.html`). Tuỳ chọn: `GEMINI_MODELS` (thứ tự model thử, mặc định
`gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.5-flash-lite` — đo 30/09/2026: bản lite đọc đúng
2 tem thật trong ~3 giây và luôn trả được, còn 3.8-flash hay báo quá tải ở gói miễn phí; model
lỗi/quá tải thì tự chuyển model kế tiếp), `SKU_VISION_DEVICE_DAILY` (mặc định 60 lượt/máy/ngày),
`SKU_VISION_GLOBAL_DAILY` (mặc định 450 lượt/ngày cho cả kho — dưới hạn mức miễn phí của Gemini).
Ngày tính theo giờ Pacific vì Gemini reset hạn mức lúc nửa đêm Pacific. Hết lượt hoặc mất mạng
thì ô "Mã trên tem" vẫn tìm được. Lưu ý: ở gói miễn phí, Google được dùng ảnh gửi lên để cải
thiện sản phẩm.

Kiểm thử không cần mạng:

```powershell
node tests/find_sku_engine.cjs                    # bộ đối chiếu cắt ra từ index.html
node tests/find_sku_core.cjs                      # quy đổi cân → mm, đơn vị, tự chụp
node --test tests/sku_vision_function.mjs         # Edge Function, giả lập Deno/Supabase/Gemini
```
