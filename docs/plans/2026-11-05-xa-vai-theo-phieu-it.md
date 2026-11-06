# Xả vải theo phiếu IT (2026-11-05)

Trạng thái (05/11/2026): **ĐÃ LÊN đợt 1 + đợt 2** (migration `xa_vai_it_v1`, `xa_vai_it_v2`; Extension 0.12.6; web `ac73fd8`). Chưa thử với đợt thật / Honeywell. Người dùng chốt "Chốt, build".

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

### Việc 5 — Lên · [x]
- [x] commit (chưa push) → migration → ghi sổ → người dùng Reload Extension → push (`ab1cccd`, 05/11)
- [ ] `docs/QUYET_DINH.md`, `docs/PROJECT_MAP.md`, `README.md`, `RULES.md`

## Đợt 2: UID ngoài phiếu (05/11/2026, người dùng "Chốt, build")
- Chốt: cùng SKU với đợt đang xả mà không có trong danh sách → tự gắn vào đợt (nhãn "ngoài phiếu", tính tiến độ, nhiều đợt thì chọn) + báo vận hành kho; khác SKU → pop-up cảnh báo, KHÔNG lưu, báo vận hành kho; Admin đóng đợt; báo cáo = danh sách trong app. Lead tự quyết (người dùng xác nhận): chỉ chặn khi có ít nhất một đợt mở.
- Hợp đồng: `xa_vai_it_check(p_group_uid)` → `{ groupUid, sku, state: in_batch | same_sku | other_sku | free, batches?, openItems? }`; `xa_vai_it_attach(p_access_token, p_group_uid, p_it_number)` (lỗi `BATCH_DONE`, `SKU_NOT_IN_BATCH`, `NOT_FOUND`); `xa_vai_it_report(p_access_token, p_group_uid)` (máy chủ xét lại, chỉ ghi khi other_sku); `xa_vai_it_set_status(p_it_number, 'open' | 'done')` (Admin); `xa_vai_it_outside(p_limit)` → `{ attached, outside, attachedTotal, outsideTotal }`; `xa_vai_measure_save` trả `OUTSIDE_BATCH` cho UID mới khác SKU khi có đợt mở; UID mới cùng SKU chưa gắn → máy chủ tự gắn khi một đợt khớp, `NEED_BATCH` (kèm `batches`) khi nhiều đợt. Gắn: một UID một đợt (khoá theo Group UID; đã ở đợt khác → `ALREADY_IN_BATCH` kèm đợt đó, web lưu theo đợt đó). Nạp phiếu: UID WMS trả cho phiếu đang nạp mà đang gắn 'scan' ở đợt khác → gỡ khỏi đợt khác (chờ người dùng xác nhận trước migration).
- [x] SQL `supabase/xa_vai_it_v2.sql` + `tests/xa_vai_it_v2_sql.cjs` PASS (phần lưu mét = bản đang chạy, so `pg_get_functiondef` 05/11 + chặn)
- [x] Web: pop-up "Ngoài phiếu" + ô chọn đợt, gắn TRƯỚC khi lưu; pop-up "Ngoài đợt xả" không ô mét, phím của lượt quét kế đóng pop-up và vào ô quét; mục Ngoài phiếu + Excel; trạng thái đợt + Đóng đợt / Mở lại (Admin)
- [x] `tests/xa_vai_it_browser.cjs` mục 6 (1280 + 375) PASS; sửa race đăng nhập trong test (hộp xoá trống ô sau khi mở)
- [x] Review vòng 1 (Codex mã 5 + ảnh 6, Claude A 4 + BC 8; co-van 14 vấn đề): sửa — máy chủ ép gắn cùng SKU (75, [cả hai]), một UID một đợt + gỡ 'scan' khi nạp phiếu (60, [cả hai]), báo vận hành kho chỉ nói đã báo khi xong + lỗi luôn hiện, OUTSIDE_BATCH chuyển pop-up chặn (60), lỗi gắn BATCH_DONE tra lại, giữ phiếu đã chọn khi tra lại, mục Bất thường + "Hiện n / N" + Excel 2.000 dòng, icon nút đợt, QUYET_DINH dòng mâu thuẫn; bỏ qua: phân loại-ghi không nguyên tử (20), gắn rồi lưu lỗi (20, tự lành), đợt v1 thành mở (0 dòng). Làm sau: outbox bền cho báo cáo, timeout riêng cho check, race hộp đăng nhập Admin chung.
- [x] Commit, migration `xa_vai_it_v2` (~12:55, kiểm `-- kiem:` true), push `ac73fd8`; người dùng chốt "Chuyển" cho UID WMS trả về phiếu mới. Web đợt 2 lên sớm ~7 phút do phiên khác push commit chồng lên (commit đó sau đã gỡ khỏi lịch sử; SHA đợt 2 đổi b169ad6 → ac73fd8, 3990226 → 0caff0f), không hại dữ liệu (0 đợt).

