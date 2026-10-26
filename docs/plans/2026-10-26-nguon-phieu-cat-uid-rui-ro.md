# Nguồn phiếu ADJ / IT cho Cắt UID, Rủi ro lưu trữ, UID tạm (26/10/2026)

## Thiết kế

- **Yêu cầu:**
  - Cắt UID: "khi nguồn xuất là phiếu ADJ mới tính là xuất test; phiếu IT là luôn chuyển nội bộ, không phải xuất test; chỉnh lại dữ liệu để tránh hiểu lầm".
  - Rủi ro lưu trữ: "click vào SKU hiện pop-up nguồn sinh ra (ai transfer, phiếu IT hoặc phiếu ADJ)".
  - UID tạm: "click vào cũng hiện pop-up nguyên nhân phát sinh (phiếu IT hoặc phiếu ADJ)".
- **Kết quả nhìn thấy được:**
  - Đối chiếu ADJ: mỗi lần Cut có nhãn nguồn `ADJ · Xuất test` / `IT · Chuyển nội bộ` / `Chưa rõ`, kèm số phiếu người dùng thấy trên WMS (ADJ `1008…`, IT `1007…`).
  - Pop-up Cut: ADJ hiện thêm lý do và số PO của phiếu; IT hiện thêm kho nhận và mô tả mục đích của phiếu.
  - Cut từ IT không bị tính là lệch số lượng chuẩn 1 m và không vào nhóm Cắt mẫu QC.
  - UID tạm: bấm dòng mở pop-up phiếu gốc (loại, số phiếu, lý do, người, giờ, kho đến, các dòng cùng phiếu).
  - Hàng chưa lên kệ: bấm SKU mở pop-up gồm phiếu nhập kho gần nhất của SKU và UID đang nằm ở vị trí đó (ai chuyển vào, lúc nào).
- **Đã chốt với người dùng:** Cut chỉ là "xuất test" khi nguồn là phiếu ADJ; phiếu IT là chuyển nội bộ. Thay tiền đề "mọi Cut = ADJ" (N0344, N0345) trong `docs/QUYET_DINH.md` mục "Đối chiếu ADJ" — lead sửa dòng đó khi xong việc.
- **Chờ người dùng chốt (mặc định đã chọn, đổi được):**
  - Đ1: Cut không ghép được phiếu hiện nhãn `Chưa rõ`, vẫn đi qua luật đối chiếu cũ như trước, không gọi là xuất test.
  - Đ2: Pop-up Hàng chưa lên kệ mở khi bấm cả dòng kể cả ô SKU; nút sao chép SKU chuyển vào pop-up (hiện bấm SKU = sao chép).
  - Đ3: Người chuyển vào vị trí lấy trực tiếp từ màn WMS "Transfer Location History" trong lượt Rủi ro lưu trữ, không dùng bảng lịch sử chuyển đã lưu của LỊCH SỬ GROUP UID (cũ, không đủ SKU / số lượng).

## Số đo thật

Chi tiết kỹ thuật về WMS (endpoint, khoá dòng, mã chứng từ, số đo) CHỈ nằm ở `docs/local/KIEN_THUC_WMS_INSIDE.md` (trên máy, không trong git; người dùng chốt 26/10/2026). Agent đọc bằng đường dẫn tuyệt đối do lead đưa. Kết luận cần cho thiết kế:

- Dòng lịch sử Cut của WMS không mang số phiếu, loại phiếu hay lý do; dòng phiếu IT và ADJ không có Group UID. Chỉ ghép Cut với phiếu được bằng SKU + tổng số lượng + giờ.
- Ghép thử 30 ngày (26/10/2026): ghép được khoảng một nửa số lần Cut; phần lớn vào ADJ lý do "Xuất test" (trễ vài phút), phần còn lại vào IT (trễ vài phút tới vài ngày); gần một nửa chưa ghép được. Một phiếu ADJ gom nhiều Cut liền nhau; phiếu IT thường khớp một Cut.
- Khớp với màn người dùng chụp: Cut 1.000 mm nằm trong ADJ "Xuất test", các lần Cut lẻ còn lại khớp phiếu IT chuyển sang kho bán thành phẩm. Hiện app trộn cả hai vào một ô "WMS" và nhóm Cắt mẫu QC.
- UID tạm: tra được phiếu gốc từ báo cáo Import/Export đã đọc sẵn; có ba loại phiếu gốc (IT, ADJ, lệnh sản xuất), pop-up phải xử lý cả ba.
- Hàng chưa lên kệ: màn Transfer Location History của WMS cho biết ai chuyển vào vị trí, loại chuyển, giờ, số lượng theo SKU. Hàng ở một số vị trí ảo (tồn từ năm 2025) không có dòng chuyển vào, đến bằng phiếu: pop-up ghép thêm phiếu nhập từ báo cáo Import/Export và có nhánh "không có nguồn trong lịch sử đọc được".
- Mỗi lần Cut chuyển phần cắt sang một vị trí ảo, nên một phần hàng ở đó là mảnh cắt chờ phiếu IT / ADJ (liên quan việc 1).
- Đã thử file "Group UID theo IT" của WMS (26/10/2026): chỉ liệt kê cuộn nguyên được chuyển, không có mảnh cắt, nên không kiểm được việc ghép Cut ↔ IT bằng file này. Mảnh cắt nhỏ có thể xuất chung trong phiếu IT / ADJ lớn, do đó một phần Cut luôn ở `Chưa rõ` (Đ1) và cách ghép giữ ở mức "Cut 1 lần ↔ phiếu cùng số lượng, hoặc dãy Cut liền kề cộng đúng".
- Phiếu nhập kho (inbound shipment) và ASN không giúp Cắt UID và UID tạm; chỉ làm giàu pop-up Hàng chưa lên kệ cho vị trí nhận hàng PO / IT (trạng thái nhận, số PO, số phiếu IT, mục đích). Không bắt buộc ở đợt này.

## Hợp đồng dữ liệu (đề xuất)

- **Ghép Cut ↔ phiếu** (hàm thuần, chạy ở Extension và chép sang web như `cut-adj-core`): theo SKU, Cut sắp theo giờ; mỗi phiếu xuất ADJ / IT lấy dãy Cut liền kề có tổng bằng số lượng phiếu, Cut có giờ ≤ giờ phiếu + 2 phút và ≥ giờ phiếu − 14 ngày; hai loại phiếu cùng khớp một Cut → không gán (`Chưa rõ`).
- **Cột mới `wms_group_uid_cuts`:** `source_type` ('ADJ' | 'IT'), `source_code` (số phiếu `1007…` / `1008…`), `source_reason`, `source_at`, `source_note` (ADJ: số PO; IT: kho nhận + mô tả, cắt ngắn).
  - Dòng cũ để null = chưa rõ. Cut nạp từ Excel / ZIP không có nguồn.
  - Extension tra số phiếu và ghi chú từ mã trong báo cáo Import/Export (cách tra: tệp kiến thức cục bộ mục 3b, 3c); một lượt chỉ gọi thêm vài lời gọi chi tiết (số phiếu đã ghép).
- **RPC:** `wms_group_uid_cut_set_source(p_rows)` (Admin, chỉ ghi cột nguồn, không ghi đè nguồn có bằng null), `wms_group_uid_cut_unresolved(p_days)` (Admin, các Cut chưa có nguồn để thử ghép lại khi phiếu IT đến trễ); `cut_group_uid_reconcile` trả thêm nguồn trong `wmsCuts[]`.
- **UID tạm:** cột `uid_temp_rows.origin jsonb` = `{type, code, reason, by, at, from, to, lines[]}` do Extension dựng từ Import/Export đã đọc sẵn; `uid_temp_save` / `uid_temp_overview` thêm trường; khoá cache `uid_temp:v3` (+ `:admin`).
- **Hàng chưa lên kệ:** mỗi cặp SKU × vị trí lưu `sources[]` trong `sku_count_rows.locations[]` (jsonb) gồm hai loại:
  - (a) các lần chuyển vào đúng vị trí đó của đúng SKU từ màn WMS Transfer Location History (loại chuyển, số lượng, người, giờ, vị trí nguồn, mã Group UID nếu tra được);
  - (b) phiếu nhập kho gần nhất của SKU từ Import/Export (IT / ADJ + lý do / PO).
  - Cần một lệnh Extension mới chỉ đọc (tên, tham số, khoá dòng: `docs/local/KIEN_THUC_WMS_INSIDE.md` mục 2 và 5); không cần RPC mới nếu `sku_count_save_chunk` nhận khoá lạ.

