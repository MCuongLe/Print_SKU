# Trợ lý in → Packing List cấp vải (2026-10-24)

## Thiết kế
- **Yêu cầu:** "tôi muốn build trợ lý in thêm chức năng khi tôi gửi bất kỳ danh sách hình ảnh hoặc file đều có thể làm thành PL" → người dùng chọn "Làm đợt 1: đính kèm Excel/CSV + dán chữ có Group UID trong Trợ lý in → RPC tra UID → thẻ xem trước → Tạo đợt cấp vải mới / Tải PL. Ghi kế hoạch vào docs/plans."
- **Kết quả nhìn thấy được:** trong TRỢ LÝ IN, dán bảng WMS / gõ / kéo thả / đính kèm (.xlsx, .csv, .txt) danh sách Group UID → thẻ "Packing List cấp vải" (tên đợt / Style / PO gợi ý sẵn, từng cuộn có tick + cờ, tổng cuộn · mét) → **Tạo đợt** (đợt CẤP VẢI mới, nút Mở Cấp vải chọn sẵn đợt) hoặc **Tải PL** (.xlsx nhập lại được ở CẤP VẢI).
- **Đã chốt với người dùng:** chỉ Admin, ẩn ≤ 800 px như Trợ lý in; luôn có thẻ xem trước, người bấm mới tạo / tải; đợt 1 không dùng AI; tạo đợt MỚI (thêm vào đợt đang mở = đợt 3).
- **Nguồn:** một lần làm PL bổ sung bằng tay (7 cuộn, 1 lot, ~200 m) — tra Group UID, đổi mm → m theo đuôi tên SKU, xem cuộn đã thuộc đợt nào, xuất đúng khuôn CẤP VẢI; nay làm trong Trợ lý in.
- **Số đo thật:** phần SELECT của RPC chạy thử chỉ đọc trên DB thật 24/10/2026 (đúng cột, đúng 5 khoá trả về); vai `authenticated` có `statement_timeout = 8s` (`pg_roles`, 24/10/2026).
- **Hợp đồng dữ liệu:**
  - `fabric_issue_lookup_uids(p_codes text[])` → `{ok, data: {items: [{uid, sku, lot, roll, qty, warehouse, location, status, qcStatus, po}], missing: [uid], products: {sku: product_name}, inPlans: [{uid, planId, planName, planStatus, scannedAt}], openPlans: [{id, name, styleNo, poNo, createdAt, skus}]}}`; lỗi `FORBIDDEN` (không Admin), `INVALID_INPUT` (0 hoặc > 1.000 mã, mã không 10–40 chữ số).
  - `fabric_issue_import(p_plan)` có sẵn (ghép SKU + Lot + Roll; bắt buộc SKU và Roll, `lotNo` rỗng được); `fabric_issue_get(p_plan_id)` trả dòng qua `fabric_issue_lines_json` với khoá **camelCase** (`no`, `groupUid`, `state`, `note`, …); `fabric_issue_list()` trả 40 đợt mới nhất có `name`, `sourceName`, `createdAt`.
  - Trợ lý in gửi `sourceName = "Trợ lý in:<uuid>"` — mã thao tác riêng mỗi lần bấm Tạo đợt (cột `source_name`, không hiện trên giao diện).
- **Rủi ro và cách chặn:**
  - Số phiếu IT cũng 16 chữ số (tiền tố 1007) → chỉ nhận Group UID bắt đầu `1028`; ô câu lệnh có chữ IT/phiếu và dưới 2 UID thì dán như cũ, từ 2 UID là danh sách.
  - Excel ô kiểu số chỉ giữ 15 chữ số (UID sai chữ số cuối, có thể trúng cuộn khác) → ô số ≥ 10^15 và dạng `1.02826E+15` không bao giờ dùng làm UID, báo số ô.
  - Timeout / rớt mạng / phản hồi không đọc được khi tạo đợt (RULES §9) → "chưa rõ", khoá thẻ, chờ 20 giây (statement_timeout 8 giây + chờ kết nối pool ≤ 10 giây) rồi tìm đợt theo mã thao tác trong `fabric_issue_list`; thấy thì coi như đã tạo, không thấy mới cho gửi lại.
  - Cuộn thiếu SKU / Roll, mã vượt giới hạn, đơn vị không đổi được, số lượng 0 → khoá tick (import từ chối cả đợt); thiếu Lot → khoá thận trọng (import cho lot rỗng nhưng khi đó ghép bỏ điều kiện lot); không Available / đã thuộc đợt khác → bỏ tick mặc định.
  - Hai luồng (phiếu IT, Packing List) dùng chung cờ bận; mọi điểm vào kiểm cờ trước khi chạy; lúc bận thẻ phiếu IT khoá ô sửa (lô dở giữ khoá riêng).
