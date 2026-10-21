# CẮT GROUP UID: lọc theo PO (2026-10-21)

## Thiết kế
- **Yêu cầu:** "Phần cắt group UID thêm chức năng lọc theo PO. lên kế hoạch" → "Bắt đầu build … làm từ Việc 0 dò WMS".
- **Hiện trạng (lead đọc mã 21/10):** tab 2 "Tra cứu UID đã cắt" lọc SKU / Lot / khoảng ngày cắt / ADJ (`#cut-search`, RPC `cut_group_uid_search` — bản trước `supabase/cut_group_uid_v5_adj_export.sql`); tab 4 "Đối chiếu ADJ" lọc SKU / Lot / ngày (`#cut-adj-form`, `cut_group_uid_reconcile` — bản trước `group_uid_qc_status_v1.sql`). Trước đợt này `cut_group_uids` và `group_uid_details` KHÔNG có PO; PO chỉ có ở phiên Lấy mẫu theo PO (`cut_sample_sessions.po`). WMS `group-uid-infos` có `processing_source_type` + `processing_source_code` (chỉ khi UID có nguồn).
- **Đã chốt với người dùng (AskUserQuestion 21/10/2026):**
  1. **Nguồn PO = lưu khi đồng bộ Group UID** (làm như RFID 20/10 — commit 5046aac): lúc quét cắt ghi luôn PO vào dòng đã cắt. Ai cũng lọc được, không cần WMS.
  2. **Tab:** 2 · Tra cứu và 4 · Đối chiếu ADJ (không tự điền Số PO ở tab 3).
  3. **Ô lọc** "Lọc theo PO…", **khớp đúng** số PO, bỏ khoảng trắng hai đầu.
  4. **Cột PO** trong bảng Tra cứu + Excel A4 (điện thoại: nhãn tự gắn từ tiêu đề cột). Tab 4 chỉ có ô lọc.
  5. **Sau Việc 0 (độ phủ ~44 % UID còn hàng MTG có PO): "Làm tiếp, chỉ số PO"** — chỉ lưu số PO khi nguồn là PURCHASE_ORDER; nguồn khác (kiểm kê, phiếu IT, tạo tay) để trống.
- **Lead tự quyết (đổi được):** `cut_group_uids.po` là bản chụp lúc quét (UID bị dọn khỏi `group_uid_details` vẫn còn PO); tra cứu dùng `coalesce(c.po, d.purchase_order)` ghép `group_uid_details` nên dòng cắt cũ có PO ngay sau lượt Toàn bộ, không cần backfill; cờ known theo khoá như `group_rfid_known` (Extension cũ không gửi khoá → giữ PO); PO không vào nhánh stale_source; không CHECK/UNIQUE (dữ liệu WMS lạ không làm hỏng lượt đồng bộ); không thêm index PO (lọc qua coalesce không dùng được — RULES 10/10 dọn index thừa).
- **Hợp đồng (bản cuối):**
  - Extension 0.10.4 `normalizeRow`: `purchase_order` = `processing_source_code` khi `processing_source_type` là PURCHASE_ORDER (không phân biệt hoa thường) và mã đúng `^[0-9]{6,40}$` (số JSON chỉ nhận khi là số nguyên an toàn); có loại nguồn khác → `null`; thiếu khoá loại nguồn, PURCHASE_ORDER mà mã trống / sai dạng / số không an toàn → bỏ khoá (Edge "không biết", giữ PO).
  - Edge `group-uid-sync`: có khoá + đúng dạng → giá trị; khoá null / rỗng → null (known); không khoá / sai dạng / `purchase_order_known: false` → không biết.
  - Migration `supabase/cut_group_uid_po_v1.sql` (chạy kèm `--allow-destructive` vì DROP hai chữ ký cũ, tạo lại trong cùng giao dịch): `group_uid_sync_staging.purchase_order` + `purchase_order_known`, `group_uid_details.purchase_order`, `cut_group_uids.po`; preview/apply chép từ `group_uid_rfid_v1.sql` thêm PO; `_cut_group_uid_scan_body` / `_cut_sample_confirm_body` chép từ `floor_access_v1.sql` ghi `po`; `cut_group_uid_search(…, p_limit, p_po)` và `cut_group_uid_reconcile(…, p_limit, p_po)` lọc khớp đúng, trả `po` mỗi dòng + `filterPo`.
  - Web: `#cut-po` (tab 2) và `#cut-adj-po` (tab 4) chỉ gửi `p_po` khi có (web mới chạy được trên hàm cũ khi ô trống); cột PO + Excel; màn Admin Đồng bộ Group UID hiện dòng "PO" khi PO đổi (bỏ qua khi `purchase_order_known === false`); đồng bộ tay dừng và nhắc Reload khi Extension chưa gửi khoá PO.