## Rủi ro và cách chặn

- Ghép bằng suy luận có thể gán sai: mơ hồ thì để `Chưa rõ`; hiển thị chip "suy ra từ số lượng" ở pop-up; đo lại tỉ lệ sau khi lên thật.
- `cut_group_uid_reconcile` và `wms_group_uid_cut_import` bản mới nhất nằm ở `supabase/backend_hygiene_v1.sql` (che email, chặn `p_data_until` tương lai) — chép từ đó, không chép từ `cut_group_uid_po_v1.sql`. `uid_temp_overview` và `group_uid_moves_lookup` cũng vậy.
- Thêm cột phải sửa đủ `jsonb_to_recordset`, `insert`, `set` và điều kiện "chỉ cập nhật khi khác" trong hàm nhập Cut, nếu không dòng đã lưu không nhận nguồn.
- Extension cũ (cổng bản `min_extension` đang `{}`) gửi dòng không có nguồn: SQL không được ghi đè nguồn đã bù bằng null.
- "Tick giúp" (`_cut_group_uid_adj_from_wms_body`) hiện tick mọi Cut một lần: phải chỉ tick Cut nguồn ADJ, nếu không Cut IT bị coi là đã xuất ADJ.
- Hai bản mã phải khớp: `syncFromWms` (web) ↔ `cut-adj-core.js`; `storage-risk-temp-script` ↔ `storage-risk-core.js` (test cắt mã web ra chạy với WMS giả).
- Email người thao tác trong `origin.by` và nguồn Cut đi qua luật che email (N1185): người ngoài Admin chỉ thấy phần trước `@`.
- Hàm `SECURITY DEFINER` mới: `revoke execute … from public, anon, authenticated` rồi `grant` đúng vai; migration có dòng `-- kiem:` và khối `-- Rút lui`.
- Push `main` = web lên ngay: thứ tự migration → Reload Extension → push (luật cứng 4).

## Chưa kiểm được bằng máy

- Extension 0.12.0 đọc WMS thật trong lượt tự động và nút "Đọc WMS" tay; tỉ lệ ghép sau một lượt đọc lại.
- Pop-up trên dữ liệu thật (UID tạm 3 loại phiếu, Hàng chưa lên kệ có / không có phiếu nhập); điện thoại không xét cho Admin.
- Máy khác chưa Reload Extension: gửi dòng Cut không nguồn.

## Kế hoạch

Thứ tự chạy: việc 1 và việc 2 song song (hai worktree, tệp khác nhau) → việc 3 (lead) ghép, review, phát hành. Agent không commit, không chạy migration, không nâng phiên bản Extension (lead nâng một lần ở việc 3).

### Việc 1 — Cắt UID: nguồn phiếu từng lần Cut · `thuc-thi-logic` (Opus) · [ ]
- Tệp và neo:
  - `extension/inside-po-connector/cut-adj-core.js` → `const saved = await rpc("wms_group_uid_cut_import", {`
  - `index.html` → `<script id="cut-adj-reconcile">` (neo `const STATES={`, `syncFromWms`), `<style id="cut-adj-theme">`
  - `supabase/backend_hygiene_v1.sql` → `create or replace function public.cut_group_uid_reconcile(`
  - `supabase/floor_access_v1.sql` → `join public.wms_group_uid_cuts w on w.group_uid_code = c.group_uid_code and w.cut_at >= c.cut_at`