- **Chưa kiểm được bằng máy:** tạo đợt thật trên Supabase; tệp Excel Group UID thật xuất từ WMS (cột UID là chữ hay số); danh sách lớn (vài trăm cuộn) so với `statement_timeout` 8 giây.

## Kế hoạch
Thứ tự chạy: Việc 1 → Việc 2 → Việc 3 (review) → Việc 4 (lên máy chủ: migration → push).

### Việc 1 — RPC tra Group UID · lead · [x]
- Tệp: `supabase/fabric_issue_lookup_v1.sql` (mới), `tests/fabric_issue_lookup_sql.cjs` (mới)
- [x] Test đỏ trước: `node tests/fabric_issue_lookup_sql.cjs` báo "Chưa có supabase/fabric_issue_lookup_v1.sql" → sau khi viết: PASS
- [x] Hàm chỉ đọc, SECURITY DEFINER, `search_path ''`, kiểm `group_uid_admin_allowed()` đầu tiên, 1–1.000 mã; thu hồi public/anon/authenticated, chỉ cấp authenticated
- [x] Phần SELECT chạy thử chỉ đọc trên DB thật (2 UID có, 1 mã giả vào `missing`, `openPlans` đúng)

### Việc 2 — Trợ lý in: đính kèm / dán / thẻ / Tạo đợt / Tải PL · lead · [x]
- Tệp và neo: `index.html` → `<button class="pa-mic" id="pa-mic" type="button"` (nút đính kèm + ô chọn tệp); `print-assistant-script` (cổng `window.PrintSkuAssistant`, nhánh đầu `submit()`, `setBusy` khoá thẻ IT + gọi `PrintSkuAssistantPl.paint()`, `paintChips`); khối mới `assistant-pl-style` / `assistant-pl-script`; `cap-vai-script` (sự kiện `print-sku-cap-vai-plan` → `S.pendingPlan`); `uid-block-script` `readWorkbook(bytes, opts)` (tuỳ chọn `numeric`, `skipHidden`, mặc định như cũ)
- [x] Test đỏ trước: `tests/assistant_pl_browser.cjs` báo "thiếu nút đính kèm" → PASS
- [x] Dán bảng WMS (bỏ trùng, giữ thứ tự), đính kèm .xlsx + .csv, gõ UID → thẻ; mm → m giữ 3 chữ số; cờ / khoá tick; gợi ý tên · Style · PO
- [x] Tạo đợt: payload `fabric_issue_import` đúng (mã thao tác), đọc lại `fabric_issue_get` (khoá `groupUid`) so UID, báo lệch; khoá thẻ; Mở Cấp vải chọn đúng đợt mới cả khi CẤP VẢI đã mở trước (ca đỏ trên bản không có bộ nghe)
- [x] Tải PL: tệp đọc lại được bằng bộ đọc Packing List của CẤP VẢI, giữ 29,001 m và Group UID dạng chữ
- [x] Bố cục hàng (tick | UID | mét cùng dòng — ca đỏ trên bản thiếu `grid-area: auto`), thẻ vừa khung ở 1280 × 900
- [x] Không Admin: nút đính kèm tắt, dán không gọi RPC
- Ngoài phạm vi: xem "Đợt sau"

### Việc 3 — Review · lead + Codex + Claude A/B/C + Fable · [x]
- [x] Vòng 1: Codex (mã + ảnh), Claude A/B/C + Haiku chấm, Fable lọc — sửa 7 nhóm (Nhật ký)
- [x] Vòng 2 (chỉ phần vừa sửa): Codex + Claude A/B/C, Fable lọc — sửa 4 nhóm (Nhật ký)
- [x] Cả bộ `python scripts/run_tests.py` + `python scripts/commit_gate.py` — 25/10 trên bản dựng HEAD 96c1257 + đợt này: 116/117 PASS (1114 s); `sku_po_reprint_browser` hỏng cả 2 lần NHƯNG hỏng y hệt trên HEAD không có đợt này (6dece2b đạt, 96c1257 commit chibi phiên khác làm hỏng) → không do đợt; commit_gate --cached ĐẠT (10 tệp).

### Việc 4 — Lên máy chủ · người dùng + lead · [ ]
- [ ] Commit (khi người dùng bảo)
- [ ] Chạy migration: `python scripts/apply_supabase_sql.py supabase/fabric_issue_lookup_v1.sql` (người dùng) — kiểm hàm có trên DB (chỉ đọc)
- [ ] Push main sau migration; kiểm trang thật

