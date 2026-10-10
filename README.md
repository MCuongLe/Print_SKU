# Print SKU

Ứng dụng in tem SKU chạy trực tiếp từ `index.html`.

## Kiểm tra đầu vào — lấy PO từ Inside

Màn `#inspection` có thể lấy PO/SKU trực tiếp từ một tab Inside đã đăng nhập qua Chrome extension chỉ đọc nằm tại [`extension/inside-po-connector`](extension/inside-po-connector/README.md).

Chrome không cho website tự cài extension. Với bản nội bộ, mỗi người dùng cài một lần bằng **Load unpacked**; khi triển khai rộng nên phát hành bản **Chrome Web Store Unlisted** hoặc để IT cài tập trung bằng **Chrome Enterprise Policy**. Import PO bằng `.xls/.xlsx` vẫn hoạt động khi chưa cài extension.

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

## Nút In tem (animation khi đang in)

Kiểu đơn giản: bấm in thì nút đổi icon máy in thành vòng quay và hiện một **đường load chạy ngay dưới nút**, chạy tới khi **lệnh in xong** (hàng đợi báo `completed`/`failed`/`cancelled`) thì dừng. Không còn dòng báo "mất N giây" / "(12s)" ở IN TEM SKU. Thiết kế: [`docs/THIET_KE_BUTTON_IN_TEM_CHUYEN_DONG.md`](docs/THIET_KE_BUTTON_IN_TEM_CHUYEN_DONG.md); prototype: `docs/button-design/print-button-prototype.html`.

Mọi nút gửi lệnh in là một `.act-icon--print` (IN TEM SKU và Xác nhận in của UID thêm `.pbtn`), điều khiển bằng `data-print-state` = `idle | working | failed | disabled`; `working` gồm cả lúc đang gửi và lúc máy in đang in. Các màn chỉ bọc lời gọi gửi sẵn có bằng `window.WmsPrint` (không đổi hàng đợi hay nonce): `begin()` khi bấm, `progress()` cập nhật nhãn (UID hiện `Đang gửi 100/125…`), `sent(btn, [jobId…])` khi hàng đợi nhận lệnh — từ đây nút theo dõi job bằng `PrintSkuQueue.jobStatus` (1 giây/lần, sau đó 2,5 giây/lần, tối đa 5 phút) rồi dừng animation; `fail()` khi gửi lỗi (nút đỏ "Thử lại", giữ tới khi bấm lại hoặc danh sách đổi); `render()` thay cho việc ghi nhãn; `settle()` ở `finally` để nút không kẹt. IN TEM SKU (React) tự theo dõi bằng vòng `X` có sẵn nên không gọi `WmsPrint`.

- Đang in mà vẫn còn tem để in thì nút giữ nhãn "In N tem" và bấm tiếp được; hết tem thì nút ghi "Đang in…" và khoá cho tới khi in xong.
- Giảm chuyển động (`prefers-reduced-motion`): icon ba chấm đứng yên và đường load đứng yên (vẫn thấy "đang in").
- Khi test tự động: IN TEM SKU (React) và Xác nhận in (UID) dùng `aria-disabled` thay cho `disabled`; các nút còn lại vẫn `disabled` thật khi không có gì để in. Nút giữ trạng thái `working` cho tới khi `PrintSkuQueue.jobStatus` báo xong — test cần mock `jobStatus` trả `completed` rồi đợi `data-print-state` về `idle`/`disabled` trước khi so nhãn.

## Header các màn hình

Mọi màn con dùng một kiểu header theo IN TEM SKU (`.uid-topbar`): nút Back dạng pill (nhãn "WH-MATERIAL"; riêng màn Nạp dữ liệu Group UID là "Tổng quan"),
icon module 32 px (đúng icon ô trang chủ), tiêu đề đậm 16 px, phụ đề 12 px và — nếu màn có máy in — pill trạng thái máy in (hiện có ở IN TEM SKU và
IN TEM GROUP UID). Cao 64 px + viền 1 px, dính đầu màn; từ 760 px trở xuống Back chỉ còn icon 44 px, ẩn icon module và phụ đề. Bề rộng header bám bề rộng nội dung
của từng màn. Màn mới chỉ cần dùng markup `.uid-topbar` (Back là phần tử đầu để thứ tự Tab khớp thứ tự nhìn). Trang chủ (nền xanh), Quản trị (React) và lớp
camera/scanner giữ kiểu riêng. Thiết kế: [`docs/THIET_KE_HEADER_UI.md`](docs/THIET_KE_HEADER_UI.md).

**Hộp xác nhận dùng chung** (08/10/2026): mọi bước hỏi lại trước khi làm dùng `await WhDialog.confirm({ title, facts, list, tone, confirmText })`
(module `wh-dialog-script` cuối `<head>`), không dùng `confirm()` của trình duyệt — hộp đó ghi "mcuongle.github.io cho biết", lệch màu chữ
của app và chỉ có OK/Huỷ. Hộp gồm icon, tiêu đề ngắn, nhãn số (`facts`), danh sách mã (tối đa 5, còn lại "+n") và nút ghi rõ việc + con
số ("In lại 6 tem", "Xoá 3 vị trí"). `tone`: `default` (Enter = đồng ý), `warning` (SKU Combo, Lot/Roll đè nhau — con trỏ đứng sẵn ở Huỷ),
`danger` (xoá, bỏ đánh dấu — nút đỏ, con trỏ ở Huỷ). Esc / bấm ra ngoài = Huỷ; gọi liên tiếp thì hộp sau đợi hộp trước; điện thoại hiện
dạng trượt từ đáy. Đang dùng ở 9 chỗ: IN TEM SKU (Combo, > 30 tem), PRINT UID (Combo, Lot/Roll, > 30 tem), Cắt UID (Lot/Roll, bỏ đánh
dấu ADJ), Đối chiếu ADJ (tick giúp), Mã vị trí (xoá khỏi hàng đợi), Lệnh in (in lại). Test: `tests/wh_dialog_browser.cjs`.