- [ ] 1.1 Hàm ghép `matchCutsToDocs` (tệp mới `cut-source-core.js`) + test đơn vị bằng dữ liệu giả (SKU `9000000xx`): 22 Cut = 1 ADJ, 1 Cut = 1 IT, mơ hồ → null, Cut sau phiếu → null, trễ 4 ngày vẫn ghép IT.
- [ ] 1.2 Đo lại bằng WMS thật (GET, tab đã đăng nhập): tỉ lệ ghép 30 ngày và lý do 49 % chưa ghép (mẫu 3 ca, không ghi mã thật); ghi số vào báo cáo cho lead.
- [ ] 1.3 Migration `supabase/cut_source_v1.sql`: 4 cột nguồn, `wms_group_uid_cut_import` + `cut_group_uid_reconcile` (chép từ `backend_hygiene_v1.sql`), `wms_group_uid_cut_set_source`, `wms_group_uid_cut_unresolved`, Tick giúp chỉ Cut ADJ; test SQL (đọc tệp, kiểm D8 + che email + không ghi đè null).
- [ ] 1.4 Extension: bước gán nguồn sau khi đọc Cut (Import/Export kho 1177 từ 14 ngày trước Cut chưa nguồn đến nay) trong `cut-adj-core.js` và `syncFromWms` (web) — hai bản khớp, test `cut_adj_core`.
- [ ] 1.5 Web: Cut nguồn IT = nhóm "Chuyển nội bộ" ngoài luật lệch ADJ và ngoài `qc`; cột WMS ở popup có chip nguồn + số phiếu; Excel thêm cột `Nguồn`, `Số phiếu`; sửa `STATES`, `cut-adj-theme`, `tests/contrast_states_browser.cjs`, `tests/cut_adj_reconcile_browser.cjs`.
- [ ] Test đỏ trước: `tests/cut_source_core.cjs` (mới) khẳng định ghép đúng 4 ca trên (lệnh `node tests/cut_source_core.cjs`, mong đợi PASS sau khi làm).
- Ngoài phạm vi: đọc Excel / ZIP có nguồn; đổi nhãn "Đã xuất ADJ" ở Tra cứu và popup barcode (đó là cờ riêng của app, vẫn đúng); nâng phiên bản Extension.

### Việc 2 — Rủi ro lưu trữ: pop-up nguồn (UID tạm + Hàng chưa lên kệ) · `thuc-thi-logic` (Opus) · [ ]
- Tệp và neo:
  - `extension/inside-po-connector/storage-risk-core.js` → `async function uidTemp() {`
  - `index.html` → `<script id="storage-risk-temp-script">` (neo `const isTempUid=`), `<script id="storage-risk-script">`, `<section class="cut-screen" id="storage-risk-screen"`
  - `supabase/uid_temp_snapshot_v1.sql`; `supabase/backend_hygiene_v1.sql` → `uid_temp_overview`, `group_uid_moves_lookup`
  - Khuôn pop-up: `#ia-dialog` (`inventory-audit-script`)
  - Lệnh Extension mới: `extension/inside-po-connector/wms-bridge.js` → `async function readMovesPage(payload) {` (mẫu), `background.js` → `WMS_READ_TYPES`, `app-bridge.js` (allow-list)
- [ ] 2.1 UID tạm: dựng `origin` từ Import/Export đã đọc (loại ADJ / IT / WORK_ORDER, lý do, người, giờ, kho đến, dòng cùng phiếu); migration `supabase/uid_temp_origin_v1.sql` (cột, `uid_temp_save`, `uid_temp_overview` giữ che email); khoá cache `uid_temp:v3`; sửa `storage-risk-core.js` và web khớp nhau.
- [ ] 2.2 Pop-up UID tạm: bấm dòng (Enter / Space cũng mở), khuôn `#ia-dialog`, nhánh 3 loại phiếu + "không tìm thấy phiếu gốc".
- [ ] 2.3 Hàng chưa lên kệ: lưu `sources` cho từng cặp SKU × vị trí.
  - Xác nhận `sku_count_save_chunk` nhận khoá lạ trong `locations[]`.
  - Lệnh Extension đọc Transfer Location History: sửa `app-bridge.js` (allow-list), `WMS_READ_TYPES` ở `background.js`, `wms-bridge.js`, README.
  - Mỗi cặp một lời gọi lọc theo vị trí đến và SKU (≤ 20 dòng, ≈ 20 cặp).
  - Tra mã Group UID từ mã nguồn của dòng chuyển bằng lịch sử Group UID cùng giờ (thử trước); không ra thì hiện "Group UID #id".
  - Lưu `sources` cùng phiếu nhập gần nhất; che email người theo N1185.
