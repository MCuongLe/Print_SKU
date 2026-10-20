# Lựa UID blocked (2026-10-20)

## Thiết kế
- **Yêu cầu:** "tôi cần build modul lựa UID blocked. Từ file nguồn này bạn build giúp tôi. Người dùng sử dụng máy scan nếu thuộc blocked thì báo người dùng biết." Tệp mẫu: `List_group_UID_kho_Material___MTG_2026.10.19_1.xlsx` (dữ liệu thật — KHÔNG vào git).
- **Đã chốt với người dùng (20/10/2026):** nguồn = **nạp tệp Excel** (không dùng trạng thái đồng bộ làm danh sách); **áp tất cả kho**; **đối chiếu lại** tệp với dữ liệu Group UID đã đồng bộ WMS; kết quả = **danh sách phiên quét trên máy** (đã lựa / còn thiếu, xuất Excel), không ghi lượt quét lên Supabase.
- **Lead tự quyết (người dùng chưa nói, đổi được):** (1) lấy mọi dòng có cột `Status` = `Blocked` (không phân biệt hoa thường), gộp mọi sheet, bỏ UID trùng; tệp không có cột Status → lấy mọi dòng có Group UID; (2) một danh sách đang dùng, lần nạp mới thay, giữ 5 lần nạp gần nhất; (3) chỉ Admin nạp, ai cũng quét (không cần khoá máy vì quét không ghi); (4) danh sách tải về máy một lần (cache kiểm phiên bản như Kiểm kê) → quét báo ngay, mất mạng vẫn báo.
- **Số đo thật (20/10/2026):** tệp mẫu sheet `blocked-QC fail` 719 dòng (Status đều Blocked, 16 SKU, kho WH - MATERIAL - MTG), sheet `2026-10-19` 9.789 dòng (bản xuất toàn kho, 9 trạng thái). Đối chiếu Supabase `group_uid_details`: 719/719 đang Blocked, 0 không có; Supabase còn 8 UID MTG Blocked ngoài tệp; GARMENT 24 Blocked; 164 UID MTG Available + qc_status Failed. `group_uid_lookup` (anon) KHÔNG trả status.
- **Kết quả nhìn thấy được:** ô trang chủ **LỰA UID BLOCKED** (nhóm Vận hành kho, `#uid-block`). Máy scan bắn mã vào khung quét chuẩn (có camera + gõ tay): UID trong danh sách → thẻ đỏ "BLOCKED" + SKU, tên, Lot/Roll, kho, vị trí + âm báo riêng + rung, ghi vào "Đã lựa"; UID không trong danh sách → thẻ xanh ngắn; quét trùng → báo "đã lựa lúc …". Thanh đầu: tên tệp, giờ nạp, tổng UID, đã lựa / còn thiếu. Tab: Đã lựa · Còn thiếu · Đối chiếu (theo trạng thái WMS hiện tại). Admin: nút Nạp Excel → xem trước (số UID theo kho + đối chiếu) → Lưu.
- **Hợp đồng dữ liệu (migration `supabase/uid_block_v1.sql`):**
  - Bảng `uid_block_lists` (id uuid, file_name, sheets jsonb, item_count, by_warehouse jsonb, imported_by, imported_at) và `uid_block_items` (list_id, group_uid_code, sku, product_name, lot, roll, warehouse, location, file_status) — chỉ service_role, RLS bật.
  - `uid_block_import(p_list jsonb, p_items jsonb)` — Admin (`group_uid_admin_allowed()`), kiểm kiểu từng trường, tối đa 20.000 dòng, Group UID 16 số, giữ 5 danh sách, trả `{listId, itemCount}`.
  - `uid_block_snapshot(p_known_list_id uuid)` — anon, khuôn `sku_count_snapshot` (trùng → `{unchanged:true}`, khác → `{list, items}`).
  - `uid_block_compare(p_codes text[])` — anon, đối chiếu với `group_uid_details`: mỗi mã trạng thái WMS + qc_status hiện tại; kèm danh sách UID đang Blocked trên WMS mà KHÔNG có trong `p_codes` (tối đa 500).
- **Rủi ro và cách chặn:** dữ liệu thật trong tệp → chỉ lưu Supabase, test dùng UID giả `1028260000000xxx`; tệp lớn (9.789 dòng) → đọc trên trình duyệt bằng `PrintSkuZip` có sẵn, chỉ gửi dòng Blocked; máy scan gửi kèm Enter / tiền tố → chuẩn hoá về 16 số; danh sách cũ trên máy → kiểm phiên bản mỗi lần vào màn.
- **Chưa kiểm được bằng máy:** máy scan thật (bàn phím giả), điện thoại thật, âm báo trên loa xưởng.

## Kế hoạch
Đội: `thuc-thi-logic` (Opus) làm migration song song trong worktree; lead làm web. Thứ tự: Việc 1 ∥ Việc 2 → Việc 3 → Việc 4.