## Chuẩn chữ (font)

Chuẩn từ 10/10/2026, áp cho mọi màn ở cả điện thoại và máy tính, kể cả IN TEM SKU và Admin:

- **Font:** một font hệ thống `--wms-font` (`system-ui, "Segoe UI", Roboto, Arial…`): máy Windows ở kho hiện Segoe UI, Android hiện Roboto,
  iPhone hiện SF. Không tải font ngoài. Số dùng chữ số đều nhau (`tabular-nums`) để dễ so mã.
- **Cỡ:** chỉ 7 bậc `--fs-12 … --fs-28`: 12 (số đếm, badge, phụ đề) · 13 (nhãn ô, tab, đầu bảng) · 14 (bảng Admin, nút phụ, thông báo) ·
  16 (chữ trong ô nhập, nút chính) · 18 (tiêu đề khối, tên module) · 22 (tiêu đề trang Admin, KPI vừa) · 28 (số lớn). Ngoại lệ duy nhất:
  số bao ở Gom hàng mẫu (46–82 px, để đọc từ xa).
- **Đậm:** 400 chữ thường · 600 nhãn, tab, nút, tiêu đề khối · 700 tên module, thương hiệu, số lớn.
- **Chữ hoa:** chỉ tiêu đề nhóm trang chủ, đầu bảng Kiểm tra đầu vào và ô mã vị trí; còn lại viết thường, không giãn chữ.
- **Tem in giữ Arial:** tem là SVG tự ghi `font-family="Arial…"`, chỗ đo chữ cho tem (canvas) vẫn Arial, mẫu tem trong agent không đổi.

CSS cũ đã được quy đổi tại chỗ; khối `#type-standard` cuối trang phủ phần Tailwind sinh sẵn của IN TEM SKU/Admin (`text-[11px]`, `font-black`,
`uppercase`…). CSS mới chỉ dùng các token trên. Test: `tests/typography_browser.cjs`, đo mọi chữ đang hiện trên 12 màn × 2 khổ + 5 màn Admin.

## Quản trị (Admin)

Giao diện Admin (`#admin/lenh-in`, `#admin/cauhinh`, `#admin/sku-sync`, `#admin/group-uid-sync`, `#admin/kiem-ke`) vào từ ô **QUẢN TRỊ** (nhóm "Quản trị", cuối trang chủ) — không còn
nút bánh răng trong header IN TEM SKU. Chưa có phiên thì hiện hộp thoại đăng nhập Supabase (tài khoản có vai trò `admin`); **Hủy**, **Về trang chủ** và **Đăng xuất**
đều quay về `#home`. **Đăng xuất** nằm ở cuối thanh bên Admin (desktop) hoặc là icon ở hàng tiêu đề (điện thoại); không còn thanh nổi hiện tên Admin. Thương hiệu trong Admin và hộp thoại đăng nhập là "WH-MATERIAL" (trước đây là "In tem SKU"). Test: `tests/admin_entry_browser.cjs`.

**Khung chung của Admin (web).** Admin chỉ dùng trên máy tính (từ 768 px), không thiết kế cho điện thoại. Bốn màn dùng cùng một khung: thanh bên 276 px,
thanh trên 64 px **dính khi cuộn**, menu cùng thứ tự Lệnh in → Đồng bộ SKU → Đồng bộ Group UID → Cấu hình, tiêu đề thanh trên = tên mục. Cấu hình vẫn
nằm trong khung React cũ nhưng được ép cùng kiểu bằng CSS (khối `#admin-web-sync`, vì bundle React đã minify); các mục Đồng bộ chèn vào menu React đứng
trước Cấu hình và không còn lớp "đang chọn". Tiêu đề bảng của dashboard dính ngay dưới thanh trên. Chữ dùng màu `--wms-muted` (`#60736b`), cỡ ≥ 12 px.
Lỗi (máy chủ, chưa kết nối Extension) hiện thành **dải đỏ có icon** ở dòng trạng thái (`data-tone="error"`, `aria-live="assertive"`); Đồng bộ SKU và
Đồng bộ Group UID báo "Chưa kết nối Extension…" theo cùng một cách. Cấu hình chia hai nhóm **Thiết bị này** (Tên máy, Quyền in, Mẫu tem, Sổ tay SKU) và
**Hệ thống** (Danh mục SKU, Trần một lệnh in · chỉ đọc), không còn câu hướng dẫn.
**Thanh trên** của cả bốn màn có icon module (cùng icon với menu), tiêu đề đậm và dòng phụ ("Cả kho · cập nhật 17:19" ở Lệnh in, "Inside → Supabase" / "WMS → Supabase" ở hai màn Đồng bộ,
"Thiết bị và hệ thống" ở Cấu hình). Lệnh in và hai màn Đồng bộ có thêm **chip tóm tắt** ngay trên thanh (Lệnh in: số lệnh hôm nay / đang chờ / lỗi; Đồng bộ: số thay đổi / cảnh báo,
chỉ hiện sau khi đã kiểm tra hoặc mở một lượt) — thanh trên dính nên con số vẫn thấy khi cuộn; có nút làm mới (Lệnh in: tải lại danh sách; Đồng bộ: tải lại lịch sử). Dưới 1100 px chip và dòng phụ
tự ẩn. Test: `tests/admin_web_sync_browser.cjs`.

