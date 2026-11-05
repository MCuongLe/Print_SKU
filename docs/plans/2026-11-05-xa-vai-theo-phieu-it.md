# Xả vải theo phiếu IT (2026-11-05)

Trạng thái (05/11/2026): **ĐÃ BUILD + review vòng 1; CHƯA LÊN** (chờ migration → Reload Extension 0.12.6 → push). Người dùng chốt "Chốt, build".

## Thiết kế

- **Yêu cầu (05/11/2026):** "admin nhập phiếu IT load WMS sẽ được thông tin mã hàng và số lượng từng SKU"; thêm: "SL đã xuất và lấy thông tin group UID của phiếu này luôn".
- **Kết quả nhìn thấy được:**
  - `#xa-vai` thêm tab 4 **Phiếu IT**: ô số phiếu + nút Đọc WMS (chỉ Admin) → xem trước: mã hàng (sửa được), bảng SKU · Đã xuất · số UID · mét theo UID · chưa có UID → Lưu đợt.
  - Danh sách đợt (mọi người xem): mã hàng, số phiếu, mỗi SKU: UID đã đo / tổng UID, mét thực tế / mét đã xuất; mở xem từng UID và trạng thái.
  - Quét UID thuộc một đợt: thẻ pop-up có thêm dòng mã hàng · phiếu. UID ngoài đợt đo như cũ.
  - In A4: UID đã chọn cùng một mã hàng của đợt → khung Mã hàng điền sẵn mã đó.
- **Đã chốt với người dùng (05/11/2026):**
  - Đ1 · Số lượng = SL đã xuất (`delivered_quantity`), không phải SL yêu cầu.
  - Đ2 · Mã hàng tách từ ghi chú phiếu (chữ sau "mã"), Admin sửa được; không tách được thì để trống, Admin gõ.
  - Đ3 · Đợt xả theo IT lưu Supabase: quét UID tự gắn vào đợt theo Group UID, tiến độ từng SKU, In A4 tự lấy mã hàng của đợt.
  - Đ4 · Lấy luôn Group UID của phiếu.
- **Lead tự quyết (báo người dùng ở tin thiết kế):**
  - UID ngoài đợt vẫn đo được, không chặn (giữ chốt 04/11 "UID mọi SKU").
  - Đọc lại phiếu đã lưu: cập nhật đầu phiếu + dòng, THÊM UID mới, KHÔNG gỡ UID cũ (WMS chỉ trả UID mà IT là nguồn gần nhất; UID chuyển tiếp sẽ biến mất khỏi kết quả).
  - Phiếu chưa xuất (SL đã xuất = 0 mọi dòng, hoặc không có UID): vẫn xem trước được, không cho lưu.
  - Không sửa hàm có sẵn (`xa_vai_measure_*`, `xa_vai_print_enqueue`): liên kết UID ↔ đợt tính bằng join theo `group_uid_code`.
- **Số đo thật (05/11/2026, DevTools GET trên tab WMS + Supabase MCP chỉ đọc):**
  - Phiếu xả vải mẫu (4 SKU vải đơn vị mm, kho vật tư → kho bán thành phẩm, Closed): `description` "định mức xả vải mã <mã>", `mapping_id` 14 số.
  - `group-uid-infos?processing_source_code=<mapping_id>`: 57 UID; tổng `uid_quantity` theo SKU = `delivered_quantity` ở 3/4 SKU, SKU còn lại thiếu đúng 170.000 mm (nghi mảnh cắt không mang UID).
  - Dòng UID: `products[0].sku`, `uid_quantity`, `batch_code`, `roll_code`, `group_rfid_mapping`, `location_description`, `status_name`; `group_uid_code` là SỐ.
  - 3/3 UID mẫu đã có trong `group_uid_details` (kho bán thành phẩm, Available) → quét xả vải dùng được ngay.
