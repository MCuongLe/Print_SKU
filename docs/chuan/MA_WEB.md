# Chuẩn mã web `index.html` (25/10/2026)

Áp cho: mã trong `index.html` (CSS, markup, script). Đọc khi: sửa hay thêm module, cổng dùng chung, script vá.
Gom từ `docs/CONTEXT_MAP.md` mục 1, `docs/PROJECT_MAP.md` mục 2, `docs/QUYET_DINH.md` chủ đề 1–3, 9 và `docs/DOI_AGENT.md`; không có luật mới. Luật nền (trang tĩnh, không CDN / npm, sửa nhỏ nhất, grep giới hạn độ dài dòng): `AGENTS.md`. Giao diện: `docs/chuan/GIAO_DIEN.md`. Dữ liệu, RPC, Extension: `docs/chuan/DU_LIEU.md`.

## Cấu trúc khối

- Mỗi module là `<style id="…">` + `<section id="…-screen">` + `<script id="…">` (IIFE). Khối mới đặt trong `<style id>` / `<script id>` riêng; mọi khối có id. Nguồn: `docs/CONTEXT_MAP.md` mục 1; `docs/DOI_AGENT.md` trước 25/10; (23/10 · N1184)
- Tìm khối bằng `python scripts/index_outline.py [chuỗi lọc]` hoặc id / chuỗi neo, không theo số dòng. Nguồn: (23/10 · N1184)
- Bundle React (IN TEM SKU, Cấu hình Admin) không có source: chỉ chỉnh bằng CSS đè và cổng nhỏ (`PrintSkuScanner`, `PrintSkuWorker`); màn JS thuần sửa markup tự do. Không tách source hay viết lại phần React. Nguồn: (26/09, 11/10, 15/10 · N0380, N0087, N0789, N0529–N0531)

## Cách sửa `index.html`

- Sửa bằng script Python phát lại được, neo theo chuỗi: `assert` mỗi mốc xuất hiện đúng một lần, chạy lần hai không đổi gì. Hook chặn ghi đè cả tệp. Nguồn: (16–23/10 · N0003, N0042, N0760, N0771, N1104, N1129, N1148)
- Đọc lại tệp ngay trước khi ghi; không ghi cả tệp từ bản đọc cũ (nhiều phiên cùng sửa). Nguồn: `docs/DOI_AGENT.md` trước 25/10; (10–23/10 · N0032, N0037)
- Giữ đúng kiểu xuống dòng đang có (CRLF / LF) của tệp; git lưu LF, trên đĩa có thể CRLF. Nguồn: `docs/PROJECT_MAP.md` mục 6 trước 25/10; (16–23/10 · N0003, N0042, N0760, N0771, N1104, N1129, N1148)
- Tìm bằng `str.find`, không regex trên cả tệp 2,5 MB (có thể treo). Script đổi CSS chỉ sửa bên trong `{…}`. Nguồn: như trên.
- Không heredoc cho Python có `\`; không để `\u0000` chưa thoát trong chuỗi ghi vào tệp (thành byte NUL thật). Giữ bởi: `cut_sample_core` (kiểm khối không có NUL). Nguồn: như trên.

## Cổng dùng chung

Dùng cổng có sẵn; danh sách đầy đủ ở `docs/PROJECT_MAP.md` mục 2.

- Lệnh in: mọi lệnh qua `PrintSkuQueue.enqueue` → RPC `print_enqueue`. Nguồn: `docs/CONTEXT_MAP.md` mục 3; (03/10, 25/10 · N0079, N1206)
- Combo → Normal: mọi luồng đưa SKU vào in / tra gặp Combo phải hỏi qua `SkuComboPicker.chooseNormal`; `sku_combo_links` không mở thẳng cho client. Nguồn: (30/09–12/10 · N0405, N0067, N0014)
- Danh mục SKU trên máy `window.PrintSkuCatalog`: Supabase luôn đúng, IndexedDB chỉ để hiện nhanh, không ghi ngược; ghi IndexedDB đọc–so–ghi trong một giao dịch. Nguồn: (18–19/10 · N1033, N1035, N1085, N1105)
- Cầu nối Extension: mọi helper `extensionRequest` hỏi `PrintSkuBridgeReady` (PING ≤ 1,8 s) trước; Reload Extension mà chưa F5 thì báo tải lại trang. Thêm helper phải tăng số đếm trong test. Giữ bởi: `bridge_ready`. Nguồn: (10/10, 15/10 · N0179, N0789)
- Phiên Admin `PrintSkuAdminAuth`: gia hạn khi 401 HOẶC 403 và khi JWT còn < 1 phút; lỗi mạng giữ phiên. Nguồn: (16/10 · N0895)
- Quyền ở giao diện (`PrintSkuAdminAccess`, ẩn nút) chỉ là cổng hiển thị; quyền thật kiểm ở máy chủ (`docs/chuan/DU_LIEU.md`). Nguồn: (17/10 · N0134–N0144, N0989)
- `window.HasakiSkuIt` {readSlip, buildItems, enqueue} đóng băng; module khác chỉ gọi qua cổng này. Nguồn: (17/10 · N0951, N0953, N0956)
- Hộp thoại, báo lỗi, âm báo, camera, xuất Excel: `WhDialog`, `PrintSkuNotice`, `PrintSkuScanCue`, `PrintSkuScanUI`, `AdminSyncUI.xlsxBlob` — luật dùng ở `docs/chuan/GIAO_DIEN.md`.

## Trạng thái trên máy

- Trạng thái chỉ để tiện (tab đang mở, công tắc, bàn phím ảo) nhớ theo máy bằng localStorage; dữ liệu nghiệp vụ nhiều người dùng chung lưu Supabase (`docs/chuan/DU_LIEU.md`). Nguồn: (25/10 · N1212)
- Hàng chờ khi mất mạng được giữ ở localStorage rồi gửi lại (vd. UID blocked đồng bộ 20 s). Nguồn: (20–21/10 · N1051, N1062, N1067)

## Quy ước đang dùng trong mã, chưa chốt thành luật

- Sự kiện giữa module đều tên `print-sku-<việc>` (25/10 có 8: `print-sku-admin-ready`, `print-sku-admin-logout`, `print-sku-access-denied`, `print-sku-device-activated`, `print-sku-names-updated`, `print-sku-uid-changed`, `print-sku-cut-tab`, `print-sku-cap-vai-plan`).
- Cổng mở cho module khác gán vào `window` bằng `Object.freeze({...})` (`HasakiSkuIt`, `PrintSkuAssistant`, `PrintSkuAssistantPl`).

## Chưa thống nhất (chờ chốt)

- Tên khoá localStorage chưa có quy ước chung (đang có `cap-vai-dot`, `location-queue-v1`, `tb-khoa`, `sr-tab-…`). Đề xuất khi chốt: `<module>-<việc>`, thêm `-v<n>` khi đổi cấu trúc.