## Đợt sau (chưa làm)
- **Đợt 2 — ảnh / PDF (AI):** action mới của Edge `print-assistant` (giới hạn riêng: kích thước ảnh, lượt/ngày, nhật ký), Gemini mặc định / Anthropic nếu có khoá, khuôn JSON tìm Group UID (hoặc Lot/Roll/Qty khi không có UID); số liệu vẫn lấy lại từ Supabase; dòng chỉ có số AI đọc thì tô để soát. Deploy Edge → push.
- **Đợt 3:** thêm vào đợt đang mở thay vì tạo đợt mới (RPC ghi mới); câu lệnh tự do kiểu "tạo PL bổ sung cho <mã hàng>"; mở Trợ lý in trên điện thoại (hiện ẩn ≤ 800 px).
- **Làm sau từ review:** UID tận cùng 0 khi dán / CSV từ ô số Excel (luật "≥ 3 UID duy nhất và TẤT CẢ tận cùng 0 → dải vàng + bỏ tick"; `.xlsx` giữ `<v>` 16 số 1028… tận cùng ≠ 0 nếu tệp WMS thật ghi ô số — cần người dùng xem tệp thật); nút "Kiểm lại" khi chưa kiểm được trên máy chủ; báo số mã 16 số không đầu 1028 / sheet ẩn bị bỏ / cuộn bị khoá trên dòng tổng; nhãn "SKU chưa có tên sản phẩm"; chip "Packing List" ở trạng thái trống (hỏi người dùng); UID blocked / Trả NCC cùng lỗ ô số Excel (bộ đọc đã có tuỳ chọn `numeric`).

## Phát sinh
- 24/10 ~12:50 review vòng 1 → bộ đọc Excel dùng chung (khối `uid-block-script`) thêm tuỳ chọn `numeric` / `skipHidden`, mặc định như cũ → làm ngay trong đợt (test `uid_block_browser`, `vendor_return_browser` vẫn PASS); áp tuỳ chọn cho UID blocked / Trả NCC → để sau.
- 24/10 ~13:00 review vòng 1 → `cap-vai-script` thêm bộ nghe `print-sku-cap-vai-plan` (chọn đợt vừa tạo) → làm ngay trong đợt.
- 25/10 người dùng → `docs/CONTEXT_MAP.md` mục 3 thêm luồng Trợ lý in → Packing List cấp vải, mục 5 thêm luật khi nào cập nhật CONTEXT_MAP → gộp cùng đợt commit (người dùng chốt).
- 25/10 người dùng → `docs/DOI_AGENT.md` bước 1 thêm luật lấy mẫu phản hồi thật (chỉ đọc) của mọi RPC / WMS mà mã mới đọc rồi mới dựng test giả → gộp cùng đợt commit (người dùng chốt).

## Lệch kế hoạch
- (không có)

## Nhật ký
- 24/10 Việc 1 + 2 xong; test 7 ca + SQL PASS; 15 test liên quan PASS.
- 24/10 Review vòng 1: Codex mã 6 nhóm, Codex ảnh 8 góp ý, Claude A/B/C 18 nhóm (Haiku: 3 nhóm ≥ 80 — đọc sai khoá `groupUid` (cả A/B/C), dán số phiếu IT 16 số bị chặn, timeout khi tạo đợt trái RULES §9). Fable lọc: sửa 7 (khoá `groupUid` + fixture đúng hợp đồng, Group UID chỉ 1028…, ô số Excel / 1.02826E+15, cờ bận chung + báo bận, chưa rõ khi tạo đợt + gia hạn 401/403, khoá tick thiếu Lot/Roll, tài liệu) + gộp 3 việc nhỏ (mét 3 chữ số, hợp `skus` qua lô, CẤP VẢI chờ đợt khi bận) + 3 góp ý ảnh (hàng là label, dải cảnh báo, trạng thái Đã tạo). Sau sửa: `assistant_pl_browser` 11 ca PASS; 17 test liên quan PASS (kể cả `uid_block_browser`, `vendor_return_browser` cho bộ đọc dùng chung).
- 25/10 Review vòng 2: Codex 2 nhóm, Claude A 4, B 6, C 4 (bỏ bước Haiku vì hạn mức Sonnet chạm trần; Fable tự mở mã xác nhận). Fable lọc: sửa 4 — đối soát "chưa rõ" theo mã thao tác trong `sourceName` + chờ 20 giây tính từ lúc lỗi; `rpc()` coi 2xx thân hỏng và 5xx không `code` là "chưa rõ"; `setBusy` khoá ô sửa thẻ phiếu IT (trừ lô dở); 4 dòng tài liệu. Bỏ qua: số phiếu IT 1028 khi chờ (số phiếu IT thật tiền tố 1007), câu thông báo "giọng hướng dẫn" (cùng khuôn câu lỗi đã có). Làm sau: mục "Đợt sau". Sau sửa: `assistant_pl_browser` 14 ca PASS (ca mới: đợt cũ cùng tên không nhận nhầm, 200 thân rỗng, 504 JSON), `print_assistant_browser` PASS (ca mới: trợ lý bận khoá thẻ IT).
