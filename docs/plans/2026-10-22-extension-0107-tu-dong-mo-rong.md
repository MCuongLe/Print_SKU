# Extension 0.10.7 — sửa soát 22/10 + cảnh báo tự động ngừng + tự động Cắt ADJ và Rủi ro lưu trữ

Trạng thái: ĐÃ CHỐT + ĐÃ LÀM (22/10/2026; review vòng 1 Codex + Claude + Fable đã sửa). Nguồn: soát Extension 0.10.6 (Codex + Claude A/B/C + Fable, mục RULES.md 22/10).

## Phần 1 — Sửa 5 lỗi đã chốt (chỉ Extension)
- [ ] G1 `inside-bridge.js` lượt toàn bộ SKU: ghi mốc trước khi đọc (lùi 15 phút phòng lệch giờ), đọc xong 7 nhóm thì đọc lại phần đổi từ mốc (`fetchChangedProducts`) và gộp → SKU sửa giữa lượt không bị thiếu, không bị lưu trữ nhầm. Áp cho cả lượt tay trên web (cùng lệnh). Test đỏ trước: trang giả dịch 1 SKU lên đầu giữa hai lô.
- [ ] G13 `group-uid-sync-core.js` `normalizePage`: không nhận ra khoá danh sách → ném "WMS đổi dạng dữ liệu Group UID" (204 giả `{count:0, records:[]}` vẫn qua). Test đỏ trước.
- [ ] G4 `background.js` + `auto-sync.js`: chọn tab WMS/Inside một lần đầu lượt, ghim cho cả lượt; bỏ tab bị Chrome cho ngủ (discarded) / đang tải; tab ghim lỗi mới tìm tab khác.
- [ ] G5 `auto-sync.js` `runNow`: giữ chỗ `running` trước mọi `await` (hết chạy chồng với lượt theo lịch).
- [ ] G2 bản rẻ: ghi `auto.active = {kind, runId, holder, startedAt}` khi bắt đầu, xoá khi xong; worker khởi động lại thấy còn → huỷ lượt Group UID dở, nhả khoá, tắt alarm giữ thức, ghi nhật ký "Lượt bị gián đoạn". `edge()` hết giờ 60 giây (ingest 120).

## Phần 2 — Cảnh báo khi đồng bộ tự động ngừng
- [ ] Extension: dấu đỏ "!" trên icon Extension (thêm khoá `action` vào manifest, không thêm quyền) khi: chưa đăng nhập Admin / phiên hết, chưa đặt tên máy, hoặc lượt OK gần nhất của một loại cũ hơn ngưỡng; bấm icon mở trang Tùy chọn. Trang Tùy chọn có dòng lý do (thẻ đỏ).
- [ ] Nhật ký ghi lý do dừng (chưa đăng nhập, phiên hết, chưa đặt tên máy, máy tắt) — gộp dòng lặp như hiện nay; lỗi bất ngờ trong `tick` ghi "Lỗi" thay vì nuốt. Lỗi mạng WMS / mất quyền 403 ghi "Lỗi", không còn "Bỏ qua" (mã lỗi riêng thay so câu chữ).
- [ ] Web (Admin): ô Tự động ở Đồng bộ SKU / Đồng bộ Group UID chuyển đỏ "Ngừng · N giờ" khi Tự động đang bật mà không có lượt tự động nào (mọi máy) quá **2 nhịp + 10 phút** (70 phút với nhịp 30). Hai màn mới (Phần 3) đỏ theo tuổi dữ liệu.
- Đổi quyết định 17/10 "thiếu tab → bỏ qua lặng lẽ, không cảnh báo" (người dùng chốt 22/10).

## Phần 3 — Tự động thêm 2 loại trong cùng nhịp alarm
### 3a. Cắt Group UID · Đối chiếu ADJ (lịch sử Cut kho WH - MATERIAL - MTG)
- Hiện: Admin bấm Đọc WMS ở tab 4 → `GET_GROUP_UID_HISTORY_PAGE` từ mốc phủ − 30 phút → `wms_group_uid_cut_import` (RPC kiểm Admin).
- Tự động: mỗi nhịp (30 phút) đọc gia tăng như nút web, nạp bằng phiên Admin của Extension; tên lượt `WMS_AUTO_<máy>_<giờ>.json`. Lỗi/đọc lệch → dừng như web, không nạp phần dở.
- Cần hàm đọc mốc phủ nhẹ `wms_cut_coverage()` (Admin) thay vì gọi cả `cut_group_uid_reconcile`.

### 3b. Rủi ro lưu trữ (Hàng chưa lên kệ = Kiểm kê 2 kho + UID tạm)
- Hiện: Admin bấm `sr-run` → đọc Kiểm kê (`GET_SKU_COUNT_*` → `sku_count_save_start/chunk/finish`) rồi UID tạm (`GET_STOCK_IMPORT_EXPORT_PAGE` → `uid_temp_save`), ~1–2 phút.
- Tự động: **mỗi 2 giờ trong 07:00–19:00 giờ VN** (khuyến nghị). Chép luồng đọc + dựng dòng của web sang tệp core dùng chung trong Extension (`storage-risk-core.js`), có test so kết quả với bản web trên cùng dữ liệu giả.

### Chung cho 3a/3b
- Khoá thuê + giãn cách như SKU/Group UID: thêm loại `cut_adj`, `storage_risk` vào `sync_auto_leases` (migration).
- Admin tạm dừng/tiếp tục: dùng chung công tắc Tự động hiện có (một công tắc cho cả 4 loại).
- Trang Tùy chọn: thêm 2 dòng "Lượt gần nhất" + nút Chạy ngay cho 2 loại.

## Migration + deploy (thứ tự lên)
1. `supabase/sync_auto_v2.sql`: mở rộng check `kind` và `sync_auto_lease/release` cho 4 loại; thêm `wms_cut_coverage()`. (Người dùng chạy `python scripts/apply_supabase_sql.py supabase/sync_auto_v2.sql --allow-destructive` — có `ALTER TABLE … DROP CONSTRAINT`, chỉ thay check `kind`.)
2. Deploy Edge `sku-sync` (lease/release nhận 4 loại; `auto-config` trả `lastFinishedAt` theo loại). (`python scripts/deploy_sku_sync.py`)
3. Commit (chưa push) → người dùng Reload Extension 0.10.7 + tải lại tab Inside/WMS → push web.

## Kiểm
- Test đỏ trước cho G1, G13, G5, G2; test `auto_sync_core.cjs` cho cảnh báo, 2 loại mới, khoá thuê; test trình duyệt cho ô Tự động đỏ; `tests/sync_auto_sql.cjs` (hoặc test SQL tương đương) cho migration.
- Review: Codex + /review-claude + Fable một vòng; ảnh 1280 ô đỏ cho Codex `--images`.
- Cả bộ `python scripts/run_tests.py` + `commit_gate.py`.
- Còn lại cho người dùng: chạy migration, deploy Edge, Reload Extension; theo dõi lượt tự động thật 1 ngày (đặc biệt lượt Rủi ro lưu trữ đầu tiên và lượt toàn bộ SKU đêm).