## Đợt 3: phiếu A4 đơn vị gốc (05/11/2026)
- Yêu cầu: "Phần in A4 tôi cần 1 dòng phiếu IT dạng barcode. các group UID thì nhóm lại theo SKU. thêm cột mã vải và màu" + "Giao diện web thì vẫn giữ như cũ hệ mét … phần in A4 thì cần chuyển về đơn vị gốc". Chốt (khuyến nghị cả 4): mỗi phiếu IT một barcode; mã vải nguyên trường 2; đơn vị gốc cho phiếu A4 + Excel; nhóm SKU có tiêu đề + cộng nhóm.
- Số đo (Supabase 05/11): 672 SKU vải có UID, 669 tên ≥ 4 trường; SKU g 200, đổi được 165 (35 vải bo / rib không ghi GSM). Hàm `_xa_vai_print_enqueue_body`, `_xa_vai_item_json` đang chạy = `xa_vai_a4_v1.sql`.
- Thiết kế: cùng lệnh v1, chỉ thêm trường (agent cũ in mẫu cũ) → không đổi capability / claim, không cần cài agent trước migration.
- [x] SQL `supabase/xa_vai_a4_v2.sql` + `tests/xa_vai_a4_v2_sql.cjs` PASS
- [x] Agent 0.12.0 (mẫu mới, validator, phiên bản) + `workstation-agent/tests/xa-vai-sheet-0120.test.mjs`; `node --test` 242/242
- [x] Web: Excel đơn vị gốc + Mã vải / Màu; `xa_vai_a4_browser` PASS
- [x] Review vòng 1 (Codex mã 4 + ảnh 7, Claude A 4 + BC 6; co-van 15 vấn đề): sửa chia trang (biên 18 / 36 cuộn, trang 1 bị bóp; fuzz 60.000 tổ hợp sạch), ghi chú thiếu số ở Cộng / TỔNG, TỔNG khác đơn vị, số lẻ cho kg / yard, barcode 110 px, tách tên (bỏ %, tên 3 trường, trim), giữ mm khi tên SKU đổi sau lúc đo, itNumbers một phiếu mỗi UID, Excel thêm Thực tế (mm), tài liệu; KHÔNG đổi xa_vai_it_save (co-van: vượt chốt, nạp lại phiếu cũ giành UID). Làm sau: nhóm theo sku + unit, hiện phiên bản agent trên web.
- [x] Commit, migration, push, build gói 0.12.0, người dùng cài trên DESKTOP-foq5t89 + in thử (tờ in thật 05/11 16:27: barcode, nhóm SKU, số đúng)

