# Chuẩn giao diện (25/10/2026)

Áp cho: mọi màn trong `index.html`, kể cả CSS đè lên bundle React. Đọc khi: làm màn mới, sửa giao diện, chụp ảnh review.
Gom từ mục lục `RULES.md` chủ đề 2, các mục "Chuẩn …" của `README.md`, `docs/DOI_AGENT.md` và các test chuẩn; không có luật mới. Luật nền (tiếng Việt, không CDN, sửa nhỏ nhất): `AGENTS.md`.

## Nguyên tắc

- Icon Lucide trước, nhãn ngắn; không câu hướng dẫn kiểu AI trong màn (giữ thông báo trạng thái, lỗi, xác nhận); placeholder chỉ là danh từ; kết quả đo (%, số) chữ to. Giữ bởi: `icon_standard_browser` (một phần). Nguồn: (02–11/10 · N0081, N0029, N0499)
- Màn nghiệp vụ dùng được trên điện thoại ≥ 375 px; Admin (`#admin/*`) chỉ xét máy tính. Giữ bởi: `ui_standard_browser`, `a11y_axe_browser` (390 + 1280). Nguồn: (08/10 · N0052, N0106–N0130)
- Không có màn đăng nhập trước màn thao tác; header luôn thấy tên module; nút Back ở đầu header, về `#home`. Nguồn: (02/10 · N0106–N0130, N0083)
- Module mới ưu tiên pop-up: ô số liệu mở `.as-dialog`, bấm dòng mở chi tiết. Nguồn: (08/10, 15/10 · N0042, N0006)
- Màn mới hoặc làm lại: được dùng kỹ năng `frontend-design` cho bố cục, thứ bậc, trạng thái rỗng / đang chờ / kết quả, nhưng chuẩn trong tệp này thắng khi khác nhau; không thêm font, CDN hay thư viện. Nguồn: `docs/DOI_AGENT.md` trước 25/10; (17/10 · N0965, N0981)

## Màu, chữ, tương phản

- Màu thương hiệu `--wms-brand` #005F41; trạng thái `--wms-success` #0f6e49, `--wms-warning` #8a5a00, `--wms-danger` #b42318; chữ / viền / focus dùng token `--wms-text-2`, `--wms-on-brand`, `--wms-control-border`, `--wms-border-accent`, `--wms-focus-ring`. Không thêm mã màu cứng. Giữ bởi: `design_tokens_ratchet`. Nguồn: (23/10 · N1163, N1168)
- Một font hệ thống `--wms-font`; cỡ chỉ 12 · 13 · 14 · 16 · 18 · 22 · 28; đậm 400 · 600 · 700; chữ hoa chỉ ở tiêu đề nhóm trang chủ, đầu bảng Kiểm tra đầu vào, ô mã vị trí. Tem in giữ Arial. Giữ bởi: `typography_browser`. Nguồn: (10/10 · N0460, N0463)
- Giao diện sáng; hộp thoại ép `color-scheme: light` (`:is(dialog, #admin-auth, #cut-barcode-modal)`). Nguồn: (26/09, 15/10 · N0379, N0796)
- Tương phản chữ ≥ 4,5 : 1 (chữ lớn ≥ 3), icon ≥ 3 : 1; không dùng opacity làm mờ ô / dòng (trừ ô tick tắt .4). Giữ bởi: `a11y_axe_browser`, `contrast_states_browser`. Nguồn: (11–23/10 · N0522, N1163, N1172)

## Kích thước, vùng chạm, icon

- Khối `#ui-standard` (`--ui-*`): thẻ bo 22 / 14; ô nhập và nút chính cao 52 / 48; nút icon cạnh ô 52 / 48, trong ô 44; điều khiển gọn cao 44, chữ 14/600. CSS mới chỉ dùng `--ui-*`. Giữ bởi: `ui_standard_browser`. Nguồn: (11/10 · N0514; README "Chuẩn giao diện chung")
- Mọi vùng bấm ≥ 44 px trên điện thoại (`--target-min`, thêm `::after` khi cần); chữ ≥ 12 px; ô nhập chữ 16 px trên điện thoại. Giữ bởi: `touch_target_browser`, `small_targets_browser`. Nguồn: (11–23/10 · N0806, N1137, N1172, N0085)
- Icon nét 2, `currentColor`, chỉ cỡ 16 / 20 / 24 / 32 (`#icon-standard`); không dùng ký tự làm icon (→ ← ×); nút chỉ có icon luôn có `aria-label` / `title`; nút −/+ và `.act-icon` dùng mask `::before`; một chức năng lặp ở nhiều màn dùng cùng icon. Giữ bởi: `icon_standard_browser`. Nguồn: (26/09, 11/10 · N0398, N0499, N0710)
- Ô tick một kiểu (`#tick-standard`): vuông 22 px (≤ 800 px: 24), tick #005F41, viền #6f8f83; ô tick không bọc label có vùng chạm 44 bằng `::after`. Giữ bởi: `tick_standard_browser`. Nguồn: (22–23/10 · N1126, N1172)

## Khung màn và điều hướng