- **Hợp đồng dữ liệu:**
  - Extension 0.12.6, lệnh `GET_XA_VAI_IT {number}` (chỉ GET, không phụ thuộc công ty của tab) → `{ number, id, mappingId, status, fromWarehouse, toWarehouse, description, createdAt, lines:[{ sku, name, unit, requestedQty, deliveredQty }], uids:[{ groupUid, sku, lot, roll, qty, rfid, status, location }], uidTotal, generatedAt }`. Lỗi: phiếu không có, phiếu quá 200 dòng, UID quá 3.000, WMS hết phiên.
  - Bảng `xa_vai_it_batches` (`it_number` PK, `it_id`, `mapping_id`, `item_code`, `description`, `it_status`, `from_warehouse`, `to_warehouse`, `it_created_at`, `lines` jsonb, `loaded_at`, `loaded_by`, `loaded_by_name`, `created_at`) và `xa_vai_it_uids` (`it_number` + `group_uid_code` PK, `sku`, `batch_code`, `roll_code`, `wms_qty`, `wms_mm`, `rfid`, `added_at`). RLS bật, không policy.
  - `xa_vai_it_save(p_batch jsonb)` — chỉ Admin (`print_admin_allowed()`, JWT), `authenticated`. Lỗi `FORBIDDEN`, `INVALID_INPUT`, `INVALID_ITEM_CODE`, `NOT_DELIVERED`. Trả `{ itNumber, created, uidsAdded, uidsTotal }`.
  - `xa_vai_it_list(p_limit)` — anon: đợt mới nhất trước, mỗi dòng SKU kèm `uidCount`, `uidMm`, `measuredCount`, `actualMm`, `systemMm` (mm từ `xa_vai_system_mm`).
  - `xa_vai_it_get(p_it_number)` — anon: đợt + UID kèm `state` (`new`/`pending`/`printing`/`printed`), `actualMm`, `printedItemCode`.
  - `xa_vai_it_of_uids(p_uids text[])` — anon, ≤ 500 UID: `{ items:[{ groupUid, itNumber, itemCode }] }` (UID ở nhiều đợt → đợt mà UID được thêm vào gần nhất, theo `added_at`).
- **Rủi ro và cách chặn:**
  - Extension cũ im lặng với lệnh lạ → web hỏi `PING_WMS`, phiên bản < 0.12.6 báo "Reload Extension".
  - UID chuyển tiếp trước khi Admin nạp → mất khỏi kết quả WMS; màn hiện "chưa có UID" theo SKU để thấy.
  - Nhiều phiên sửa `index.html` (cây làm việc đang có phần Đối chiếu phủ lot của phiên khác): commit chỉ hunk của đợt này; `tests/bridge_ready.cjs` đếm helper.
- **Chưa kiểm được bằng máy:** Extension thật đọc phiếu thật (sau Reload), nạp đợt bằng Admin thật, quét UID thật trên Honeywell.

## Kế hoạch
Thứ tự: Việc 1 → Việc 2 → Việc 3 → Việc 4 (review) → Việc 5 (lên).

### Việc 1 — SQL `supabase/xa_vai_it_v1.sql` · lead · [x]
- [x] Hai bảng + 4 RPC, quyền đúng vai, dòng `-- kiem:`, khối Rút lui (commit 26cb1d0)
- [x] Test tĩnh `tests/xa_vai_it_sql.cjs` PASS + `apply_supabase_sql.py --dry-run` tới cuối

### Việc 2 — Extension 0.12.6 `GET_XA_VAI_IT` · lead · [x]
- [x] `group-uid-sync-core.js` `normalizeXaVaiIt`; `wms-bridge.js` `readXaVaiIt`; allow-list `app-bridge.js`, `background.js`, `wms-bridge.js` (26cb1d0)
- [x] manifest + README + test `tests/xa_vai_it_core.cjs` PASS; số phiên bản giả lập 0.12.6 ở 15 test (cổng commit đòi), chạy lại 15/15 PASS

### Việc 3 — Web tab Phiếu IT · lead · [x]
- [x] Tab 4, xem trước + Lưu đợt (Admin), danh sách đợt + UID (26cb1d0)
- [x] Pop-up quét có mã hàng của đợt; In A4 điền sẵn mã hàng của đợt
- [x] `tests/xa_vai_it_browser.cjs` (1280 + 375) PASS; `xa_vai_a4_browser` PASS (sửa kỳ vọng 4 tab); bộ chuẩn UI 11/11 PASS

### Việc 4 — Review · [x]
- [x] Codex mã (5 nhóm) + Codex ảnh (8 ý) + Claude A (5) + BC (8); co-van gộp 12 vấn đề, không cần người dùng quyết; sửa ở commit sau review (mục Nhật ký)

### Việc 5 — Lên · [ ]
- [ ] commit (chưa push) → migration → ghi sổ → người dùng Reload Extension → push
- [ ] `docs/QUYET_DINH.md`, `docs/PROJECT_MAP.md`, `README.md`, `RULES.md`