## Đợt 4: barcode mép trên + ô Người xả (05/11/2026)
- Yêu cầu (sau tờ in thử 0.12.0): "Mã phiếu IT cần chuyển lên giữa đầu trang tận dụng mép giấy. Bỏ phần người kiểm tra. Người xả lấy tên thiết bị gửi lệnh in."
- Thiết kế: barcode ở lề trên + dòng tiêu đề nhỏ, giữa trang; không vừa (≥ 2 phiếu IT) → dải dưới biển như 0.12.0. Một ô "Người xả" = `print_devices.name` của máy gửi lệnh (in lại: máy gửi lệnh in lại). Cùng lệnh v1, chỉ thêm `deviceName`.
- [x] SQL `supabase/xa_vai_a4_v3.sql` + `tests/xa_vai_a4_v3_sql.cjs` PASS
- [x] Agent 0.12.1 + `workstation-agent/tests/xa-vai-sheet-0121.test.mjs`; `node --test` 246/246
- [x] Review vòng 1 (Codex 1, Claude A 0, BC 4; co-van chấm): sửa tài liệu (70); bỏ qua >3 phiếu IT (có sẵn từ 0.12.0, đã chốt tối đa 3), tên máy dài / in lại ghi máy in lại (đã chốt), log nhánh dải dưới biển; làm sau: log khi lệnh mẫu mới thiếu deviceName (35)
- [x] Migration `xa_vai_a4_v3` (5 câu, `-- kiem:` true, ghi sổ release_ledger ở 7c2534e)
- [x] Build gói 0.12.1; người dùng cài trên DESKTOP-foq5t89 (06/11: print_agents may-a4-01 báo 0.12.1, máy in READY)
- [ ] In thử phiếu thật bằng 0.12.1 (06/11 kiểm: chưa có lệnh xa_vai_sheet nào sau khi cài) — vạch mép trên không bị xén, máy cầm tay quét được, ô Người xả có tên máy

## Đợt 5: xoá đợt phiếu IT (06/11/2026)
- Yêu cầu: "SWSH02 IT 1007261104006916 xóa giúp tôi đợt xả vải này và build tính năng xóa phiếu IT."
- Hợp đồng: `xa_vai_it_delete(p_it_number)` (JWT Admin) → `{ itNumber, itemCode, uidCount, measuredCount }`; lỗi `FORBIDDEN`, `INVALID_INPUT`, `NOT_FOUND`. Xoá đợt mọi trạng thái; `xa_vai_it_uids` theo FK cascade; không đụng `xa_vai_measures` / `print_jobs`.
- [x] SQL `supabase/xa_vai_it_delete_v1.sql` + `tests/xa_vai_it_delete_sql.cjs` PASS
- [x] Web: nút Xoá trên thẻ đợt (Admin), hộp đỏ hỏi lại; `tests/xa_vai_it_browser.cjs` PASS; 3 test chuẩn giao diện PASS
- [x] Review vòng 1 (Codex 2, Claude A 5, BC 2; co-van chấm): sửa — khoá chéo Lưu đợt / Xoá (Codex: Xoá commit trước lượt Lưu đang bay thì Lưu tạo lại đợt; 50, phóng đại mức nghiêm trọng), báo theo kết quả tải lại + bỏ thẻ khỏi màn ngay ([cả hai], 55), hộp hỏi lại nêu UID gắn khi quét (50), lưu mét NOT_FOUND tra lại UID; tài liệu (50). Làm sau: cache đợt 60 s trên máy khác (40). Bỏ qua: in lại sau xoá mất barcode IT (đúng thiết kế), advisory lock / tombstone (không đổi kết quả / trái chốt không nhật ký). Không chạy vòng 2 (sửa chỉ ở web, test bao phủ). Cần người dùng quyết: dọn mục Ngoài đợt xả (xa_vai_it_reports) — có sẵn trước đợt này
- [x] Migration `xa_vai_it_delete_v1` (6 câu, `-- kiem:` true, ghi sổ ở 07615f7), push
- [x] Xoá đợt SWSH02 / IT 1007261104006916 theo yêu cầu (58 UID, Xong, 0 UID đã đo; chạy cùng thân hàm bằng script, kiểm lại: 0 đợt, 0 UID còn lại; đợt CWHO0014 giữ nguyên)
- [ ] Admin bấm Xoá thật trên web lần đầu (chưa thử bằng phiên Admin thật)