**Popup thay cho bảng nằm sẵn (08/10/2026).** Ở Đồng bộ SKU và Đồng bộ Group UID, bấm một ô số liệu (SKU mới, UID cập nhật, Combo thừa, Thiếu trên WMS…) mở **popup**
danh sách (`#ss-dialog`, `#gu-dialog`: tìm không phân biệt dấu, lọc theo nhóm trường, sắp xếp, phân trang 50 dòng, xuất CSV; Group UID có 4 tab chuyển nhóm ngay trong popup).
Xem trước xong thì **không** tự mở popup; ô có 0 dòng bị làm mờ và không mở. **Lịch sử** thu thành một ô trong dải thông tin (kết quả lượt gần nhất + số lượt): bấm mở popup lịch sử
(`#ss-hist-dialog`, `#gu-hist-dialog`; có nút tải lại và, ở Group UID, "Ẩn lượt lỗi"); bấm một dòng thì nạp lượt đó vào các ô và popup tự đóng. Nút **Cập nhật Supabase** (kèm số thay đổi)
và **Hủy xem trước** (Group UID, nút icon) nằm ở đầu trang và đều **hỏi xác nhận** bằng `WhDialog` trước khi ghi/hủy (Huỷ = không gọi Edge Function). Popup dùng chung
`AdminSyncUI.openDialog / bindDialogs / closeDialogs` (lớp `.as-dialog`; Esc hoặc bấm nền để đóng, rời màn thì tự đóng). Tab **4 · Đối chiếu** của Cắt UID làm tương tự: bấm ô trạng thái
(Tất cả, Sai số lượng, Quên tick…) mở popup `#cut-adj-dialog` chứa bảng, nút xuất Excel và **Tick giúp** (chỉ nhóm Quên tick và Tất cả); trên điện thoại popup là tờ trượt từ dưới lên.
Test: `tests/sku_sync_admin_browser.cjs`, `tests/group_uid_sync_admin_browser.cjs`, `tests/cut_adj_reconcile_browser.cjs`, `tests/admin_web_sync_browser.cjs`.
Danh sách Group UID luôn ghi **người cập nhật** (email trong WMS) dưới giờ ở cột "Cập nhật WMS" (cả UID mới, cập nhật, thiếu, WMS cũ hơn; không có thì "—"), có trong tìm kiếm và cột "Người cập nhật" của CSV;
dòng so sánh "Người cập nhật a → b" ở cột "Thay đổi" vẫn chỉ hiện khi người cập nhật đổi (WMS giữ nguyên người cập nhật khi chỉ đổi trạng thái/số lượng).

**Lệnh in** (`#admin/lenh-in`, mục đầu tiên, 08/10/2026) thay hai mục React cũ "Tổng quan" và "Đợt đã gửi" — hai mục đó chỉ đếm lệnh gửi
từ chính tab đang mở. `#admin/tongquan`, `#admin/hangdoi` và mọi hash Admin lạ tự chuyển về đây. Màn đọc `print_jobs` của cả kho:
dải trạng thái (máy in, đang chờ, số lệnh/tem trong ngày, lỗi), chọn ngày (giờ VN), lọc **Tất cả / SKU / UID**, tìm theo SKU, UID, tên
hoặc mã lệnh. Bấm một lệnh → popup từng dòng (SKU + tên; UID + SKU + tên + Lot + Roll). **In lại SKU = nguyên lệnh, giống hệt lệnh gốc**
(cùng dòng, số tem, ngày in); **in lại UID cho tick toàn bộ hoặc một phần dòng**, mỗi dòng giữ số tem. Lệnh mới do máy chủ dựng từ lệnh
gốc (trình duyệt chỉ gửi số thứ tự dòng), mang `reprint_of` và nhãn "In lại"; lệnh gốc còn chờ/đang in thì không cho in lại. Dữ liệu:
`supabase/print_jobs_admin_v1.sql` (đã áp dụng 08/10/2026; RPC `print_admin_jobs`, `print_admin_job`, `print_admin_reprint`, chỉ Admin).
Cùng migration: **pg_cron dọn `print_jobs` 3 ngày một lần lúc 03:00 VN, giữ lệnh của 3 ngày gần nhất** (chỉ xoá lệnh đã xong/lỗi/huỷ;
`print_maintenance` ghi lần chạy cuối) — màn Lệnh in vì thế chỉ tìm lại được vài ngày gần nhất. Test: `tests/print_jobs_admin_browser.cjs`.

Màn `#admin/group-uid-sync` giữ hai chế độ: lấy thay đổi theo watermark lùi 30 phút và đối chiếu toàn bộ. WMS được đọc theo trang 500 dòng; Admin xem preview trước khi cập nhật. Áp dụng `supabase/group_uid_sync_v1.sql` và deploy Edge Function `group-uid-sync` trước khi sử dụng.