### Việc 1 — Migration `uid_block_v1` · thuc-thi-logic · [x]
- [x] 2 bảng + 3 RPC như hợp đồng; khuôn `supabase/fabric_issue_v1.sql` (Admin nạp), `supabase/snapshot_cache_v1.sql` (snapshot), `supabase/uid_temp_snapshot_v1.sql` (kiểm kiểu, giữ N lượt)
- [x] Test đỏ trước `tests/uid_block_sql.cjs` (tĩnh) + `--dry-run`

### Việc 2 — Web: màn LỰA UID BLOCKED · lead · [x]
- [x] Ô trang chủ + route `#uid-block` + thanh bên (`app-nav-script`) + khối `uid-block-style` / `#uid-block-screen` / `uid-block-script`
- [x] Nạp Excel (Admin): đọc mọi sheet bằng `PrintSkuZip`, lọc Status Blocked, xem trước + đối chiếu (`uid_block_compare`), Lưu (`uid_block_import`)
- [x] Quét: khung quét chuẩn (`scan-field-std`, máy scan + gõ tay + camera `PrintSkuScanUI`), chuẩn hoá mã, kiểm danh sách trên máy (`PrintSkuSnapshotCache` khoá `uid_block`), thẻ đỏ/xanh + âm báo + rung
- [x] Phiên trên máy (`localStorage`): Đã lựa / Còn thiếu / Đối chiếu, xuất Excel (`UI.createList`), xoá phiên
- [x] Test `tests/uid_block_browser.cjs` (390 + 1280): nạp tệp giả, quét blocked / không blocked / trùng / mất mạng, đếm, xuất

### Việc 3 — Review · lead + Codex + `/review-claude` · [ ]
- [x] Codex ảnh 1 vòng (390 + 1280) — đã sửa điểm 4, 5, 7, 8; giữ chữ "ĐÃ SCAN" (lời người dùng); điểm 3 (bảng lặp cụm vị trí), 6 để sau
- [ ] Codex mã + reviewer A/B/C + Haiku chấm — B xong (sửa #root inert + chuẩn hoá mã > 16 số), C xong (6 nhóm chờ chấm/sửa), A + Codex mã đang chạy

### Việc 4 — Xác minh + lên · lead · [ ]
- [ ] `kiem-thu` cả bộ test + cổng + đối chiếu ô tích
- [ ] README, `docs/PROJECT_MAP.md`
- [ ] Commit (chưa push) → người dùng chạy migration → lead kiểm chỉ đọc → push → Admin nạp tệp thật
- [ ] Bảng "Đánh giá thành viên" (đợt 3 — xem lại đội sau đợt này)

## Phát sinh
- 20/10 người dùng (giữa việc 2): "cần gom theo vị trí để người dùng dễ tìm kiếm" → tab Còn thiếu gom UID theo vị trí (xếp theo mã vị trí, số cuộn mỗi vị trí) — làm ngay, cùng module.
- 20/10 người dùng: "group blocked đã scan thì ghi nhận lại, scan trùng thì báo đã scan" → đã có (phiên trên máy); đổi chữ thẻ thành "ĐÃ SCAN" + "Đã scan lúc …". Ghi nhận theo TỪNG MÁY (người dùng đã chọn "danh sách phiên trên máy"); nhiều máy cùng lựa cần lưu Supabase — đã báo người dùng, chờ trả lời.

## Lệch kế hoạch
- 20/10 người dùng bảo "commit và push" giữa Việc 3: commit ngay bản đang có (test đạt); push GIỮ LẠI tới khi chạy migration `uid_block_v1` (luật migration trước push). Lỗi review còn lại sửa ở commit sau, trước push.

## Nhật ký
- 20/10 Việc 1 (thuc-thi-logic, ~91k token, 6 phút): uid_block_sql PASS, 11/11 đột biến đỏ, dry-run 21 câu lệnh; tự thêm imported_at = clock_timestamp() sau khoá, ràng buộc bảng, index. Rủi ro: compare quét tuần tự group_uid_details (index status đã bỏ).
- 20/10 Việc 2: uid_block_browser PASS (390 + 1280: ô → màn, máy scan tiền tố, BLOCKED / ĐÃ SCAN / ngoài danh sách / mã sai, gom theo vị trí, phiên qua tải lại, mất mạng, danh sách mới → phiên mới, Admin nạp Excel 2 sheet + đối chiếu + Lưu, người thường không thấy Nạp). Khối cache chung thêm tuỳ chọn `arg` (tên tham số mã phiên bản). Test chung đạt: snapshot_cache*, storage_risk_temp, mobile_home, app_nav, group_banners, icon_standard, scan_field_standard, a11y_axe, admin_entry.
- 20/10 Soát ảnh 390: cả màn tràn ngang 419px (ub-content grid track min-content) — test cũ đo document.scrollWidth nên không bắt; sửa `grid-template-columns: minmax(0,1fr)`, test đo chính màn ở 3 tab; 4 tab ép một hàng trên điện thoại.