- Trang chủ `#barcode-home`: 4 nhóm có ảnh nền (`#group-banners`), không câu mô tả; máy tính 2 cột, ≤ 620 px 3 cột; ô QUẢN TRỊ ở nhóm cuối. Giữ bởi: `mobile_home_browser`. Nguồn: (07–15/10 · N0074, N0475, N0534, N0540, N0562, N0774)
- Thanh trái ≥ 1024 px (`#app-nav-theme`): thu gọn = ẩn hẳn; ở `#admin/*` chỉ ← Trang chủ + mục Quản trị + Đăng xuất; điện thoại giữ menu ☰. Giữ bởi: `app_nav_browser`. Nguồn: (11–12/10 · N0549, N0556, N0559, N0586)
- Thanh trên `.uid-topbar`: Back là phần tử đầu; ≤ 760 px Back chỉ icon 44; máy tính cao 80, chữ 12/18. Nguồn: (07–17/10 · N0075, N0564, N0597, N1003)
- Nút đọc nguồn một kiểu `.src-read` ("Đọc WMS", "Đọc Inside", phạm vi lớn "Toàn bộ"), gộp vào dải mốc giờ (`#strip-read`); nút ghi "Cập nhật" + huy hiệu `data-count`; vạch load 3 px dưới nút đang chạy. Giữ bởi: `src_read_style_browser`, `strip_read_browser`. Nguồn: (17–18/10 · N1003, N1007, N1018)
- Chú thích tĩnh dưới thẻ số liệu chuyển thành `title`, trừ chú thích ở dải mốc giờ. Nguồn: (18/10 · N1006, N1010)

## Hộp thoại, tấm, bảng, báo lỗi

- Xác nhận dùng `WhDialog.confirm` (không `confirm()`): tiêu đề ngắn, `facts`, tối đa 5 mã rồi "+n", nút ghi việc + con số; `warning` / `danger` con trỏ ở Huỷ. Giữ bởi: `wh_dialog_browser`. Nguồn: (08/10 · N0429)
- Tấm `.uid-sheet` ≥ 801 px hiện giữa màn (`#sheet-center`), điện thoại trượt từ đáy. Nguồn: (16/10 · N0820)
- Bảng thành thẻ trên điện thoại (`#wms-table-labels`); 801–1199 px dùng nhãn tab ngắn `.tab-s`. Nguồn: (02/10, 16/10 · N0083, N0828)
- Xuất bảng là `.xlsx` (`AdminSyncUI.xlsxBlob` / `PrintSkuZip.buildZip`, ô chữ `inlineStr` giữ mã 16 số); nút Xuất là icon Download 44 có `aria-label`. Giữ bởi: `xlsx_export`. Nguồn: (26/09, 12/10 · N0370, N0016)
- Báo lỗi, Thử lại, khung chờ, trạng thái rỗng dùng `window.PrintSkuNotice`: câu lỗi "<phần không tải được>: <nguyên nhân>"; Thử lại chỉ cho lần tải / đọc, không cho quét / ghi; vạch chờ sau 350 ms; thẻ `.ss-metric` chỉ tô màu khi có số. Giữ bởi: `notice_standard_browser`. Nguồn: (23–24/10 · N1187, N1194)

## Quét, camera, âm báo, nút In

- Mọi ô quét (trừ TÌM SKU) dùng khung `.scan-field`: bàn phím ảo ẩn mặc định, nút bàn phím nhớ theo máy. Giữ bởi: `scan_field_standard_browser`. Nguồn: (03–18/10 · N0078, N0650, N1013)
- Ô quét không dùng `readonly` / `virtualkeyboardpolicy="manual"` (máy quét gõ qua IME); giữ focus ô quét chỉ ở tab quét; không tự submit. Nguồn: (19/09–05/10 · N0190, N0329, N0331, N0076)
- Âm báo quét chung `PrintSkuScanCue.play(tone)`; tắt âm vẫn rung. Camera chung `PrintSkuScanUI`, lỗi có Thử lại trong cùng lớp. Nguồn: (01–23/10 · N1168, N0412, N0417, N0063, N0507)
- Nút In: trạng thái `data-print-state` idle / working / failed / disabled, vạch load tới khi lệnh xong, lỗi → "Thử lại" dùng lại nonce; mọi lệnh qua `PrintSkuQueue.enqueue` hiện lớp phủ chibi chung (tick 700 ms rồi đóng). Nguồn: (03/10, 25/10 · N0079, N1206)
- Không đặt `min-height: 100vh` cho `.cut-screen` (Chrome Android cắt thanh đáy). Nguồn: (10/10 · N0030)
- Chuyển động tôn trọng `prefers-reduced-motion`. Nguồn: (03/10, 25/10 · README "Nút In tem"; N1204)

## Kiểm giao diện

- Chụp ảnh 390 + 1280 px (Admin chỉ 1280) ngay khi màn chạy được lần đầu; Codex xem ảnh một vòng, không gửi lại sau khi sửa. Quy trình: `docs/DOI_AGENT.md` bước 3.
- Bộ test chuẩn phải đạt: `design_tokens_ratchet`, `typography_browser`, `ui_standard_browser`, `icon_standard_browser`, `a11y_axe_browser`, `contrast_states_browser`, `touch_target_browser`, `small_targets_browser`, `tick_standard_browser`, `scan_field_standard_browser`, `notice_standard_browser`.

## Chưa thống nhất (chờ chốt hoặc sửa ở đợt sau)

- `README.md` mục "Header các màn hình" ghi header cao 64 px; mục lục `RULES.md` (12/10 · N0564) ghi máy tính cao 80. Tệp này theo `RULES.md`; README sửa ở đợt 4.
- `docs/THIET_KE_HEADER_UI.md`, `docs/THIET_KE_BO_ICON_UI.md`, `docs/THIET_KE_BUTTON_IN_TEM_CHUYEN_DONG.md` là đặc tả gốc 03–07/10, đã đánh dấu lịch sử; luật hiện hành ở tệp này.