## Đợt 2: UID ngoài phiếu (05/11/2026, người dùng "Chốt, build")
- Chốt: cùng SKU với đợt đang xả mà không có trong danh sách → tự gắn vào đợt (nhãn "ngoài phiếu", tính tiến độ, nhiều đợt thì chọn) + báo vận hành kho; khác SKU → pop-up cảnh báo, KHÔNG lưu, báo vận hành kho; Admin đóng đợt; báo cáo = danh sách trong app. Lead tự quyết (người dùng xác nhận): chỉ chặn khi có ít nhất một đợt mở.
- Hợp đồng: `xa_vai_it_check(p_group_uid)` → `{ groupUid, sku, state: in_batch | same_sku | other_sku | free, batches?, openItems? }`; `xa_vai_it_attach(p_access_token, p_group_uid, p_it_number)` (lỗi `BATCH_DONE`, `SKU_NOT_IN_BATCH`, `NOT_FOUND`); `xa_vai_it_report(p_access_token, p_group_uid)` (máy chủ xét lại, chỉ ghi khi other_sku); `xa_vai_it_set_status(p_it_number, 'open' | 'done')` (Admin); `xa_vai_it_outside(p_limit)` → `{ attached, outside, attachedTotal, outsideTotal }`; `xa_vai_measure_save` trả `OUTSIDE_BATCH` cho UID mới khác SKU khi có đợt mở; UID mới cùng SKU chưa gắn → máy chủ tự gắn khi một đợt khớp, `NEED_BATCH` (kèm `batches`) khi nhiều đợt. Gắn: một UID một đợt (khoá theo Group UID; đã ở đợt khác → `ALREADY_IN_BATCH` kèm đợt đó, web lưu theo đợt đó). Nạp phiếu: UID WMS trả cho phiếu đang nạp mà đang gắn 'scan' ở đợt khác → gỡ khỏi đợt khác (chờ người dùng xác nhận trước migration).
- [x] SQL `supabase/xa_vai_it_v2.sql` + `tests/xa_vai_it_v2_sql.cjs` PASS (phần lưu mét = bản đang chạy, so `pg_get_functiondef` 05/11 + chặn)
- [x] Web: pop-up "Ngoài phiếu" + ô chọn đợt, gắn TRƯỚC khi lưu; pop-up "Ngoài đợt xả" không ô mét, phím của lượt quét kế đóng pop-up và vào ô quét; mục Ngoài phiếu + Excel; trạng thái đợt + Đóng đợt / Mở lại (Admin)
- [x] `tests/xa_vai_it_browser.cjs` mục 6 (1280 + 375) PASS; sửa race đăng nhập trong test (hộp xoá trống ô sau khi mở)
- [x] Review vòng 1 (Codex mã 5 + ảnh 6, Claude A 4 + BC 8; co-van 14 vấn đề): sửa — máy chủ ép gắn cùng SKU (75, [cả hai]), một UID một đợt + gỡ 'scan' khi nạp phiếu (60, [cả hai]), báo vận hành kho chỉ nói đã báo khi xong + lỗi luôn hiện, OUTSIDE_BATCH chuyển pop-up chặn (60), lỗi gắn BATCH_DONE tra lại, giữ phiếu đã chọn khi tra lại, mục Bất thường + "Hiện n / N" + Excel 2.000 dòng, icon nút đợt, QUYET_DINH dòng mâu thuẫn; bỏ qua: phân loại-ghi không nguyên tử (20), gắn rồi lưu lỗi (20, tự lành), đợt v1 thành mở (0 dòng). Làm sau: outbox bền cho báo cáo, timeout riêng cho check, race hộp đăng nhập Admin chung.
- [ ] Commit, migration `xa_vai_it_v2`, push

## Phát sinh
- 05/11/2026 Tách hunk: cây làm việc có phần "Đối chiếu phủ lot theo PO" của phiên khác (`index.html`, `docs/QUYET_DINH.md`, `tests/bridge_ready.cjs` + tệp chưa theo dõi) → commit chỉ phần của đợt này; `bridge_ready` phần commit 11, cây làm việc 12; `tests/cut_po_coverage_browser.cjs` (chưa theo dõi) đã đổi số phiên bản giả lập 0.12.5 → 0.12.6 để cổng commit đạt.

## Lệch kế hoạch

## Nhật ký
- 2026-11-05 Dò WMS + Supabase (số đo ở trên); người dùng chốt Đ1–Đ4.
- 2026-11-05 Review vòng 1 (co-van chấm): SỬA — đợt của UID theo `added_at` (60), nạp lại giữ mã hàng đã lưu (65), In A4 khoá + kiểm lại lựa chọn sau khi tra đợt, chờ 2,5 s (55, [cả hai]), gộp SKU trùng ở Extension + câu lỗi SQL riêng (50, [cả hai]), kiểm mã UID duy nhất = tổng WMS / trang lặp / WMS bỏ lọc / dòng phiếu bị cắt + web báo UID bị bỏ (35, [cả hai]), badge = tổng máy chủ + "Hiện n / N" + giới hạn 50 (45), gom tiến độ một lần theo SKU, tổng chỉ tính SKU trong phiếu (25–40), nhãn tổng theo số đã in (40), thoát Admin bỏ bản nháp (35). Ảnh: SỬA % cạnh thanh, "Có UID", Ghi chú cả hàng; BỎ QUA thanh nút dính đáy điện thoại (xem trước là thao tác Admin, chỉ xét máy tính), màu "Chưa nhập" (kiểu có sẵn của pop-up, chốt 04/11), nhãn ô số phiếu (placeholder đủ, không thêm chữ), tách hai tầng đầu thẻ, màu dòng báo.