Ô **LỊCH SỬ GROUP UID** (nhóm Vận hành kho trên trang chủ, `#group-uid-history`) tra cứu Group UID đã chuyển đến hoặc đi từ một vị trí và người cập nhật (email đầy đủ). **Xem thì ai cũng dùng được, không cần đăng nhập**: màn gọi hai hàm chỉ đọc `group_uid_moves_overview` / `group_uid_moves_lookup` (cấp cho anon như bảng Tra cứu UID). **Đọc dữ liệu mới từ WMS bắt buộc đăng nhập Admin**: bấm biểu tượng khiên ở thanh tiêu đề, đăng nhập bằng hộp Quản trị dùng chung, khi đó mới hiện nút **Đọc từ WMS** (nút đồng hồ bên cạnh đọc lại 365 ngày). Extension 0.7.1 đọc WMS `group-uid-info-histories?actions=4` (Transfer location) một luồng cho mọi kho tài khoản được xem — WMS không lọc endpoint này theo `company-ids` (đo 10/10/2026: ba công ty cùng trả 5.072 dòng); lần đầu lấy 365 ngày, các lần sau lùi 30 phút từ mốc đã đọc. Từng trang 500 dòng được ghi vào `group_uid_moves` bằng RPC chỉ Admin (`p_company_id = 0`, khóa là mã dòng lịch sử WMS nên nạp chồng không nhân đôi). Dòng chuyển vị trí của WMS không có SKU: SKU và tên sản phẩm được ghép từ `group_uid_details` / `group_uid_products` khi tìm. Giao diện (10/10/2026) cùng khung với Đồng bộ Group UID: dải thông tin (cập nhật gần nhất, số lượt đã lưu, kho), ô SKU và mã vị trí (có nút quét camera), chip bộ lọc đang dùng, rồi 4 thẻ số liệu **Lượt chuyển · Còn ở đây · Đã chuyển tiếp · Trả NCC**. Bấm thẻ hoặc **Xem kết quả** (Enter, quét xong cũng vậy) mở popup bảng dùng chung `AdminSyncUI`: tab theo 4 nhóm, tìm không dấu, lọc Kho / Người cập nhật, sắp xếp, 50 dòng/trang, xuất CSV, bấm mã UID để sao chép; điện thoại hiện dạng tấm trượt từ đáy, mỗi dòng thành một thẻ. Hướng (đến / từ / cả hai), kho và khoảng ngày nằm trong popup **Bộ lọc** (nút ghi số bộ lọc đã đổi). Mỗi lần tìm lấy tối đa 1.000 lượt mới nhất. `F0-VR-00-00-00-00` hiện nhãn **Trả NCC** (vị trí để hàng trả nhà cung cấp). Điện thoại và máy tính bảng chỉ xem; máy cập nhật cần Chrome, Extension 0.7.1 và một tab WMS đang đăng nhập. Áp dụng `supabase/group_uid_moves_v1.sql` và `supabase/group_uid_moves_v2_lookup.sql` (đã chạy ngày 10/10/2026). Test: `tests/group_uid_moves_core.cjs`, `tests/group_uid_moves_browser.cjs`.

Màn `#admin/kiem-ke` là dashboard chỉ đọc WMS qua Extension 0.6.1. Extension tự đổi `company-ids` theo từng nguồn: công ty Mastige cho `WH - MATERIAL - MTG`, công ty Garment cho `WH - MATERIAL - GARMENT`, rồi hợp nhất trên trình duyệt. Phạm vi tồn kho lấy từ báo cáo `Stock Location` đã gộp theo SKU/vị trí, chỉ giữ `count_inbin > 0`; lịch sử là kiểm kê loại SKU có trạng thái `APPROVED`. Mỗi SKU + kho được xếp đúng một nhóm: chưa có lần duyệt, lần gần nhất không quá 30 ngày, hoặc quá 30 ngày. Dashboard không lưu token hay bản sao dữ liệu WMS vào Supabase/browser storage. Giao diện dùng chung bộ công cụ với Đồng bộ SKU / Group UID: thẻ trạng thái bấm để lọc, tab theo tình trạng, tìm không dấu, lọc Kho, sắp xếp, phân trang, xuất CSV và hộp chi tiết theo vị trí.

Giao diện hai màn đồng bộ (`#admin/sku-sync`, `#admin/group-uid-sync`, 08/10/2026) dùng chung một bộ công cụ `AdminSyncUI` (khối `admin-sync-shared` trong `index.html`):
- Danh sách thay đổi có ô tìm (không phân biệt dấu), lọc theo nhóm trường, sắp xếp theo mã/ngày cập nhật WMS, phân trang 50 dòng và xuất CSV (UTF-8 có BOM, đúng các dòng đang lọc). Bấm vào mã để sao chép.
- Mỗi thay đổi hiện từng trường dạng `giá trị cũ → mới` (số lượng kèm chênh lệch), tên trường tiếng Việt, không in `updated_date` trong phần so sánh. UID mới hiện kho, vị trí, số lượng, trạng thái, Lot/Roll và SKU; SKU mới hiện tên sản phẩm (phần đầu in đậm) và nhóm hàng.
- Group UID có thanh cơ cấu kết quả (không đổi / cập nhật / mới / WMS cũ hơn), chênh lệch so với lần toàn bộ trước, tab theo nhóm, cảnh báo bấm được và dải thời gian lần đồng bộ gần nhất; SKU chia thẻ thành 3 cụm (SKU, Combo, Cảnh báo). Lịch sử có lý do lỗi, thời lượng và nút ẩn lượt lỗi.
- Edge Function chỉ trả tối đa 1.000 dòng mỗi nhóm, nên danh sách hiện `đã tải N / tổng` khi nhóm lớn hơn; tìm và CSV chỉ trên phần đã tải.
- Group UID có cột **Kho** (sắp xếp được) và bộ lọc **Kho** chọn nhiều có ô tìm và số đếm theo các bộ lọc đang bật; kết hợp với bộ lọc trường theo kiểu "và" (chip "Đổi kho" là UID bị chuyển kho). Ô tìm và CSV có cả kho; UID bị chuyển kho hiện kho mới kèm "từ kho cũ". Danh sách chọn dùng chung trong `AdminSyncUI.createList` (tùy chọn `facets`).
- Giao diện điện thoại của màn Admin không được thiết kế lại (chỉ đảm bảo không tràn ngang). Test: `tests/group_uid_sync_admin_browser.cjs`, `tests/sku_sync_admin_browser.cjs`.

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

