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
icon module 32 px (đúng icon ô trang chủ), tiêu đề đậm 16 px (không phụ đề mô tả — icon module đã cho biết màn) và — nếu màn có máy in — pill trạng thái máy in (hiện có ở IN TEM SKU và
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

## Chuẩn giao diện chung

Từ 11/10/2026 (khối `#ui-standard`, biến `--ui-*`, test `tests/ui_standard_browser.cjs`) mọi ô trang chủ và Admin (Admin chỉ máy tính)
theo một chuẩn; màu thương hiệu duy nhất `--wms-brand` (#005F41):

| Thành phần | Máy tính ≥ 801 px | Điện thoại ≤ 800 px |
|---|---|---|
| Thẻ khối, thẻ số liệu, dải thông tin, popup | bo 22 px, viền 1 px | bo 14 px, viền 1 px, không bóng |
| Tiêu đề khối | chấm tròn số 30 px nền xanh + chữ 18 px/600 | chấm tròn 22 px + chữ 18 px/600 |
| Ô nhập | cao 52 px, bo 13 px, chữ 16 px | cao 48 px, bo 10 px, chữ 16 px |
| Nút hành động (chính / phụ) | cao 52 px, viên thuốc, chữ 16 px/600 | cao 48 px, bo 12 px, chữ 16 px/600 |
| Nút chỉ có icon cạnh ô nhập | vuông 52 px | vuông 48 px |
| Nút icon nằm trong ô | 44 px | 40 px |
| Điều khiển gọn: tab, ô tìm/lọc trên thanh công cụ, chip lọc, nút trong dòng, nút icon thanh công cụ Admin | cao 44 px, chữ 14 px/600 | cao 44 px |

Tiêu đề khối không bị ẩn ở khổ nào (TÌM SKU, CHUYỂN ĐỔI ĐƠN VỊ trên điện thoại nay cũng hiện "1 Quét nhận diện", "2 Số liệu cân"…).
Tiêu đề trang Admin 22 px/600, tiêu đề nhóm Cấu hình 18 px/600. Lịch sử Group UID (khung kiểu Admin) và Rủi ro lưu trữ dùng cùng chuẩn
thẻ/nút/ô nhập. CSS mới chỉ dùng các biến `--ui-*`. Mốc hiệu năng 11/10/2026 (localhost, trang chủ, trung vị 3 lần): máy tính FCP 100 ms,
load 152 ms; điện thoại giả lập CPU ×4 FCP 372 ms, load 891 ms; tải 1.619 KB, heap 4,8 MB.

## Khả năng tiếp cận (axe)

`tests/a11y_axe_browser.cjs` quét bằng [axe-core](https://github.com/dequelabs/axe-core) (WCAG 2.0/2.1/2.2 mức A + AA và best-practice) 11 màn
trang chủ ở 390 + 1280 px và 5 màn Admin ở 1280 px — yêu cầu 0 lỗi. axe-core chỉ dùng khi chạy test (khai báo trong `package.json` ở gốc repo,
cài một lần bằng `npm install`, thư mục `node_modules/` không commit); app vẫn là một trang tĩnh, không tải thêm gì. Lần quét đầu 11/10/2026
tìm và đã sửa: chữ xám `text-slate-400` của IN TEM SKU/Cấu hình chỉ đạt 3,4:1 (nay #5C6F68 ≥ 4,5:1), thẻ số liệu bằng 0 bị làm mờ bằng
opacity (nay chữ xám đủ tương phản), hộp chọn "Mẫu tem" thiếu nhãn, nút "WH-MATERIAL" của Chuyển đổi đơn vị có tên đọc không chứa chữ
đang hiện, và 14 thẻ `<main>` lồng trong vùng màn hình (đổi thành `<div>`, mỗi màn vẫn là một vùng có tên).

## Source và tự động hóa (Đợt 6)

Kết luận 11/10/2026: **giữ `index.html` một file, sửa trực tiếp** (người dùng chọn). Source gốc React/Vite của IN TEM SKU và Admin
Cấu hình không còn — không có trong repo (từ commit đầu 31/08/2026 đã là bundle), không có source map, không có bản nào khác trên máy —
nên không khôi phục source, không tách component, không thêm bước build. Phần tự động hóa đã có: bộ test Playwright trong `tests/`,
quét axe (`tests/a11y_axe_browser.cjs`), mốc hiệu năng ở mục Chuẩn giao diện chung. Nếu sau này tìm lại được source gốc thì mới làm
tiếp phần build/component theo `docs/DOI_CHIEU_HIEN_TRANG_VA_HUONG_CAI_THIEN_UI_UX.md` mục 7.

## Chuẩn icon

Từ 11/10/2026 (khối `#icon-standard`, test `tests/icon_standard_browser.cjs`): icon Lucide nét 2 px, tô `currentColor`, chỉ 4 cỡ —
**16** (trong chữ, nhãn, chip) · **20** (nút, ô nhập, menu, thanh trên) · **24** (ô trang chủ điện thoại) · **32** (ô trang chủ máy tính). CSS cũ
được quy đổi tại chỗ; SVG chỉ có thuộc tính `width/height` (markup, chuỗi JS, lucide-react của IN TEM SKU) đưa về thang bằng `:where()` nên CSS riêng
vẫn thắng. Không dùng ký tự làm icon (→ ← ×); nút chỉ có icon luôn có `aria-label`/`title`. Chỗ icon nói được thì không thêm chữ hướng dẫn: không phụ đề
mô tả ở thanh trên, placeholder chỉ là danh từ ("Group UID", "SKU", "Mã PO" — ô đã có icon quét/bàn phím), nút nhập file cùng nhãn "Nhập Excel",
liên kết chuyển tab là nhãn ngắn + icon mũi tên ("Tra cứu", "Đang xả", "Chi tiết"), nút bàn phím Xả vải chỉ còn icon. Tem in không dùng khối này.

## Chuẩn chữ (font)

Chuẩn từ 10/10/2026, áp cho mọi màn ở cả điện thoại và máy tính, kể cả IN TEM SKU và Admin:

- **Font:** một font hệ thống `--wms-font` (`system-ui, "Segoe UI", Roboto, Arial…`): máy Windows ở kho hiện Segoe UI, Android hiện Roboto,
  iPhone hiện SF. Không tải font ngoài. Số dùng chữ số đều nhau (`tabular-nums`) để dễ so mã.
- **Cỡ:** chỉ 7 bậc `--fs-12 … --fs-28`: 12 (số đếm, badge, phụ đề) · 13 (nhãn ô, tab, đầu bảng) · 14 (bảng Admin, nút phụ, thông báo) ·
  16 (chữ trong ô nhập, nút chính) · 18 (tiêu đề khối, tên module) · 22 (tiêu đề trang Admin, KPI vừa) · 28 (số lớn).
- **Đậm:** 400 chữ thường · 600 nhãn, tab, nút, tiêu đề khối · 700 tên module, thương hiệu, số lớn.
- **Chữ hoa:** chỉ tiêu đề nhóm trang chủ, đầu bảng Kiểm tra đầu vào và ô mã vị trí; còn lại viết thường, không giãn chữ.
- **Tem in giữ Arial:** tem là SVG tự ghi `font-family="Arial…"`, chỗ đo chữ cho tem (canvas) vẫn Arial, mẫu tem trong agent không đổi.

CSS cũ đã được quy đổi tại chỗ; khối `#type-standard` cuối trang phủ phần Tailwind sinh sẵn của IN TEM SKU/Admin (`text-[11px]`, `font-black`,
`uppercase`…). CSS mới chỉ dùng các token trên. Test: `tests/typography_browser.cjs`, đo mọi chữ đang hiện trên 12 màn × 2 khổ + 5 màn Admin.

## Quản trị (Admin)

**Chuyển mục mượt (11/10/2026):** `PrintSkuAdminAccess.getToken()` trả token ngay khi trong phiên trang đã xác nhận Admin và token JWT còn hạn ≥ 1 phút
(trước đây mỗi lần bấm menu đều chờ 2 lượt gọi `/auth/v1/user` + `user_roles`, màn cũ ẩn trước nên lộ nền đen 0,2–0,6 giây). Token hết hạn thì vẫn
kiểm lại/refresh như cũ; mọi lời gọi dữ liệu vẫn qua `PrintSkuAdminAuth.accessToken()`. Quay lại Đồng bộ SKU / Group UID giữ nội dung cũ và tải
lại ngầm (không khoá nút, không chạy thanh tải). Test: `tests/admin_switch_browser.cjs`.

Giao diện Admin (`#admin/lenh-in`, `#admin/cauhinh`, `#admin/sku-sync`, `#admin/group-uid-sync`) vào từ ô **QUẢN TRỊ** (nhóm "Quản trị", cuối trang chủ) — không còn
nút bánh răng trong header IN TEM SKU. Chưa có phiên thì hiện hộp thoại đăng nhập Supabase (tài khoản có vai trò `admin`); **Hủy**, **Về trang chủ** và **Đăng xuất**
đều quay về `#home`. **Đăng xuất** nằm ở chân thanh trái chung (máy tính ≥ 1024 px), cuối thanh bên Admin (768–1023 px) hoặc là icon ở hàng tiêu đề (điện thoại); không còn thanh nổi hiện tên Admin. Thương hiệu trong Admin và hộp thoại đăng nhập là "WH-MATERIAL" (trước đây là "In tem SKU"). Test: `tests/admin_entry_browser.cjs`.

**Khung chung của Admin (web).** Admin chỉ dùng trên máy tính (từ 768 px), không thiết kế cho điện thoại. Bốn màn dùng cùng một khung: thanh bên 276 px
(từ 1024 px là thanh trái chung của cả app — xem "Thanh điều hướng trái"),
thanh trên 80 px (từ 11/10/2026 theo chuẩn thanh trên chung, nền ảnh tím của nhóm Quản trị) **dính khi cuộn**, menu cùng thứ tự Lệnh in → Đồng bộ SKU → Đồng bộ Group UID → Cấu hình, tiêu đề thanh trên = tên mục. Cấu hình vẫn
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

Màn `#admin/sku-sync` có hai chế độ (14/10/2026, `supabase/sku_sync_full_v1.sql`, Extension 0.8.2): **Kiểm tra dữ liệu Inside** chỉ đọc SKU có Modified mới hơn mốc lùi 24 giờ (cộng toàn bộ Combo) và **Đối chiếu toàn bộ** đọc hết Inside (từng nhóm hàng, 6 trang song song, vài phút) rồi so với cả bảng `SKU_Name`. Lượt toàn bộ bắt được SKU đổi mà Modified không đổi, lệch do nguồn ghi khác và liệt kê **Thiếu trên Inside** (SKU có trong Supabase nhưng Inside không còn trả về; chỉ báo, không xoá/ngừng). Lần đầu còn nạp bù SKU ngừng hoạt động và các quan hệ Combo trước đây bị loại vì thiếu SKU, nên trần dòng chờ ghi của lượt toàn bộ là 30.000 (gia tăng vẫn 2.000); Edge Function từ chối khi số SKU nguồn ít hơn 20% so với lần toàn bộ trước (lần đầu: so với bảng hiện có) vì đó là dấu hiệu đọc thiếu trang, và ghi `fullDropPercent` vào lượt để màn cảnh báo từ 2%. Thẻ **Đối chiếu toàn bộ** trong dải thông tin đổi màu khi chưa chạy hoặc quá 36 giờ; lịch sử ghi nhãn "Toàn bộ". **SKU ngừng hoạt động mà database chưa có thì không nạp** (quyết định 14/10/2026, áp cho cả hai chế độ): chỉ đếm ở ô "Ngừng, bỏ qua"; SKU đã có mà Inside chuyển sang ngừng vẫn cập nhật trạng thái; quan hệ Combo tham chiếu SKU bị bỏ qua vẫn bị loại như SKU chưa có. Nhịp đã chọn (14/10/2026): **toàn bộ mỗi sáng một lần**, gia tăng chỉ dùng khi cần xem nhanh giữa ngày; không lọc Active ở nguồn vì SKU vừa ngừng sẽ biến mất khỏi nguồn và trạng thái trong Supabase không được cập nhật. Test: `tests/sku_sync_function.mjs`, `tests/sku_sync_admin_browser.cjs`.

Màn `#admin/group-uid-sync` giữ hai chế độ: lấy thay đổi theo watermark lùi 30 phút và đối chiếu toàn bộ. **Dọn Group UID Canceled quá 180 ngày** (16/10/2026, `supabase/group_uid_canceled_purge_v1.sql`): pg_cron thứ Hai 03:15 giờ VN xoá UID trạng thái Canceled có `updated_date` quá 180 ngày khỏi `group_uid_details` (thành phần `group_uid_products` xoá theo; lịch sử Cắt UID, Cấp vải, chuyển vị trí chỉ lưu mã nên không mất), kết quả ghi `print_maintenance` (task `group_uid_canceled_purge`). Để chúng không quay lại từ WMS, xem trước và cập nhật (v5) **bỏ qua UID Canceled quá hạn chưa có trong database** (đếm ở `change_counts.skippedCanceled`, câu trạng thái ghi "bỏ qua N UID Canceled quá 180 ngày"), không báo "thiếu trên WMS" cho UID Canceled quá hạn trong database; UID đang Available/Closed mà WMS chuyển sang Canceled vẫn cập nhật như trước. Nạp Excel qua script CLI không có bộ lọc này. WMS được đọc theo trang 500 dòng; Admin xem preview trước khi cập nhật. Áp dụng `supabase/group_uid_sync_v1.sql` và deploy Edge Function `group-uid-sync` trước khi sử dụng. Từ 16/10/2026 Admin đọc hết các trang vào bộ nhớ và chỉ đưa lên Supabase khi nhất quán (hàm `readWmsSnapshot`): đối chiếu toàn bộ gộp UID lặp do UID mới chen lên đầu danh sách giữa lúc đọc (WMS xếp theo id giảm dần; `api-clinic` tạo 1 UID/phút) rồi đọc lại đầu danh sách tới khi tổng WMS khớp số UID duy nhất; lấy thay đổi giữ khung `from`–`to` (WMS chỉ áp `to_updated_at` khi có cả `from_updated_at`) và đọc lại nếu tổng đổi giữa các trang. Không khớp sau 3 lượt thì phiên dừng, kiểm tra "Số UID duy nhất không khớp tổng WMS" của Edge Function giữ nguyên.

Ô **LỊCH SỬ GROUP UID** (nhóm Vận hành kho trên trang chủ, `#group-uid-history`) tra cứu Group UID đã chuyển đến hoặc đi từ một vị trí và người cập nhật (email đầy đủ). **Xem thì ai cũng dùng được, không cần đăng nhập**: màn gọi hai hàm chỉ đọc `group_uid_moves_overview` / `group_uid_moves_lookup` (cấp cho anon như bảng Tra cứu UID). **Đọc dữ liệu mới từ WMS bắt buộc đăng nhập Admin**: bấm biểu tượng khiên ở thanh tiêu đề, đăng nhập bằng hộp Quản trị dùng chung, khi đó mới hiện nút **Đọc từ WMS** (nút đồng hồ bên cạnh đọc lại 365 ngày). Extension 0.7.1 đọc WMS `group-uid-info-histories?actions=4` (Transfer location) một luồng cho mọi kho tài khoản được xem — WMS không lọc endpoint này theo `company-ids` (đo 10/10/2026: ba công ty cùng trả 5.072 dòng); lần đầu lấy 365 ngày, các lần sau lùi 30 phút từ mốc đã đọc. Từng trang 500 dòng được ghi vào `group_uid_moves` bằng RPC chỉ Admin (`p_company_id = 0`, khóa là mã dòng lịch sử WMS nên nạp chồng không nhân đôi). Dòng chuyển vị trí của WMS không có SKU: SKU và tên sản phẩm được ghép từ `group_uid_details` / `group_uid_products` khi tìm. Giao diện (10/10/2026) cùng khung với Đồng bộ Group UID: dải thông tin (cập nhật gần nhất, số lượt đã lưu, kho), ô SKU và mã vị trí (có nút quét camera; dán SKU Combo đúng 9 số thì hỏi SKU Normal bằng hộp chọn dùng chung với TÌM SKU/CẮT UID vì Group UID lưu theo SKU Normal), chip bộ lọc đang dùng, rồi 4 thẻ số liệu **Lượt chuyển · Còn ở đây · Đã chuyển tiếp · Trả NCC**. Bấm thẻ hoặc **Xem kết quả** (Enter, quét xong cũng vậy) mở popup bảng dùng chung `AdminSyncUI`: tab theo 4 nhóm, tìm không dấu, lọc Kho / Người cập nhật, sắp xếp, 50 dòng/trang, xuất Excel, bấm mã UID để sao chép; điện thoại hiện dạng tấm trượt từ đáy, mỗi dòng thành một thẻ. Hướng (đến / từ / cả hai), kho và khoảng ngày nằm trong popup **Bộ lọc** (nút ghi số bộ lọc đã đổi). Mỗi lần tìm lấy tối đa 1.000 lượt mới nhất. `F0-VR-00-00-00-00` hiện nhãn **Trả NCC** (vị trí để hàng trả nhà cung cấp). Điện thoại và máy tính bảng chỉ xem; máy cập nhật cần Chrome, Extension 0.7.1 và một tab WMS đang đăng nhập. Áp dụng `supabase/group_uid_moves_v1.sql` và `supabase/group_uid_moves_v2_lookup.sql` (đã chạy ngày 10/10/2026). Test: `tests/group_uid_moves_core.cjs`, `tests/group_uid_moves_browser.cjs`.

Ô **KIỂM KÊ SKU** (nhóm Kiểm tra trên trang chủ, `#inventory-audit`; 12/10/2026 chuyển từ `#admin/kiem-ke` ra trang chủ, đường dẫn cũ tự chuyển hướng) là dashboard đối chiếu kiểm kê theo kho. **Xem thì ai cũng dùng được, không cần đăng nhập**: màn gọi hàm chỉ đọc `sku_count_overview` (cấp cho anon) và hiện bản chụp đã lưu gần nhất. **Đồng bộ từ WMS bắt buộc đăng nhập Admin**: bấm biểu tượng khiên ở thanh tiêu đề, đăng nhập bằng hộp Quản trị dùng chung, khi đó mới hiện nút **Đọc và đồng bộ WMS**. Admin bấm thì Extension 0.6.1 đọc WMS (tự đổi `company-ids` theo từng nguồn: công ty Mastige cho `WH - MATERIAL - MTG`, công ty Garment cho `WH - MATERIAL - GARMENT`; tồn kho lấy từ báo cáo `Stock Location` đã gộp theo SKU/vị trí, chỉ giữ `count_inbin > 0`; lịch sử là kiểm kê loại SKU có trạng thái `APPROVED`), trình duyệt đối chiếu rồi lưu kết quả đã gộp theo (kho, SKU) lên Supabase bằng ba RPC chỉ Admin: `sku_count_save_start` → `sku_count_save_chunk` (tối đa 500 dòng/lần) → `sku_count_save_finish` (`supabase/sku_count_v1.sql`; bảng `sku_count_runs` + `sku_count_rows` chỉ cấp cho `service_role`). Dòng của lượt chỉ hiện với người xem sau khi `finish` đánh dấu lượt hoàn tất, nên không ai thấy dữ liệu dở dang; lượt rỗng bị từ chối để không thay bản chụp cũ bằng bản trống; giữ 3 lượt hoàn tất gần nhất. Phân nhóm (chưa có lần duyệt / lần gần nhất không quá 30 ngày / quá 30 ngày) tính **lúc xem** theo giờ hiện tại, không lưu sẵn, nên mốc 30 ngày luôn đúng dù bản chụp đã cũ. Token WMS vẫn chỉ nằm trong tab WMS/Extension; Supabase chỉ nhận SKU, tên, tồn, vị trí, ngày và người duyệt kiểm kê gần nhất. Giao diện cùng khung với Lịch sử Group UID (`.uid-topbar`, nhóm màu Kiểm tra) và dùng chung bộ công cụ `AdminSyncUI`: thẻ trạng thái bấm để lọc, tab theo tình trạng, tìm không dấu, lọc Kho, sắp xếp, phân trang, xuất Excel và hộp chi tiết theo vị trí; trên điện thoại (nhân viên kho) bảng thành thẻ từng SKU. Test: `tests/inventory_audit_browser.cjs`.

Ô **RỦI RO LƯU TRỮ** (nhóm Kiểm tra trên trang chủ, `#storage-risk`; 12/10/2026 làm lại, bỏ phần quan hệ Normal–Combo) là màn **Hàng chưa lên kệ**: liệt kê hàng còn tồn ở vị trí chưa phải kệ thật trong đúng hai kho `WH - MATERIAL - MTG` và `WH - MATERIAL - GARMENT` (A0, AJ, VR, IT, TF... đều là vùng ảo dạng `F0-<vùng>-00-00-00-NN`). Màn **dùng chung bản chụp của Kiểm kê SKU** (`sku_count_overview`, không migration mới): ai cũng xem được, chỉ Admin có nút **Đọc và đồng bộ WMS** (chạy đúng bộ đọc Extension của Kiểm kê, từ Extension 0.8.1 kèm tổng mọi trạng thái `total`, `modified` (Modified date) và `created` trong `sku_count_rows.locations`). **Chống bỏ sót**: mọi dòng tồn đều được phân loại kệ thật / vùng ảo / vị trí lạ và chỉ "kệ thật" (vùng `KHO`, `XV`, `CAT`, `BAIXE` với mã kệ khác 00) mới bị loại, nên vùng mới, mã sai định dạng hoặc không có vị trí tự hiện là rủi ro; hàng giữ chỗ (In-BIN = 0 nhưng tổng > 0) được lưu trong `sku_count_runs.source_counts.held` thay vì bỏ lặng lẽ; màn báo khi thiếu một trong hai kho, bản chụp quá 24 giờ, số dòng đã lưu lệch số dòng WMS đã đọc, hoặc dòng chưa có ngày. Mức: ≤ 7 ngày Theo dõi, 8–30 Cần xử lý, > 30 hoặc vị trí lạ Rủi ro cao (tính theo giờ lúc xem, từ **Modified date** của dòng tồn WMS; dòng thiếu Modified date dùng tạm ngày tạo và có cảnh báo). Hàng đã tồn 0 (đi qua TF...) cố ý không theo dõi. Test: `node tests/storage_risk_browser.cjs` (cần `python -m http.server 8000`; đặt `PLAYWRIGHT_MODULE` nếu Playwright không nằm trong `node_modules`).

Ô **KIỂM SOÁT CÔNG TRÌNH** (nhóm Kiểm tra trên trang chủ, `#site-control`; 15/10/2026) đối chiếu app Hasaki Construction Management với kho WMS **OFFICE - 130 AP CHANH - MTG** (id 1151, mã 1611) theo từng SKU của app. Chỉ Admin bấm **Đối chiếu** (cần hai tab đang mở và đã đăng nhập: WMS và app xây dựng; Extension 0.9.0). Màn không có bảng nằm sẵn: bốn ô số liệu (SKU theo dõi, Lệch tồn, Lệch nhập, Lệch xuất) mở **popup** danh sách theo chuẩn popup của Đồng bộ SKU / Group UID (ô 0 dòng làm mờ, đối chiếu xong không tự mở popup, ô "Lệch" mở sẵn với bộ lọc Lệch, trên điện thoại là tờ trượt). Trong popup có ba tab: **Tồn kho** (tồn app so với tổng In-BIN theo vị trí WMS, có nhãn *Chưa lên kệ* cho vị trí `F0-<vùng>-00-00-00-NN`), **Nhập** (nhập app so với nhập WMS và khớp từng dòng theo SKU + mã nguồn + số lượng: *WMS có, app thiếu* / *App có, WMS không thấy*) và **Xuất** (xuất app so với lý do `Xuất sử dụng` của WMS; xuất kiểm kê, test, điều chuyển tách ra cột *WMS khác*). Kỳ nhập xuất bắt đầu từ 0 giờ ngày dòng nhập đầu tiên đã nạp vào app. Kết quả chỉ nằm trong trình duyệt (không lưu Supabase, không migration); bấm một dòng mở popup chi tiết xếp chồng trên popup danh sách (Esc đóng chi tiết trước), xuất Excel theo từng tab. App xây dựng được đọc qua endpoint chỉ đọc `/api/stock` và `/api/wms-imports` bằng phiên của chính tab app. Test: `tests/site_control_browser.cjs` (Playwright), `tests/hcm_bridge_reads.cjs`, `tests/wms_bridge_reads.cjs`, `tests/inventory_audit_core.cjs`.

Giao diện hai màn đồng bộ (`#admin/sku-sync`, `#admin/group-uid-sync`, 08/10/2026) dùng chung một bộ công cụ `AdminSyncUI` (khối `admin-sync-shared` trong `index.html`):
- Danh sách thay đổi có ô tìm (không phân biệt dấu), lọc theo nhóm trường, sắp xếp theo mã/ngày cập nhật WMS, phân trang 50 dòng và xuất Excel `.xlsx` (đúng các dòng đang lọc; Group UID giữ đủ 16 chữ số dạng chữ, ngày giờ là ngày giờ thật, dòng tiêu đề dính và có bộ lọc; ghi bằng bộ zip có sẵn của app, không thêm thư viện). Bấm vào mã để sao chép; riêng bảng thay đổi Group UID, bấm mã UID mở hộp chi tiết SKU (kèm số lượng và tên sản phẩm), Batch (Lot), Roll, kho, vị trí, số lượng, trạng thái (giá trị khác bản kia có thêm dòng "Trước") và nút sao chép.
- Mỗi thay đổi hiện từng trường dạng `giá trị cũ → mới` (số lượng kèm chênh lệch), tên trường tiếng Việt, không in `updated_date` trong phần so sánh. UID mới hiện kho, vị trí, số lượng, trạng thái, Lot/Roll và SKU; SKU mới hiện tên sản phẩm (phần đầu in đậm) và nhóm hàng.
- Group UID có thanh cơ cấu kết quả (không đổi / cập nhật / mới / WMS cũ hơn), chênh lệch so với lần toàn bộ trước, tab theo nhóm, cảnh báo bấm được và dải thời gian lần đồng bộ gần nhất; SKU chia thẻ thành 3 cụm (SKU, Combo, Cảnh báo). Lịch sử có lý do lỗi, thời lượng và nút ẩn lượt lỗi.
- Edge Function chỉ trả tối đa 1.000 dòng mỗi nhóm, nên danh sách hiện `đã tải N / tổng` khi nhóm lớn hơn; tìm và CSV chỉ trên phần đã tải.
- Group UID có cột **Kho** (sắp xếp được) và bộ lọc **Kho** chọn nhiều có ô tìm và số đếm theo các bộ lọc đang bật; kết hợp với bộ lọc trường theo kiểu "và" (chip "Đổi kho" là UID bị chuyển kho). Ô tìm và file Excel có cả kho; UID bị chuyển kho hiện kho mới kèm "từ kho cũ". Danh sách chọn dùng chung trong `AdminSyncUI.createList` (tùy chọn `facets`).
- Giao diện điện thoại của màn Admin không được thiết kế lại (chỉ đảm bảo không tràn ngang). Test: `tests/group_uid_sync_admin_browser.cjs`, `tests/sku_sync_admin_browser.cjs`.

## Thiết bị in — kích hoạt máy bằng mã chung

Từ 10/10/2026 (`supabase/print_devices_v1.sql`), máy chủ chỉ nhận lệnh in từ máy đã kích hoạt. Mỗi máy kích hoạt một lần bằng mã chung do Admin tạo, đổi lấy khoá riêng lưu trong trình duyệt (`localStorage` khoá `tb-khoa`). Agent máy trạm không liên quan, vẫn dùng token agent riêng.

Triển khai:

1. Chạy migration: `python scripts/apply_supabase_sql.py supabase/print_devices_v1.sql`. Migration chèn khoá chuyển tiếp `legacy-public` nên máy chưa kích hoạt vẫn in được như cũ.
2. Admin vào **Quản trị → Lệnh in → tab Thiết bị** (`#admin/lenh-in/thiet-bi`), bấm **Tạo mã kích hoạt**. Mã dạng `XXXX-XXXX`, hiệu lực 30 phút, dùng được cho nhiều máy trong thời gian đó, chỉ hiện rõ một lần.
3. Trên từng máy, mở trang chủ, bấm ô **KÍCH HOẠT MÁY** (chỉ hiện khi máy chưa có khoá), nhập mã và tên máy. Ô biến mất là xong. Máy bị máy chủ từ chối cũng tự mở hộp này.
4. Khi mọi máy đã có trong danh sách, tắt **Khoá chung cũ** trong màn Thiết bị in. Từ đó chỉ máy đã kích hoạt mới in được; bật lại được bất cứ lúc nào.

Trong màn Thiết bị in còn có: tắt/bật và đổi tên từng máy, số lệnh in theo máy (`print_jobs.device_id`), thu hồi mã trước hạn. Nhập sai mã quá 30 lần trong một phút thì máy chủ tạm khoá việc kích hoạt một phút. Mất khoá (xoá dữ liệu trình duyệt, đổi máy) thì kích hoạt lại bằng mã mới.

Popup máy (14/10/2026, khối `#pdm-polish`): thân popup có lề, 4 ô thông tin một hàng trên nền nhạt, ô tên + nút cao 44 chữ hệ thống, dòng lệnh in
không bị cắt nhãn trạng thái. Trình duyệt hiện gọn kiểu "Android 10 · Chrome 141" (popup + bảng; chuỗi User-Agent đầy đủ ở title, ô tìm và CSV).
Hộp KÍCH HOẠT MÁY (14/10/2026): sửa `font: … inherit` sai cú pháp → ô tên máy và nút Huỷ / Kích hoạt 16/600 (trước rơi về 400), mã kích hoạt 700.
Popup có thanh tìm + Xuất Excel trên điện thoại (khối `#dlg-polish`, vd. Lịch sử Group UID): nút Xuất Excel giữ cỡ vừa chữ, ô tìm lấy phần còn lại.

## Nạp schema lên Supabase

`scripts/apply_supabase_sql.py` chạy một file `.sql` lên project qua Management API — không cần `psql`, không cần Supabase CLI, chỉ dùng thư viện chuẩn của Python.

Một lần duy nhất: tạo **personal access token** ở https://supabase.com/dashboard/account/tokens (bắt đầu bằng `sbp_`), rồi đặt vào biến môi trường `SUPABASE_ACCESS_TOKEN` hoặc vào file `.env` ở gốc repo (`.env` đã nằm trong `.gitignore`).

```
SUPABASE_ACCESS_TOKEN=sbp_...
```

Token này khác publishable key và secret key: hai key kia chỉ tới được PostgREST nên không chạy được `create table`. Script không bao giờ in token ra màn hình.

```powershell
python scripts/apply_supabase_sql.py supabase/print_devices_v1.sql --dry-run   # xem trước, không gọi Supabase
python scripts/apply_supabase_sql.py supabase/print_devices_v1.sql             # chạy thật
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

## SKU ngừng hoạt động

Từ 11/10/2026 (`supabase/sku_inactive_v1.sql`), SKU ngừng = `SKU_Name.status <> '1'` theo Inside. Không xoá dòng; thay vào đó:

- **Ẩn khỏi tìm kiếm**: policy đọc công khai trên `SKU_Name` chỉ trả SKU đang hoạt động, nên IN TEM SKU và TÌM SKU không gợi ý SKU ngừng. Các hàm tra Group UID, Cắt UID, Combo và Admin vẫn thấy đủ.
- **Chặn in tem SKU mới**: `print_enqueue` từ chối lệnh loại `sku` có SKU ngừng với lỗi `SKU_INACTIVE` kèm danh sách mã. Tem Group UID và tem vị trí vẫn in vì cuộn vải còn trong kho.
- **Cắt UID**: vẫn lưu tem, thẻ "tem vừa lưu" gắn nhãn *SKU đã ngừng hoạt động* và thông báo màu cảnh báo.
- **Mốc ngừng**: cột `inactive_since` do trigger đặt khi `status` chuyển khỏi `'1'`, xoá khi hoạt động lại.
- **Lưu trữ**: pg_cron `sku-inactive-archive` chạy 03:45 thứ hai hằng tuần, chuyển SKU ngừng quá 180 ngày, không còn UID sống, không trong Combo đang Active, không ở phiên xả vải mở và không cắt trong 90 ngày sang bảng `sku_archive`. Kết quả ghi ở `print_maintenance`.

Từ 14/10/2026 **không nạp bù** SKU đã ngừng trước khi đồng bộ (lượt toàn bộ đầu tiên đếm 2.629 SKU như vậy, chỉ 3 còn Group UID sống); Đồng bộ SKU cũng bỏ qua SKU mới đang ngừng. Nếu sau này cần, vẫn có thể nạp bù một lần: xuất Inside **Download → File** có cả SKU Inactive, nhập bằng `scripts/import_sku_xlsx.py`, rồi:

```powershell
python scripts/sync_sku_to_supabase.py --include-inactive
```

Thiếu cờ `--include-inactive`, script vẫn chỉ đẩy SKU hoạt động như trước.

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

## Cấp vải

Ô **CẤP VẢI** (`#cap-vai`, nhóm Vận hành kho): nhập Packing List (.xlsx) → ghép Group UID theo SKU + Lot + Roll →
quét UID để báo "Cấp Group UID này" và đánh dấu đã quét. Nạp schema một lần:
`python scripts/apply_supabase_sql.py supabase/fabric_issue_v1.sql` (chỉ thêm bảng/hàm; bảng bật RLS, chỉ `service_role`,
web đi qua RPC `fabric_issue_*`).

- **Nhập (chỉ Admin)**: đăng nhập Admin bằng nút khiên ở thanh trên → tab *Đợt cấp vải* → *Nhập Packing List*. File được
  đọc ngay trên trình duyệt (không gửi file lên server), chỉ danh sách cuộn đi lên Supabase. Bảng Packing List tìm theo tên
  sheet "Packing" hoặc theo tiêu đề cột ROLLS NO / LOT NO / QTY; mỗi dòng `COLOR: … (SKU 9 số)` đặt SKU cho các dòng bên
  dưới, dòng SUB TOTAL bị bỏ qua. Sheet nào có cột "Mã NPL" + "Định mức cấp phát" thì lấy số cần cấp theo SKU (chỉ hiển thị).
- **Ghép UID** (`fabric_issue_find_uid`): chỉ UID `Available`, cùng SKU; Lot = Batch Code, Roll = Roll Code sau khi chuẩn
  hoá (bỏ khoảng trắng, `12.0` → `12`, bỏ số 0 đầu, không phân biệt hoa/thường); không khớp thì thử Roll Code dạng
  `<batch>-<roll>`. Dòng không ghép được ghi lý do — *Không có UID*, *UID không còn Available* (kèm trạng thái WMS),
  *Trùng dòng*, *Nhiều UID khớp* — và không đoán bừa. Đồng bộ thêm Group UID xong thì bấm *Ghép lại*.
- **Quét**: ai cũng quét được (khoá công khai như Xả vải), bằng máy quét cầm tay hoặc camera. Mỗi lần quét hiện pop-up giữa
  màn hình: *Cấp Group UID này* (xanh, tự đóng sau 1,6 giây), *Đã quét trước đó* (vàng, kèm giờ và máy), *Không cấp* (đỏ: không
  thuộc đợt, hoặc UID chưa có dữ liệu — kèm tên đợt khác nếu UID thuộc một đợt đang mở), *Đợt đã đóng*; vàng/đỏ ở lại tới khi
  chạm, bấm Esc hoặc quét mã khác. Pop-up không chiếm con trỏ nên máy quét cầm tay bắn tiếp được. Mã quét liên tiếp xếp hàng
  tuần tự; âm báo bật/tắt bằng nút loa.
- **Vị trí cần đến**: tab *Vị trí* gom cuộn theo vị trí kệ (`group_uid_details.location`, sắp theo mã vị trí): mỗi vị trí hiện
  số UID còn phải quét / tổng và số mét còn lại, bấm vào để xem từng cuộn (Roll, Lot, UID). Lọc Còn lại / Đã xong / Tất cả; cuộn
  chưa ghép UID gom ở thẻ đỏ riêng. Tab *Danh sách cuộn* lọc Chưa quét / Đã quét / Chưa ghép; cả hai tự làm mới mỗi 20 giây để
  thấy máy quét khác.
- **Không cấp trùng giữa các đợt** (`supabase/fabric_issue_v2_no_double_issue.sql`): UID đã quét ở đợt khác thì quét lại ở đợt
  này báo đỏ *Đã cấp ở đợt khác* (tên đợt, giờ, máy) và không đánh dấu thêm; muốn cấp lại thì Admin bỏ dấu ở đợt cũ. Hai máy
  quét cùng UID ở hai đợt cùng lúc vẫn chỉ một nơi được cấp (khoá tư vấn theo UID). Danh sách/Vị trí đánh dấu sẵn cuộn đã cấp ở
  đợt khác; nhập lại file cảnh báo số cuộn trùng đợt khác và tên đợt trùng tự thêm giờ nhập.
- **Admin** còn có *Ghép lại*, *Đóng đợt / Mở lại*, *Xóa đợt* và bỏ dấu đã quét từng cuộn.
- **Số mét**: tiến độ tính theo Packing List; từng cuộn hiện số mét WMS (đổi từ mm khi tên SKU kết thúc `/mm`) và "PL …"
  khi khác Packing List.

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
khung 4 góc, đèn pin nếu máy hỗ trợ, 1×/2×/3×, "Gõ tay"; nút Back của điện thoại đóng lớp
quét. Chỉ đọc mã nằm trong khung (tem có nhiều mã không bị đọc nhầm). Đọc được mã thì tra
`SKU_Name` trước: đúng SKU → khung xanh + bíp + rung rồi điền vào ô (hộp gợi ý Combo vẫn chạy như
cũ); không có trong danh mục → giữ camera, thẻ chỉ có tiêu đề + mã + 2 nút icon "Dùng mã này" / "Quét tiếp".

**Đợt 4 (11/10/2026, camera):** không có câu hướng dẫn khi quét (khung ngắm tự nói lên việc cần làm; dòng trạng thái chỉ hiện khi
đang mở camera / kiểm tra / đúng mã). Nút gõ tay chỉ ghi "Gõ tay" kèm icon bàn phím (tên đầy đủ ở `aria-label`). Lỗi camera hiện thẻ
icon camera tắt + tên lỗi ngắn và luôn có **Gõ tay**: "Camera đang bị chặn" (kèm icon ổ khoá chỉ chỗ mở quyền), "Camera đang bận",
"Không nạp được bộ đọc mã" có thêm **Thử lại** — mở lại camera ngay trong lớp quét, không phải đóng rồi mở; "Không có camera",
"Cần HTTPS để mở camera" thì không. Điện thoại xoay ngang: khung ngắm bên trái, nút + thẻ thành cột bên phải. Đóng, ẩn tab (chuyển
app) hay nút Back đều tắt camera (`wms-camera-lifecycle`). TÌM SKU cũng bỏ câu "Đưa tem vào khung". Test: `tests/scanner_states_browser.cjs`.

Bộ đọc dùng chung `window.PrintSkuScanner.Jp()` → `doc(video, vung?)` (cả PRINT SKU, Xả vải, TÌM SKU):
`vung` là `{x, y, w, h}` theo tỉ lệ khung hình, nhiều mã thì lấy mã gần tâm nhất. Máy không có
`BarcodeDetector` (iPhone/iPad, Chrome trên Windows) dùng ZXing — trước 01/10/2026 nhánh này gần như
không đọc được QR và mã vạch ngang do lỗi đảo màu của ZXing khi đọc thẳng từ `<video>`, và không đọc
được Code 128 toàn số (SKU, UID) mỗi khi bên trái mã vạch có điểm tối trên cùng hàng do lỗi
`Code128Reader.findStartPattern` của ZXing 0.21.3 (đã vá ngay trong bundle).

Ô Mã SKU có nút bàn phím **chỉ còn icon** (Keyboard / KeyboardOff; `aria-label` và `title` là "Hiện bàn phím" / "Ẩn bàn phím"), nằm cùng hàng bên phải ô Mã SKU (cùng cách ẩn bàn phím như Cắt UID, Sample, Xả vải) — để dùng máy
quét cầm tay không bị bàn phím che; mặc định ẩn, nhớ theo từng máy (`print-sku-ban-phim`). Công tắc áp dụng cho cả bốn ô của form
(Mã SKU, Tên hàng, Số lượng in lên tem, Số bản in): khi ẩn, sau lần quét focus nhảy sang ô kế tiếp cũng không bật bàn phím ảo; muốn gõ tay
thì bấm nút icon để hiện. Bấm "Gõ tay" trong lớp quét thì bàn phím tự bật lại. Số lượng in lên tem và Số bản in luôn nằm một hàng (bộ tăng giảm
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
đầy đủ, có số tròn. Nút bàn phím của Xả vải là icon cạnh ô quét. IN TEM GROUP UID đánh số lại theo thứ tự trên màn: 1 Thêm · 2 Chưa gán SKU · 3 Gán SKU ·
4 Sẵn sàng in. Dòng "Tìm thấy N …" của Tra cứu không hiện khi đang ở tab Quét. Test: `tests/mobile_modules_browser.cjs`.

Đợt 2 (11/10/2026, khối CSS `#mobile-pro-home`, chỉ điện thoại): trang chủ ≤ 620 px là lưới 3 cột ô gọn (icon 40 px, tên 13 px tối đa
2 dòng) — 14 ô vừa một màn 390 × 844 thay vì cuộn 1,5 màn; ≤ 340 px về 2 cột. IN TEM SKU ≤ 800 px theo kiểu đợt 1: số thứ tự khối chấm tròn
22 px, tiêu đề khối 18 px, thẻ phẳng bo 14 px, ô nhập tiêu điểm nhẹ, nút Thêm vào danh sách 46 px bo 12 px (font đã chuẩn từ đợt chuẩn chữ).
Máy tính giữ nguyên. Test: `tests/mobile_home_browser.cjs`.

**Trang chủ theo mẫu (11/10/2026, khối `#home-cards` + script `home-group-count`):** đầu trang icon kho trong ô bo góc + "WH-MATERIAL"
trên ảnh nền kệ kho (ảnh người dùng gửi, nén lại 2000×722 webp ~21 KB và nhúng data URI trong `#home-cards` — không thêm file, không tải ngoài;
lớp tối bên trái giữ chữ trắng đủ tương phản ≥ 4:1 ở mọi bề rộng; đầu trang cao 112 px điện thoại / 148 px máy tính; từ 1200 px ảnh giữ rộng 960 px neo phải, phần trái tô màu nền ảnh mờ dần
vào ảnh — không phóng theo bề rộng màn; màn rộng icon kho thẳng mép thẻ nhóm). Ảnh nằm ở biến `--home-hero`. Đổi ảnh: nén webp rồi thay chuỗi base64 trong `--home-hero`. Mỗi nhóm là một thẻ có thanh tiêu đề màu nhạt (icon tròn, tên nhóm, "0N chức năng" tự đếm số ô đang
hiện — ô KÍCH HOẠT MÁY chèn/ẩn bằng JS cũng được tính). Màu riêng từng nhóm chỉ ở thanh tiêu đề: In tem xanh lá, Vận hành kho xanh dương,
Kiểm tra cam, Quản trị tím (chữ đủ tương phản ≥ 4,5:1). Theo chuẩn: không câu mô tả, không chuông, không mũi tên ">" (chưa có chức năng
tương ứng). Điện thoại ô 3 cột, cuộn khoảng 1,2 màn; máy tính thẻ nhóm xếp 2 cột kiểu báo (không chừa khoảng trống).

**Thanh điều hướng trái (11/10/2026, khối `#app-nav-theme` + script `app-nav-script`, cuối `index.html`).** Chỉ máy tính ≥ 1024 px; điện thoại và
máy tính bảng giữ ô trang chủ + nút quay lại. Thanh 264 px dựng từ chính các ô trang chủ (ô ẩn — vd. KÍCH HOẠT MÁY khi máy đã có khoá — thì mục ẩn;
bấm mục = bấm ô): nhóm WH-MATERIAL › Trang chủ rồi 4 nhóm theo màu trang chủ (ô vuông màu + tên nhóm 14/700, mục con 16/400 có chấm trên đường dọc,
mục đang mở nền trắng + vạch màu nhóm, `aria-current="page"`), thanh cuộn mảnh chỉ hiện khi rê chuột. Nút thu gọn (ô xanh, icon bảng) nằm đầu thanh
trên của từng màn — trang chủ, module, Admin, IN TEM SKU/Cấu hình (React vẽ lại thì gắn lại); **bấm vào khoảng trống của trang** (nền, không
phải thẻ nền trắng / có viền / có bóng, nút, ô nhập, thanh trên, lớp phủ cố định; không khi đang bôi đen chữ) cũng thu thanh — 12/10/2026;
thu gọn là **ẩn hẳn thanh**, nội dung tràn hết bề
rộng, nhớ trên máy (`localStorage` `wh-app-nav-collapsed`). Màn thường: nhóm Quản trị chỉ Kích hoạt máy + Quản trị (mở hộp đăng nhập nếu chưa có
phiên). **Chế độ Quản trị** (mọi `#admin/*`): thanh chỉ còn ← Trang chủ (ô icon xanh), nhóm Quản trị 5 mục mỗi mục một ô icon 36 px + tên ngắn
(Lệnh in, Đồng bộ SKU, Đồng bộ UID, Kiểm kê, Cấu hình — tên đầy đủ ở `aria-label`/`title`; mục đang mở ô tím đặc) và **Đăng xuất** ở chân thanh —
thay thanh bên riêng của Admin (`.ss-side`, `#root aside` ẩn từ 1024 px). Admin báo trạng thái qua `PrintSkuAdminAccess.isAuthorized()` (sự kiện `print-sku-admin-ready` có thể bắn trước khi
script cuối body chạy). Nút "← WH-MATERIAL" ẩn vì đã có mục Trang chủ; dưới tên module có tên nhóm viết hoa giãn chữ theo màu nhóm. Nội dung lùi
bằng `--app-nav-w`; chỉ chuyển động khi bấm thu gọn (CSS cuối body tới sau lần vẽ đầu nên không để trượt lúc tải). Không ra giấy in.
Test: `tests/app_nav_browser.cjs`.

**Ảnh nền 4 nhóm + chuẩn thanh trên (11/10/2026, khối `#group-banners` cuối `index.html`).** 4 ảnh người dùng gửi (nén 1280 px webp
~12–17 KB/ảnh, nhúng data URI ở biến `--grp-img-print/ops/check/admin`): In tem xanh lá (máy in tem), Vận hành kho xanh dương (xe nâng), Kiểm tra
cam (bảng kiểm), Quản trị tím (laptop). Dùng ở thanh tiêu đề 4 thẻ nhóm trang chủ và thanh trên của mọi màn theo nhóm — module (`.uid-topbar`),
IN TEM SKU (`#root > header`), Admin (`.ss-top`, Cấu hình `#root header.ss-command-react`). Ảnh neo phải, rộng tối đa `--gb-w` (thanh trên 760 px,
thẻ nhóm 380 px), phần trái tô `--gb-fill` mờ dần vào ảnh, lớp tối `--gb-shade` bên trái (điện thoại giữ đậm tới 72 % bề ngang) cho chữ trắng —
đo điểm ảnh sáng nhất dưới chữ ≥ 4,5 ở mọi màn. **Chuẩn thanh trên:** máy tính cao 80 px; chữ trắng; ô icon / nút thanh trái / nút quay lại nền trắng
mờ; chip trạng thái nền trắng; Admin tiêu đề 18/700, ô icon 38, icon KPI 16, chữ ≥ 12 / đậm ≤ 700, bỏ dòng "WH-MATERIAL". Điện thoại giữ chiều cao
cũ. Map nhóm ↔ màn nằm trong CSS (ID màn). Test: `tests/group_banners_browser.cjs`.

**Soát Admin (12/10/2026, khối `#admin-polish`).** Thanh trên Admin gọn: ẩn ô KPI và mốc giờ của Header B (trùng các thẻ ngay bên
dưới — script vẫn tính) → còn tên màn, dòng phụ, trạng thái kết nối/Extension, nút làm mới (Cấu hình: Kiểm tra lại + trạng thái máy in). Icon mục
Admin ở thanh trái = icon trên thanh trên của từng màn. Tab Thiết bị: nút Tạo mã kích hoạt icon cạnh chữ, chữ trắng 14 (quy tắc `.pdm-strip span`
từng làm chữ xám 12); bỏ câu hướng dẫn. Đồng bộ SKU / Group UID < 1200 px: tên khối trên, hàng nút dưới, không vạch ngăn lẻ. Đồng bộ Group UID chưa
có lượt thì không hiện dấu "—" ở dòng trạng thái. Ghi chú: "Tin cũ" là trạng thái có sẵn của ô máy in (thông tin máy in đã cũ).

**Soát Cấp vải (12/10/2026, khối `#cap-vai-polish`).** Dòng thông báo trống thì ẩn (trước hàng tab cách thẻ 48 px); nút camera / bàn phím
cạnh ô Group UID có khung như Cắt Group UID; số thứ tự cách tên thẻ 8 px ở mọi bề rộng (sửa luôn Cắt Group UID, Theo dõi xả vải — máy tính
trước dính sát); tab Danh sách trên điện thoại gọn 3 dòng mỗi cuộn (Group UID + trạng thái; SKU · Lot · Roll; số mét · vị trí), ~92 px thay ~185 px;
máy tính giữ bảng.

**Cấp vải · thẻ Quét Group UID gọn (12/10/2026, khối `#cap-vai-compact`).** Đầu thẻ: tiêu đề + nút âm báo + nút thu gọn (^). Khối đợt cấp:
icon tem (ẩn ≤ 480 px) | chọn đợt, thanh tiến độ, "x / y cuộn" · mét | chip ✓ đã quét, 🕐 còn lại (⚠ chưa ghép khi có; chữ chỉ đọc màn hình + title).
Hàng quét = ô Group UID liền (khối chung `#scan-field`, xem dưới). "Xem chi tiết" (`<details>`) chứa chip có chữ (+ "đã đóng") và lượt quét gần đây; ẩn khi chưa có đợt và chưa quét. Thu gọn ẩn khối đợt cấp, đầu thẻ
hiện số đã quét / tổng. Trạng thái thu gọn và Xem chi tiết nhớ theo máy (`localStorage` `cap-vai-thu-gon`, `cap-vai-chi-tiet`). Giữ nguyên id cũ.

**Ô Group UID liền (14/10/2026, khối `#scan-field`; mockup Cấp vải 12/10).** Dùng chung cho Cắt Group UID, Theo dõi xả vải, Cấp vải: `.scan-field`
= icon quét | vạch | mã | `.scan-field__tools` (camera · bàn phím nằm trong ô, nền xanh nhạt, vạch giữa; bàn phím đang bật = nền trắng; camera ẩn thì
ô bớt lề phải). Nút chính (Lưu tem / Bắt đầu xả vải / Quét) bên phải trên máy tính, dưới và rộng hết ≤ 620 px. Xả vải: nút bàn phím trước nằm ngoài
form (form `display: contents`) nay vào trong ô; nút camera trước là icon khung quét nay là icon camera như hai màn kia. Chữ trong ô giữ "Group UID".
Test `ui_standard` kiểm nút trong ô cao = ô nhập − 8 và nằm gọn trong ô; `mobile_modules` chấp nhận nút bàn phím cạnh hoặc trong ô.

**IN TEM SKU · Phiếu IT (15/10/2026, Extension 0.9.1, khối `#sku-it-style` + script `sku-it-script`).** Nút **Phiếu IT** ở thẻ 1 (từ 801 px, cần Admin như các màn đọc WMS) mở tấm `#sku-it`: nhập số phiếu IT (chuyển kho nội bộ, vd `1007261015013137`) → **Đọc phiếu** → Extension đọc phiếu trên WMS (lệnh chỉ đọc `GET_INTERNAL_TRANSFER`: `internal-transfers?internal_transfer_numbers=` tìm đúng số phiếu, rồi `transfer/internal-transfer-items/list-details?internal_transfer_id=` lấy hết các dòng một lần). Tấm hiện số phiếu · kho đi → kho đến · trạng thái · số dòng · mô tả, và từng dòng: ô tick, SKU, tên, **số lượng đúng theo phiếu** kèm đơn vị (pcs / mm / g; có phiếu không ghi đơn vị) và **số bản in** (mặc định 1, chỉnh bằng −/+ hoặc gõ, 1–200). Tên lấy theo danh mục `SKU_Name` như khi nhập tay; SKU không có trong danh mục (đã ngừng / chưa đồng bộ) gắn nhãn "Không có trong danh mục" và bỏ tick sẵn (máy chủ từ chối cả lệnh nếu có SKU ngừng). **Thêm N SKU vào danh sách** đưa thẳng vào danh sách chờ in của React qua `window.PrintSkuWorker.add` (cùng dạng nút Thêm vào danh sách: `{sku, pn, slHang = số lượng phiếu, ban = số bản}`) nên Sửa / Xoá / In tem chạy như cũ; một lệnh in tối đa `tranSku` SKU (hàng đợi trả 30): chọn nhiều hơn chỗ còn trống thì báo lỗi, không thêm. Dòng đã thêm bị bỏ khỏi tấm, dòng chưa tick giữ lại. **Chỉ Admin:** thanh trên IN TEM SKU có **khiên Admin** (`#sku-admin`, cùng kiểu các màn khác: trắng khi chưa đăng nhập, xanh có dấu tick khi là Admin, bấm khi là Admin thì hỏi thoát; hiện cả điện thoại); chưa là Admin thì bấm **Phiếu IT** không mở tấm mà mở hộp đăng nhập Admin dùng chung, đăng nhập xong tấm tự mở; hết phiên giữa chừng thì tấm đóng lại và hỏi đăng nhập. Test: `tests/sku_it_browser.cjs`, `tests/internal_transfer_core.cjs`.

**IN TEM SKU theo mẫu (11/10/2026, khối `#sku-queue-ui` + script `sku-queue-ui-script`).** Bundle React không có chọn/sửa/xoá nhiều tem nên
danh sách chờ in của React (`ul.divide-y`) bị ẩn và thay bằng danh sách mới đọc lại từ nó (SKU, tên, số lượng in lên tem, số bản): mỗi dòng ô chọn
(tem mới mặc định đã chọn), số lượng + "N bản", nút **Sửa** (đưa tem về ô nhập rồi bỏ khỏi danh sách — React tra danh mục có thể xoá tên nên điền
lại tới khi các ô giữ nguyên 1 giây; người dùng bấm/gõ thì dừng) và **Xoá** (bấm nút Bỏ của React). Thẻ 2 có chip "N tem"; thanh đáy thêm
Chọn tất cả + xoá tem đã chọn (hỏi lại bằng WhDialog) và tổng "N tem / Tổng M bản in". Điện thoại: nút › mở tấm kéo lên (tìm theo SKU/tên không dấu,
lọc Tất cả / Đã chọn / Chưa chọn, In tem). **In tem vẫn in cả danh sách** như React (ô chọn dùng cho xoá nhiều). Thẻ 1 đổi tên "Nhập thông tin
tem" + icon nhãn; ô SKU giữ gợi ý "SKU" (chuẩn không câu hướng dẫn). Test: `tests/sku_queue_browser.cjs`.

**IN TEM GROUP UID + IN TEM SKU · thanh trên điện thoại (14/10/2026, khối `#uid-topbar-narrow`).** ≤ 440 px: tên màn dòng trên, trạng thái
máy in dòng dưới trong cùng thanh, nút Admin (nếu có) bên phải (trước cùng một hàng nên 360–390 px cắt "IN TEM GROUP U…" / "IN TEM SK…").
Trạng thái khi máy trạm in không báo về quá 45 giây hoặc không gọi được máy chủ: **"Mất kết nối máy in"** (trước "Chưa rõ máy in").

**IN TEM GROUP UID · Lấy từ WMS (14/10/2026, Extension 0.8.3).** Nút **Lấy từ WMS** cạnh Nhập Excel (chỉ hiện từ 801 px: điện thoại không có Extension) mở tấm `#uid-wms`:
đọc Group UID trạng thái **New** của WH - MATERIAL - MTG (1177) và WH - MATERIAL - GARMENT (1339) qua lệnh chỉ đọc `GET_GROUP_UID_NEW_PAGE`
(500 dòng/trang). WMS chỉ lọc được kho, trạng thái và mốc cập nhật (`from_updated_at` + `to_updated_at`, cần đủ cả hai); **không có bộ lọc ngày tạo
hay người tạo**, nên hai bộ lọc này chạy ở trình duyệt trên dữ liệu đã tải: UID New chưa đổi có `updated_at` = `created_at`, nên đọc từ mốc "từ ngày"
là tập cha của khoảng ngày tạo. Bộ lọc: chip kho (không bỏ hết được), chip ngày (Hôm nay / 7 ngày / 30 ngày / Tất cả / chọn ngày) và ô người tạo
có số đếm, và ô **Đợt tạo** (cùng phút + cùng người tạo, đúng dòng "04/08/2026 15:59 · tuanlq5@hasaki.vn" dưới mỗi UID, đợt mới nhất trước, kèm số UID; UID thường được tạo hàng loạt cho một lô cuộn; thu hẹp theo kho / ngày / người tạo, đổi bộ lọc làm đợt không còn thì tự bỏ chọn). Thu hẹp bộ lọc không gọi lại WMS; mở rộng kho hoặc khoảng ngày thì đọc lại. Chọn từng UID hoặc Chọn tất cả (cả phần chưa hiện), **Thêm N vào danh sách**
đưa qua đúng đường nhập tay (`addGroupUids`: tra Supabase, có SKU vào Sẵn sàng in, chưa có vào Chưa gán SKU) và lấy Lot / Roll của WMS (`batch_code`,
`roll_code`) làm gợi ý khi Supabase chưa có. UID đã có trong danh sách hiện nhãn "Đã có", khoá ô chọn. Cổng cho tấm là `window.PrintSkuUid {has, add}`.
**Chỉ Admin được đọc từ WMS** (như Lịch sử Group UID): chưa có phiên thì bấm nút sẽ mở hộp đăng nhập Admin dùng chung, đăng nhập xong tự mở tấm; hết phiên giữa chừng thì tấm đóng lại và hỏi đăng nhập. Đây là cổng giao diện (Extension tự đọc bằng phiên WMS của máy). Thanh trên IN TEM GROUP UID có **khiên Admin** (`#uid-admin`, cùng kiểu Cắt Group UID / Lịch sử Group UID / Kiểm kê SKU / Rủi ro lưu trữ / Cấp vải: trắng khi chưa đăng nhập, nền xanh + dấu tick khi là Admin, bấm khi là Admin thì hỏi thoát); mọi màn có việc cần Admin đều dùng khiên này.
Đo 14/10/2026: 5.590 UID New (Garment 4.213, MTG 1.377; ~2,5 MB), 7 ngày = 84. Test: `tests/group_uid_wms_picker_browser.cjs`, `tests/group_uid_new_core.cjs`.

**IN TEM GROUP UID · Lấy từ WMS — chuẩn hoá giao diện (14/10/2026, khối `#uid-wms-std`, chỉ CSS, từ 801 px).** Bộ lọc kiểu Admin (Lịch sử Group UID /
Đồng bộ), 2 hàng: ngày tạo = thanh tab xám (mục chọn nền trắng) + chip kho viền nhạt (bật = xanh nhạt); nút lọc Người tạo / Đợt tạo có icon + mũi tên
(đang lọc = xanh nhạt) … nút tải lại cuối hàng. Mọi mục bấm cao 44 (test `group_uid_wms_picker`). Danh sách dạng bảng: đầu bảng "Chọn tất cả" xám nhạt,
mỗi UID một dòng (mã │ kho · ngày tạo · người tạo │ Lot · Roll). 1280 × 800 thấy 6 UID (trước 2). Chức năng, id, chữ giữ nguyên.

**IN TEM GROUP UID · tab Gán WMS — gán theo Packing List PO (14–15/10/2026, Extension 0.8.4).** Khung Gán SKU có ba tab: **Gán theo tick chọn**, **Gán tự động** (luồng cũ giữ nguyên: dòng SKU + số UID nhập tay, nút khoá khi vượt UID chờ gán) và **Gán WMS** (từ 801 px, cần Admin như Lấy từ WMS). Gán WMS: nhập **Mã PO** + nút **Packing List** (nhiều PO cách nhau bằng dấu phẩy / xuống dòng, tối đa 20) → Extension đọc Packing List của PO trên WMS (lệnh chỉ đọc `GET_PACKING_LIST_PAGE`, lọc `purchase_order_numbers`, 500 dòng/trang). **Mỗi dòng đã Approved là một cây vải** (kể cả số lượng 1 mã "1": PO `10012610099966` có 2 dòng = 2 cây = 2 UID) nên số UID = số dòng theo từng SKU; SKU Combo (kg) đổi sang SKU Normal bằng RPC `sku_combo_lookup` (SKU không có liên kết giữ nguyên, Combo nhiều thành phần bỏ ra và báo), các Combo cùng Normal cộng lại, tối đa 500 UID một dòng. Hiện **danh sách SKU Normal + số UID + tên**, mỗi dòng có ô tick (mặc định đã tick), chỉnh được số UID và **nút xóa SKU** (xóa được từng dòng, kể cả dòng cuối; đọc lại PO thì danh sách có lại); "Sẽ gán" chỉ tính dòng đã tick và tự cập nhật khi thêm / xóa UID chờ gán. Bấm **Gán Group UID**: thiếu UID chờ gán thì báo lỗi "Thiếu N UID chờ gán: cần X, đang chờ Y" và không gán gì; đủ thì gán UID chờ theo thứ tự (chọn UID New bằng **Lấy từ WMS** trước), dòng đã gán bị bỏ, dòng chưa tick giữ lại để gán sau. **Không gán Lot/Roll:** tem in trước khi nhận hàng, WMS gán Lot/Roll cho UID New lúc nhận. Bỏ ra và báo: dòng chưa Approved, Combo nhiều thành phần, PO chưa có Packing List. Test: `tests/group_uid_po_browser.cjs`, `tests/packing_list_core.cjs`.

**Soát chuẩn 15/10/2026 (khối `#std-1510`).** Kiểm soát công trình: ô "Lệch xuất" và tiêu đề popup Xuất dùng icon tải lên (thêm `upload` vào bộ icon
Admin, cặp với tải xuống của Nhập; trước là mũi nhọn ^); nhãn "Chưa lên kệ" trong dòng vị trí popup chi tiết dùng font chung. IN TEM GROUP UID · Gán WMS
(> 800 px): SKU + tên từ Packing List (ô chỉ xem) hiện như chữ — hàng 1 SKU đậm + số UID + xoá, hàng 2 tên. Trang chủ điện thoại (≤ 620 px): ô lẻ cuối
nhóm (Kiểm tra 4 ô) thành thẻ ngang hết hàng, dải tiêu đề nhóm 58 px, nhóm cách 12 px → ô cuối 1042 px (≤ 1,25 màn). Test `mobile_home`: ô vuông ≥ 88 px,
thẻ ngang ≥ 56 px.

**IN TEM SKU · Phiếu IT — chuẩn hoá (15/10/2026, khối `#sku-it-std`, chỉ CSS).** Cùng kiểu tấm "Lấy từ WMS" (> 800 px): ô số phiếu + "Đọc phiếu" cao
như ô nhập (52, giống Mã PO / Packing List của Gán WMS); danh sách dạng bảng — đầu bảng "Chọn tất cả" xám nhạt, dòng ngăn bằng vạch, dòng chọn xanh nhạt,
dòng ngoài danh mục vàng nhạt; bộ tăng giảm số bản 44. Chung mọi popup: `:root` đang `color-scheme: dark` (giao diện cũ) nên hộp thoại nằm ngoài các màn
sáng (Phiếu IT, danh sách chờ in IN TEM SKU, Kích hoạt máy, đăng nhập Admin, popup Admin…) thừa hưởng tối — ô tick chưa chọn tô đen; nay
`dialog, #admin-auth, #cut-barcode-modal` luôn `color-scheme: light`.

**Soát P0 vùng bấm + focus (16/10/2026, khối `#p0-1610`, theo lộ trình `docs/DOI_CHIEU_HIEN_TRANG_VA_HUONG_CAI_THIEN_UI_UX.md`).** Nút ☰ điện thoại /
máy tính bảng 42 → 44; chip bộ lọc đang dùng của Lịch sử Group UID 32 → 44 (chuẩn chip lọc); ô tìm danh sách IN TEM GROUP UID có vòng focus 3 px.
Nút icon trong ô nhập trên điện thoại 40 → 44 (người dùng chọn): biến chuẩn `--ui-icon-in` điện thoại 44; cụm camera · bàn phím của ô Group UID liền
cách mép ô 2 px (ô 48) → nút 44 ở mọi khổ (test `ui_standard` kiểm 44). Sau đợt này không còn vùng bấm < 44 trên 13 màn điện thoại.

**Tấm `.uid-sheet` trên máy tính (16/10/2026, khối `#sheet-center`).** Phiếu IT, Lấy từ WMS, Danh sách Group UID, danh sách chờ in IN TEM SKU: từ 801 px
hiện giữa màn như popup Admin (bo 4 góc, cao tối đa 88vh, bỏ thanh kéo); trước dính đáy kiểu tấm kéo lên của điện thoại — màn rộng, chưa đọc phiếu thì
thành dải thấp sát đáy. Điện thoại giữ tấm kéo lên từ đáy.

**Khổ trung (16/10/2026, khối `#mid-width`).** Máy tính bảng 801–1023 px, hoặc 1024–1199 px khi thanh trái mở (vùng nội dung ~730–790 px): nhãn tab ngắn ở
Cắt Group UID / Xả vải / Cấp vải (trước "Tra cứu UID đã cắt" xuống 2 dòng); Chuyển đổi đơn vị 1 cột (trước ô "SKU hoặc Group UID" còn ~100 px); dải 4 ô
thông tin (`.as-strip` có đúng 4 ô: Rủi ro lưu trữ, Kiểm kê SKU, Admin…) xếp 2 × 2 (trước 3 + 1).

**IN TEM GROUP UID theo mẫu (11/10/2026, khối `#uid-mockup` + sửa trong script màn).** Ô Group UID có icon mã vạch, camera cùng hàng, nút
**Thêm vào danh sách** xuống hàng riêng (mọi bề rộng); Nhập Excel viền liền. Thẻ **Chưa gán SKU**: chip số + › (điện thoại), hàng Chọn tất cả +
**Xóa đã chọn** (hỏi lại bằng WhDialog), ô tìm Group UID / Lot / Roll (chuẩn ô nhập), mỗi dòng UID + "Lot | Roll" + "Thêm: dd/mm/yyyy hh:mm" (giờ thêm
lưu ở `addedAt` khi tra xong) + **chép** + xoá; điện thoại hiện 3 dòng đầu + "Xem tất cả". Tay kéo **⋮⋮** (12/10/2026) đổi thứ tự UID
chờ gán — kéo bằng chuột/cảm ứng hoặc phím mũi tên trên tay kéo, có cả trong tấm kéo lên; thứ tự có tác dụng vì Gán tự động lấy UID từ đầu khung
chờ; đang tìm / lọc "Đã gán" thì ẩn tay kéo. Tấm **Danh sách Group UID** (› hoặc Xem tất cả): tìm,
lọc Tất cả / Chưa gán SKU / Đã gán (UID đã gán không có ô chọn, có SKU · tên), Chọn tất cả, "Đã chọn N / Tổng M Group UID", Xóa đã chọn, Xác nhận.
Thẻ **Gán SKU** có icon nhãn; ô SKU và Tên sản phẩm chiếm cả hàng, ô SKU có quét (lớp quét SKU dùng chung) và nút ẩn/hiện bàn phím. Test:
`tests/group_uid_mockup_browser.cjs`.

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