- [ ] 2.4 Pop-up Hàng chưa lên kệ: bấm dòng / SKU, nhãn loại chuyển bằng tiếng Việt (bảng loại chuyển ở tệp kiến thức cục bộ mục 5; trống = chuyển tay), nhánh "không có nguồn trong lịch sử đọc được", nút sao chép SKU trong pop-up; thẻ điện thoại không đổi (không thêm cột).
- [ ] Test đỏ trước: sửa `tests/storage_risk_temp_browser.cjs` (9 khoá → thêm `origin`) và thêm `tests/storage_risk_popup_browser.cjs` (bấm dòng mở pop-up, 3 loại phiếu, che email người ngoài Admin).
- Ngoài phạm vi: lọc ngày cho màn Transfer Location History (chưa biết tên tham số; cắt ở phía đọc); nhóm UID tạm theo mã ADJ và tick "đã xử lý" (N0904, vẫn "Làm sau"); nâng phiên bản Extension.

### Việc 3 — Ghép, review, phát hành · lead (Sonnet) + `kiem-thu` · [ ]
- [ ] Nâng Extension `0.12.0`: `manifest.json`, README, 17 dòng test ghim bản (danh sách ở `commit_gate` mục 5).
- [ ] `docs/PROJECT_MAP.md` (mục 2, 3, 4), `README.md`, `docs/QUYET_DINH.md` (thay dòng "ADJ = dòng Cut"), nhật ký `RULES.md` mã mới, sửa dòng lỗi thời PROJECT_MAP (`cut_group_uid_reconcile` mới nhất ở `backend_hygiene_v1`).
- [ ] `python scripts/run_tests.py` cả bộ, `python scripts/commit_gate.py`, `git diff --check`.
- [ ] Review: Codex + `/review-claude` song song, `co-van` gộp; tối đa 3 vòng.
- [ ] Phát hành theo thứ tự: commit (chưa push) → `python scripts/release.py --plan` → người dùng chạy 2 migration → Reload Extension + tải lại tab WMS → push → một lượt đọc lại để bù nguồn cho Cut cũ → đo tỉ lệ ghép thật.

## Phát sinh
- (trống)

## Lệch kế hoạch
- (trống)

## Nhật ký
- 26/10/2026 Dò WMS thật bằng DevTools: Cut không có số phiếu; ghép được 51 % bằng SKU + số lượng + giờ; UID tạm tra được phiếu gốc qua `source_mapping_id`. Chưa sửa mã.
- 26/10/2026 Người dùng duyệt chạy, giữ mặc định Đ1–Đ3. Lead (Sonnet) đã kiểm bằng Supabase MCP chỉ đọc: bản đang chạy của `cut_group_uid_reconcile`, `wms_group_uid_cut_import`, `uid_temp_overview` khớp `backend_hygiene_v1.sql` (che email, chặn mốc tương lai); `sku_count_save_chunk` chỉ kiểm `locations` là mảng nên `sources[]` không cần migration. Giao việc 1 và việc 2 cho `thuc-thi-logic` (Opus) trong hai worktree, đang chạy.
- 26/10/2026 Dò màn Transfer Location History: có loại chuyển + người + giờ theo SKU / vị trí. Dò thêm inbound shipment và ASN: không giúp Cắt UID / UID tạm. Việc 2.3 / 2.4 và Đ3 đã đổi theo. Kiến thức WMS ghi ở tệp cục bộ, không đưa lên git.