Mở **MÃ VỊ TRÍ** ở WH-MATERIAL (nhóm In tem) hoặc `#location`. Hai mục:

1. **Thông tin tem** — nhập **Mã vị trí** (chữ hoa không dấu, số và `. _ / -`, tối đa 40 ký tự — gõ chữ
   thường tự đổi hoa), **Tên vị trí** (tối đa 60 ký tự, không bắt buộc: trống thì tem chỉ in QR và mã),
   **Số tem** (1–500) rồi **Thêm vào hàng đợi**. Enter ở ô mã (máy quét cầm tay) chỉ chuyển sang ô tên.
   **Nhập file Excel** (.xlsx, đọc sheet đầu tiên theo thứ tự trong workbook):
   - template import vị trí của WMS: mã lấy cột **Code** (công thức `Floor-Area-Aisle-Rack-Shelf-Bin`; ô
     chưa tính thì tự ghép từ 6 cột đó), tên lấy cột **Bin Location Description** — chữ mẫu "Mô tả mã vị
     trí" của template coi như không tên;
   - bảng **Location / Description** (hoặc Mã vị trí / Tên vị trí; không có cột mã thì ghép Lầu-Khu vực-
     Dãy-Kệ-Mâm-Ô).
   Mỗi vị trí nhận số tem đang đặt ở ô Số tem. Dòng trống bỏ qua; mã trùng và dòng sai mã/tên bị bỏ, báo
   số dòng.
2. **Hàng đợi in** — lưu trên máy đang dùng (localStorage, tối đa 500 vị trí), còn sau khi tải lại trang.
   Tick chọn, sửa số tem từng dòng, xoá dòng hoặc Xoá hết; **In N tem** gửi mọi dòng đã chọn. Quá 100 vị
   trí hoặc 500 tem thì tự chia nhiều lệnh. In xong vị trí tự rời hàng đợi; in lỗi thì giữ lại, ghi lỗi
   để in lại. Gửi lại sau lỗi mạng dùng đúng nonce cũ, không in trùng.

**Không lưu danh mục vị trí trên Supabase** (03/10/2026 — người dùng hiếm khi in lại một vị trí): web gửi
thẳng lệnh `location` (mã + tên + số tem) vào hàng đợi in như các màn khác; `print_enqueue` kiểm tra định
dạng. Không có lịch sử vị trí (bảng `print_jobs` cũng có lúc được dọn).

Tem 40 × 60 mm (giấy đang lắp, 2 tem/hàng): QR chứa đúng mã vị trí ở trên, mã Arial đậm, tên Arial
thường. Chữ được **đo thật** để không tràn tem và không mất ký tự: agent đo tên bằng GDI+ (cùng bộ đo
và cache với tên sản phẩm), mã đo theo bảng bề rộng Arial Bold; mã dài thì ép ngang, tên dài thì xuống
dòng/giảm cỡ, không bao giờ cắt bớt. Web không có ô xem trước (03/10/2026). Chi tiết:
`workstation-agent/README.md` mục 0.8.7–0.8.8.

Triển khai theo đúng thứ tự:

1. Áp dụng migration — `print_enqueue` nhận mã/tên trực tiếp (các loại tem khác giữ nguyên từng dòng),
   bỏ trigger đếm tem, 6 hàm và bảng `warehouse_locations` của danh mục vị trí. **Đã chạy trên Supabase
   03/10/2026** (bảng lúc đó còn 2 mã, người dùng đồng ý xoá); dự án mới thì chạy:

   ```powershell
   python scripts/apply_supabase_sql.py supabase/warehouse_location_v3_no_table.sql --allow-destructive
   ```

   Chạy **trước** khi đưa `index.html` lên (print_enqueue cũ chỉ in mã có trong bảng). Dự án mới chỉ cần
   file này — `warehouse_location_v1/v2` là lịch sử bản có danh mục.
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

Ô quét `#cut-code` mặc định ẩn bàn phím ảo (`inputmode="none"`); nút bàn phím **chỉ còn icon nhỏ** cùng hàng bên phải ô quét
(`#cut-keyboard`, `aria-label`/`title` "Hiện bàn phím" / "Ẩn bàn phím", nhớ theo từng máy ở khoá `cut-ban-phim`). Sau mỗi lần lưu tem, app chỉ
focus lại ô quét khi ô chưa giữ focus (Chrome Android coi mỗi lần `focus()` thành công là yêu cầu hiện bàn phím, kể cả với ô đang focus) và
khi đang ở chế độ ẩn thì gọi `navigator.virtualKeyboard.hide()` nếu trình duyệt có.

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