## Đợt 6: xoá dòng Ngoài đợt xả (06/11/2026)
- Yêu cầu: "Ngoài đợt xả có nút xóa giúp tôi." (xa_vai_it_reports chưa có đường dọn nào).
- Hợp đồng: `xa_vai_it_report_delete(p_items jsonb)` (JWT Admin), `p_items = [{ groupUid, lastAt }]` 1–2.000 dòng, lastAt nguyên chuỗi từ `xa_vai_it_outside` → `{ deleted, requested, stale }`; chỉ xoá dòng `last_at` khớp (UID quét lại sau khi tải = stale, giữ lại); lỗi `FORBIDDEN`, `INVALID_INPUT`.
- [x] SQL `supabase/xa_vai_it_report_delete_v1.sql` + `tests/xa_vai_it_report_delete_sql.cjs` PASS
- [x] Web: nút Xoá từng dòng (icon) + Xoá hết (Admin), hộp đỏ hỏi lại, báo vàng khi có dòng stale / tải lại lỗi; `tests/xa_vai_it_browser.cjs` PASS; 3 test chuẩn giao diện PASS
- [x] Review vòng 1 (Codex 4, Claude A 4, BC 4; co-van chấm): sửa — chỉ xoá dòng có giờ quét cuối khớp ([cả hai], 75; Fable khuyến nghị một mốc p_seen_at, lead giữ so từng dòng vì đo 06/11 timestamptz qua JSON khớp micro giây và web gửi nguyên chuỗi), báo theo kết quả tải lại ([cả hai], 75), khoá nút trước khi lấy token (50), icon 20 (75), nút vẽ lại khi đang bận, PGRST202 báo đúng chức năng; bỏ qua nút Admin theo peekToken (mẫu chung). Vòng 2 (Codex, chỉ phần sửa): sửa lượt tải bị thay thế chờ lượt mới nhất, bắt lỗi múi giờ; overload text[] không có (bản nháp chưa chạy, kiểm pg_proc). Migration  đã chạy (6 câu, kiem true, ghi sổ dc5cb7f), push
- [ ] Admin bấm Xoá thật trên web lần đầu (bảng đang trống lúc lên)

## Phát sinh
- 05/11/2026 Tách hunk: cây làm việc có phần "Đối chiếu phủ lot theo PO" của phiên khác (`index.html`, `docs/QUYET_DINH.md`, `tests/bridge_ready.cjs` + tệp chưa theo dõi) → commit chỉ phần của đợt này; `bridge_ready` phần commit 11, cây làm việc 12; `tests/cut_po_coverage_browser.cjs` (chưa theo dõi) đã đổi số phiên bản giả lập 0.12.5 → 0.12.6 để cổng commit đạt.

## Lệch kế hoạch

## Nhật ký
- 2026-11-05 Dò WMS + Supabase (số đo ở trên); người dùng chốt Đ1–Đ4.
- 2026-11-05 Review vòng 1 (co-van chấm): SỬA — đợt của UID theo `added_at` (60), nạp lại giữ mã hàng đã lưu (65), In A4 khoá + kiểm lại lựa chọn sau khi tra đợt, chờ 2,5 s (55, [cả hai]), gộp SKU trùng ở Extension + câu lỗi SQL riêng (50, [cả hai]), kiểm mã UID duy nhất = tổng WMS / trang lặp / WMS bỏ lọc / dòng phiếu bị cắt + web báo UID bị bỏ (35, [cả hai]), badge = tổng máy chủ + "Hiện n / N" + giới hạn 50 (45), gom tiến độ một lần theo SKU, tổng chỉ tính SKU trong phiếu (25–40), nhãn tổng theo số đã in (40), thoát Admin bỏ bản nháp (35). Ảnh: SỬA % cạnh thanh, "Có UID", Ghi chú cả hàng; BỎ QUA thanh nút dính đáy điện thoại (xem trước là thao tác Admin, chỉ xét máy tính), màu "Chưa nhập" (kiểu có sẵn của pop-up, chốt 04/11), nhãn ô số phiếu (placeholder đủ, không thêm chữ), tách hai tầng đầu thẻ, màu dòng báo.