- **Thứ tự lên:** commit (chưa push) → `python scripts/apply_supabase_sql.py supabase/cut_group_uid_po_v1.sql --allow-destructive` → `python scripts/deploy_group_uid_sync.py` → Reload Extension 0.10.4 trên MỌI máy (cả máy chạy auto-sync) + tải lại tab WMS → push web → "Toàn bộ" ở Đồng bộ Group UID chạy TAY (lượt đầu ~4.000 dòng chỉ đổi PO, vượt ngưỡng tự động 3.000 nên lượt tự động sẽ bị giữ) → kiểm chỉ đọc số UID có PO, lọc vài PO ở tab 2/4.
- **Lead đã kiểm trước migration (chỉ đọc, Supabase MCP 21/10):** 6 hàm đang chạy (preview, apply, hai thân `_…_body`, search, reconcile) khớp md5 với tệp nguồn được chép → không có bản sửa ngoài repo.
- **Chưa kiểm được bằng máy:** migration trên Postgres thật, Extension thật trên tab WMS, lượt Toàn bộ thật, máy quét đọc mã PO.

## Kế hoạch
- [x] Việc 0 — Dò WMS (chỉ đọc) — số đo ở Nhật ký + RULES.md.
- [x] Việc 1a — Migration + Edge (thuc-thi-logic): `group_uid_sync_function.mjs` 14/14, `cut_group_uid_po_sql.cjs` (37/37 đột biến đỏ), `group_uid_rfid_sql`, `floor_access_sql`, `uid_block_auto_sql` PASS; dry-run 36 câu.
- [x] Việc 1b — Extension 0.10.4 (lead): `group_uid_sync_extension` đỏ → xanh; phiên bản ở manifest + 7 test + README Extension.
- [x] Việc 2 — Web (lead): `cut_group_uid_browser`, `cut_adj_reconcile_browser`, `group_uid_sync_admin_browser` đỏ → xanh; hàng lọc tab 4 tự xuống dòng (tràn 30 px ở 1024/1280).
- [x] Việc 3 — Review: Codex vòng 1 (2 nhóm nhỏ) + /review-claude A/B/C + Haiku chấm (G1 85 sửa; G2, G3, G7, G8 đã sửa trước khi chấm; G4 0 lỗi có sẵn; G5 35, G6 25 ghi nhận) + Codex vòng 2 (1 bỏ qua có lý do, 1 sửa README).
- [ ] Việc 4 — Cả bộ `run_tests.py` + `commit_gate.py`; PROJECT_MAP + README; commit (chưa push) → người dùng chạy migration → deploy Edge → Reload Extension → push → Toàn bộ → kiểm chỉ đọc.

## Phát sinh
- Màn Admin Đồng bộ Group UID cần nhãn "PO" trong danh sách trường đổi (agent nêu) — làm trong Việc 2.

## Lệch kế hoạch
- 21/10 Thiết kế rút xuống MỘT trường `purchase_order` (bỏ `source_code` / `source_type` / `source_known`) theo quyết định "chỉ số PO" sau Việc 0 — đã báo người dùng.
- 21/10 Bỏ hai index PO định tạo (review A + B: lọc coalesce không dùng được).

## Nhật ký
- 21/10/2026 Lập kế hoạch; người dùng chọn 4/4 khuyến nghị.
- 21/10/2026 Việc 0 — dò WMS (Chrome DevTools, chỉ đọc, đọc hết `group-uid-infos` theo kho): **MTG 1177 (9.861 UID):** PURCHASE_ORDER 3.611 (mã 14 chữ số), WMS_COUNTING_PLAN 2.198 (mã kế hoạch kiểm kê 6 số), INTERNAL_TRANSFER 242 (mã phiếu IT 14 số), không có nguồn 3.810 (New 1.583, Available 1.025, Canceled 877, Closed 291). Riêng Available MTG: PO 2.368 · kiểm kê 1.840 · không nguồn 1.025 · IT 203 → khoảng 44 % UID còn hàng có PO. **GARMENT 1339 (8.565):** PO 461, kiểm kê 3.363, IT 106, không nguồn 4.635 (New 4.185). Người dùng: "Làm tiếp, chỉ số PO".
- 21/10/2026 Review vòng 1: sửa Extension coi thiếu/rỗng loại nguồn hoặc mã PO trống / số không an toàn là "không biết" (bỏ khoá), so loại nguồn không phân biệt hoa thường; bỏ hai index PO; đổi mã kế hoạch kiểm kê thật trong test sang số giả; PROJECT_MAP + README + README Extension. G1 (Haiku 85): màn Đồng bộ Group UID dừng đồng bộ tay khi PING báo Extension < 0.10.4 ("Cần Extension 0.10.4 (đang v…): Reload Extension rồi tải lại tab WMS.") — test đỏ (chờ 30 s) → xanh; fake PING của group_uid_sync_admin / admin_web_sync đổi 0.4.2 → 0.10.4. Không làm: race runSearch / tab 4 load (lỗi có sẵn, Haiku 0); thông báo khi lọc PO ra 0 dòng, kiểm 6–40 chữ số ở ô (35); tách số dòng chỉ-đổi-PO trong thông báo held (25 — lượt Toàn bộ chạy tay không bị held, chỉ lượt tự động). Codex vòng 2: bỏ qua "Reload Extension mà quên tải lại tab WMS → bridge cũ trả dòng không PO" vì content script cũ mất kết nối sau Reload, sendToWms tự nạp lại tệp mới (lỗi lộ ra chứ không im lặng) và quy trình lên ghi tải lại tab WMS; sửa câu README Extension về trường hợp không nguồn.