**Đối chiếu ADJ với lịch sử WMS.** Tab **4 · Đối chiếu** so UID đã cắt với lịch sử Group UID của WMS trong
phạm vi `warehouse_id=1177` (**WH - MATERIAL - MTG**). Extension 0.5.0 dùng phiên WMS Admin đang mở để đọc
trực tiếp API theo trang 500 dòng; lần sau đọc chồng lại 30 phút và nhận diện lệnh ADJ bằng Note
`Cut ... out of group ...` (WMS có thể hiển thị Action là `N/A`). Bấm **Đọc từ WMS** để nạp tự động. Nút
**Nạp ZIP/XLSX** giữ vai trò đối chiếu toàn bộ/dự phòng; cả hai cách đều cần phiên Supabase Admin. Dữ liệu nạp chồng
không nhân đôi. Dashboard chia UID thành: *Khớp*, *Quên tick* (đã ADJ nhưng chưa tick), *Sai số lượng*
(so với chuẩn 1 m như cột số lượng ở Tra cứu), *Tick, WMS không có*, *Cut nhiều lần*, *Chưa ADJ*, *Chờ dữ liệu WMS*
— bấm thẻ để lọc, lọc thêm theo SKU / Lot / ngày cắt, xuất Excel các dòng đang hiện. Nút **Tick giúp** tick hàng
loạt các dòng *Quên tick* theo giờ Cut trên WMS. Cần migration v6 (chỉ thêm bảng và hàm, không `drop`; chạy
**trước** khi cập nhật `index.html`):

```powershell
python scripts/apply_supabase_sql.py supabase/cut_group_uid_v6_wms_reconcile.sql
```

**Đã xử lý.** Kiểm tra xong một UID lệch thì tick nó trong popup nhóm lệch rồi bấm **Đã xử lý**: UID chuyển sang
thẻ *Đã xử lý* (lưu trên Supabase, không còn tính là lệch). Dấu này gắn với đúng kiểu lệch lúc tick — dữ liệu WMS
đổi làm UID lệch kiểu khác thì UID hiện lại ở nhóm lệch mới. **Bỏ xử lý** ở thẻ Đã xử lý để trả lại. Migration v8
(đã áp dụng 10/10/2026; chỉ thêm cột và hàm):

```powershell
python scripts/apply_supabase_sql.py supabase/cut_group_uid_v8_adj_resolved.sql
```

Kiểm thử không cần mạng (file zip/xlsx tự dựng trong test, mọi kết nối Supabase được giả lập): với server local cổng 8000,
`node tests/cut_adj_reconcile_browser.cjs` (đặt `PLAYWRIGHT_MODULE` nếu Playwright không nằm trong `node_modules`).

**Admin xóa UID đã cắt.** Icon khiên ở góc phải thanh tiêu đề mở hộp đăng nhập Quản trị dùng chung; là Admin thì
tab Tra cứu có nút **Xóa N UID** cho các dòng đang tick (không xóa dòng đang gửi máy in). Bấm lại icon để thoát Admin
mà vẫn ở màn Cắt UID. RPC `cut_group_uid_admin_delete` chỉ cấp cho tài khoản đã đăng nhập và tự kiểm vai trò admin;
mỗi dòng bị xóa được chép vào bảng `cut_group_uid_deletions` (ai xóa, lúc nào). Migration v7 đã áp dụng 08/10/2026:

```powershell
python scripts/apply_supabase_sql.py supabase/cut_group_uid_v7_admin_delete.sql
```

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

Ô Mã SKU có nút bàn phím **chỉ còn icon** (Keyboard / KeyboardOff; `aria-label` và `title` là "Hiện bàn phím" / "Ẩn bàn phím"), nằm cùng hàng bên phải ô Mã SKU (cùng cách ẩn bàn phím như Cắt UID, Sample, Xả vải) — để dùng máy
quét cầm tay không bị bàn phím che; mặc định ẩn, nhớ theo từng máy (`print-sku-ban-phim`). Công tắc áp dụng cho cả bốn ô của form
(Mã SKU, Tên hàng, Số lượng in lên tem, Số bản in): khi ẩn, sau lần quét focus nhảy sang ô kế tiếp cũng không bật bàn phím ảo; muốn gõ tay
thì bấm nút icon để hiện. Bấm "Gõ tay mã SKU" trong lớp quét thì bàn phím tự bật lại. Số lượng in lên tem và Số bản in luôn nằm một hàng (bộ tăng giảm
gọn, nút −/+ vẫn 44 px; kiểm ở 320–1280 px).

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
   IndexedDB, 12 giờ tự tải lại. Mỗi thẻ gợi ý có **% khớp** cỡ chữ lớn (xanh + dấu tích khi khớp mã,
   vàng + cảnh báo khi chỉ khớp chữ chung) và **đơn vị** của SKU — bản Normal và Combo cùng mã hàng
   thường ra cùng điểm, khác nhau ở đơn vị (vd `mm` và `cuộn`). Không còn mục "Vì sao gợi ý"; từ khoá
   đã nhận, chữ AI đọc được, "Đối chiếu lại" và "Tải lại danh mục" nằm trong **popup Chi tiết xử lý**
   (nút icon cạnh Chọn ảnh, số từ khoá ở góc).
   **Chọn SKU Combo** thì hiện hộp gợi ý SKU Normal — cùng hộp và cùng RPC `sku_combo_lookup`
   với PRINT SKU / PRINT UID (`window.SkuComboPicker.chooseNormal`): chọn Normal thì bước 2
   tính theo đơn vị của Normal và ghi "Đổi từ SKU Combo … · 1 Combo = …"; "Tiếp tục với SKU
   Combo" giữ Combo; "Hủy" ở lại bước 1.
   **Luôn gợi ý SKU Normal (10/10/2026):** dòng Combo trong kết quả được thay bằng SKU Normal theo quan hệ Combo → Normal
   (RPC `sku_combo_lookup`); % trên thẻ là điểm khớp tem của **chính tên Normal**, kèm dòng "Combo … · %" của tên Combo. Tên Combo
   khớp ≥ 70% mà tên Normal khớp < 70% thì **thẻ đỏ** để kiểm tra lại (gõ đúng số SKU Combo thì không cảnh báo). Chọn thẻ này thì
   bước 2 ghi "Đổi từ SKU Combo …" và mang tỷ lệ Combo sang Chuyển đổi đơn vị. Combo chưa có quan hệ (hoặc tra lỗi) vẫn hiện như cũ.
   Test: `tests/find_sku_combo_normal_browser.cjs`.
2. **Tính toán số lượng** — SKU chỉ có đơn vị chiều dài (`mm`/`m`) hiện nút mở **CHUYỂN ĐỔI
   ĐƠN VỊ**; kết quả mm có thể đưa ngược về form để in. Người dùng vẫn được gõ số lượng trực tiếp
   và in tem, không bị khóa vào bước quy đổi. Chỉ được tính theo Tex hoặc khối lượng cuộn nguyên;
   nếu có cả hai thì số cân thực tế được ưu tiên và Tex dùng để đối chiếu. Đơn vị khác (`pcs`,
   `cuộn`, `g`…) tiếp tục gõ số thẳng. Nhập số tem rồi "Thêm vào chờ in". Phần logic quy đổi nằm
   trong `FSK_CORE` (giữa hai dấu mốc trong `index.html`).
3. **Chờ in** — danh sách lưu trên máy đang dùng (localStorage), tick chọn rồi "In tem đã chọn":
   gửi lệnh `sku` vào hàng đợi Supabase như PRINT SKU (tối đa 100 SKU · 500 tem/lượt), theo dõi
   tới khi agent báo xong (tự rời danh sách) hoặc lỗi (tick lại để in lại). Gửi lại sau lỗi mạng
   dùng cùng nonce nên không tạo lệnh trùng.

**Giao diện điện thoại (10/10/2026, khối CSS `#mobile-pro-theme`, chỉ ≤ 800 px, áp cho TÌM SKU và CHUYỂN ĐỔI ĐƠN VỊ):** font hệ thống của máy
(Roboto/San Francisco/Segoe UI — không tải thêm gì), chữ đậm vừa (600); thanh trên có icon module; tab bước và Chỉ | Vải là nút chọn liền khối; thẻ phẳng một lớp
(bo 14 px, không bóng, không thẻ lồng thẻ); đơn vị (mm, cuộn, gr) và nút kg|gr nằm trong khung ô nhập; gợi ý SKU dạng danh sách — % bên trái, SKU + đơn vị,
tên 2 dòng, nút chọn tròn bên phải, chạm cả dòng là chọn; Chuyển đổi đơn vị: "Lô tiếp theo" là nút phụ, "Nhập lại" và "Copy" là nút icon. Bản máy tính không đổi.
Đợt 1 cho các module còn lại (khối CSS `#mobile-pro-modules`, ≤ 800 px): IN TEM GROUP UID, TEM XẢ VẢI, MÃ VỊ TRÍ, CẮT GROUP UID, THEO DÕI XẢ VẢI, KIỂM TRA ĐẦU VÀO,
GOM HÀNG MẪU, RỦI RO LƯU TRỮ dùng cùng font hệ thống, chữ đậm vừa, nhãn chữ thường, số thứ tự khối là chấm tròn 22 px, thẻ phẳng bo 14 px, ô nhập viền mảnh với
tiêu điểm nhẹ, nút 46 px. Tab Cắt UID / Xả vải là nút chọn liền khối với nhãn ngắn (Quét · Tra cứu · Chờ in · Đối chiếu; Quét · Đang xả · Đã xả) — máy tính vẫn nhãn
đầy đủ, có số tròn. Nút bàn phím của Xả vải và Gom hàng mẫu là icon cạnh ô quét. IN TEM GROUP UID đánh số lại theo thứ tự trên màn: 1 Thêm · 2 Chưa gán SKU · 3 Gán SKU ·
4 Sẵn sàng in. Dòng "Tìm thấy N …" của Tra cứu không hiện khi đang ở tab Quét. Gom hàng mẫu bỏ câu hướng dẫn mở bao. Test: `tests/mobile_modules_browser.cjs`.

**Bố cục điện thoại (10/10/2026).** Toàn màn hình bỏ các câu hướng dẫn (thông báo sau khi đọc tem/chọn SKU, mẹo gõ mã, "Lưu trên máy này…", đuôi "kiểm tra mạng rồi bấm…"
của các thông báo lỗi); chỉ giữ trạng thái và lỗi ngắn. Bước 1: nút Bật camera và nút Chọn ảnh (chỉ icon, vẫn có tên cho trình đọc màn hình) cùng một hàng. Bước 2: thẻ SKU gọn
(SKU · chip đơn vị · nút Đổi), bỏ các câu giải thích đơn vị/cách nhập và thông báo "nhập số lượng và số tem"; nút **Tính mm từ cân** thay khối giải thích; **Số tem**
cùng hàng với bộ − / +. Thanh **Thêm vào chờ in** dính đáy màn hình (điện thoại ẩn dòng tóm tắt lặp lại). Gốc lỗi cũ trên Chrome Android: khung toàn màn hình `.cut-screen`
có `min-height:100vh`, mà 100vh của Android tính cả lúc ẩn thanh địa chỉ nên khung cao hơn vùng nhìn thấy và thanh dính đáy bị cắt — đã bỏ `min-height` đó (áp cho mọi màn
dùng `.cut-screen`: CẮT GROUP UID, XẢ VẢI, MÃ VỊ TRÍ, TÌM SKU, CHUYỂN ĐỔI ĐƠN VỊ). Bước 3: dòng chờ in ghi "29.750.000 mm · 2 tem" (chỉ thêm trạng thái khi không phải "chờ in"),
nút **Quét thêm tem** thay dòng "Lưu trên máy này…". Test: `tests/find_sku_mobile_browser.cjs`.

## Chuyển đổi đơn vị

Mở **CHUYỂN ĐỔI ĐƠN VỊ** ở WH-MATERIAL hoặc `#unit-converter`:

- **Chỉ:** trừ tổng khối lượng lõi khỏi khối lượng lô; quy đổi theo `Tex / 1.000` g/m hoặc theo
  khối lượng chỉ thật của một cuộn nguyên. Khi có số cân cuộn nguyên, kết quả cân được ưu tiên và
  chênh lệch trên 5% so với Tex được cảnh báo. Ví dụ 10.000 g, 10 lõi × 14 g, Tex 27 cho
  `365.185.185 mm`.
- **Vải:** quy đổi danh nghĩa theo `GSM × khổ(cm) / 100` g/m; nếu nhập thêm mét và khối lượng một
  cuộn nguyên thì ưu tiên định mức cân thực tế. Kết quả chỉ theo GSM có cảnh báo sai số ±5–8%.
- Có thể nhập tay, quét/nhập SKU hoặc Group UID. Tên hàng được đọc để tự điền Tex, quy cách cuộn,
  khổ vải và GSM. Chỉ SKU có đơn vị chiều dài mới được đưa kết quả mm sang TÌM SKU để in, tránh
  gắn nhầm số mm vào SKU đơn vị gram/cuộn.
- **Quy cách cuộn nguyên suy ra từ Combo (10/10/2026).** Tên SKU Normal chỉ (`…/Tex 27- 60-3/mm`) không ghi quy cách, nhưng Combo của nó
  (`…/cuộn 5000m`) có quan hệ `1 Combo = 5.000.000 mm`. Chọn SKU Normal chỉ thì màn hình gọi RPC `sku_combo_by_normal`
  (`supabase/sku_combo_links_v3_by_normal.sql`; tra ngược Normal → Combo, bảng quan hệ vẫn private) và lấy `quantity` làm quy cách:
  chỉ nhận Combo **một thành phần** (`component_count = 1`) và 500–100.000 m, gộp theo quy cách. Một quy cách thì tự điền; nhiều quy cách khác nhau thì
  hiện chip (icon móc xích, mở tooltip "Theo Combo …") để chọn, không tự chọn hộ. Quy cách trong tên SKU (nếu có) và số người dùng gõ luôn thắng.
  Từ TÌM SKU, chọn Combo → Normal cũng mang theo `combo.ratio` làm quy cách.
- **Điện thoại (10/10/2026).** Kết quả mm (kèm "mét · thước đang dùng") nằm trên cùng, thanh dưới dính đáy có **Copy** và **In ở TÌM SKU**.
  Mỗi lô chỉ nhập **tổng khối lượng**, **số cuộn thừa** và **khối lượng 1 lõi** (hai ô sau cùng một hàng, kể cả điện thoại); các thông số ít đổi (quy cách, Tex, khối lượng 1 cuộn nguyên; vải: khổ, GSM, cuộn nguyên)
  gom thành một dòng tóm tắt ("5.000 m · Tex 27") — chạm mở popup **Thông số hàng**; "Cách tính" (mét, mm/gram, các bước) là popup mở bằng icon ⓘ.
  Popup là `dialog.uc-sheet`: ≤ 800 px là tờ trượt dưới (modal), từ 801 px mở không-modal ngay trong trang như bố cục cũ (JS `matchMedia`). Đã bỏ các câu hướng dẫn và
  dòng "Còn thiếu: …". Test: `tests/unit_converter_browser.cjs`.
- Mục nhận diện có thể thu gọn và tự thu sau khi tra thành công. **Lô tiếp theo** giữ SKU/thông số
  hàng nhưng xóa số cân của lô; **Nhập lại** xóa SKU cùng toàn bộ số liệu và mở lại mục nhận diện.

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
`SKU_VISION_GLOBAL_DAILY` (mặc định 450 lượt/ngày cho cả kho — dưới hạn mức miễn phí của Gemini),
`SKU_VISION_HEDGE_MS` (mặc định 6000: model đang chạy quá 6 giây chưa trả thì gọi thêm model kế tiếp
song song, model nào trả trước thì dùng; lỗi tạm thời 429/404/5xx thì gọi ngay; mỗi model chờ tối đa 40 giây).
Hết mọi model mà vẫn lỗi/treo thì trang báo "AI đang quá tải, chưa đọc được tem." — bấm 🔄 Đọc lại tem hoặc gõ mã.
Ngày tính theo giờ Pacific vì Gemini reset hạn mức lúc nửa đêm Pacific. Hết lượt hoặc mất mạng
thì ô "Mã trên tem" vẫn tìm được. Lưu ý: ở gói miễn phí, Google được dùng ảnh gửi lên để cải
thiện sản phẩm.

Kiểm thử không cần mạng:

```powershell
node tests/find_sku_engine.cjs                    # bộ đối chiếu cắt ra từ index.html
node tests/find_sku_core.cjs                      # quy đổi cân → mm, đơn vị, tự chụp
node tests/unit_converter_browser.cjs             # giao diện quy đổi chỉ/vải, SKU/UID, desktop/mobile
node --test tests/sku_vision_function.mjs         # Edge Function, giả lập Deno/Supabase/Gemini
```
