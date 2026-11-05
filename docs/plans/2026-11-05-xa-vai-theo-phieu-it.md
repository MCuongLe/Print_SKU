# Xả vải theo phiếu IT (2026-11-05)

Trạng thái (05/11/2026): **ĐANG BUILD**. Người dùng chốt "Chốt, build".

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
  - `xa_vai_it_of_uids(p_uids text[])` — anon, ≤ 500 UID: `{ items:[{ groupUid, itNumber, itemCode }] }` (đợt nạp gần nhất nếu UID ở nhiều đợt).
- **Rủi ro và cách chặn:**
  - Extension cũ im lặng với lệnh lạ → web hỏi `PING_WMS`, phiên bản < 0.12.6 báo "Reload Extension".
  - UID chuyển tiếp trước khi Admin nạp → mất khỏi kết quả WMS; màn hiện "chưa có UID" theo SKU để thấy.
  - Nhiều phiên sửa `index.html` (cây làm việc đang có phần Đối chiếu phủ lot của phiên khác): commit chỉ hunk của đợt này; `tests/bridge_ready.cjs` đếm helper.
- **Chưa kiểm được bằng máy:** Extension thật đọc phiếu thật (sau Reload), nạp đợt bằng Admin thật, quét UID thật trên Honeywell.

## Kế hoạch
Thứ tự: Việc 1 → Việc 2 → Việc 3 → Việc 4 (review) → Việc 5 (lên).

### Việc 1 — SQL `supabase/xa_vai_it_v1.sql` · lead · [ ]
- [ ] Hai bảng + 4 RPC, quyền đúng vai, dòng `-- kiem:`, khối Rút lui
- [ ] Test tĩnh `tests/xa_vai_it_sql.cjs` PASS + `apply_supabase_sql.py --dry-run`

### Việc 2 — Extension 0.12.6 `GET_XA_VAI_IT` · lead · [ ]
- [ ] `group-uid-sync-core.js` `normalizeXaVaiIt`; `wms-bridge.js` `readXaVaiIt`; allow-list `app-bridge.js`, `background.js`, `wms-bridge.js`
- [ ] manifest + README + test `tests/xa_vai_it_core.cjs`; sửa số phiên bản ở `inside_po_connector`, `sku_sync_extension`

### Việc 3 — Web tab Phiếu IT · lead · [ ]
- [ ] Tab 4, xem trước + Lưu đợt (Admin), danh sách đợt + UID
- [ ] Pop-up quét có dòng đợt; In A4 điền sẵn mã hàng của đợt
- [ ] `tests/xa_vai_it_browser.cjs` (máy tính + 375 px); `xa_vai_a4_browser`, bộ chuẩn UI PASS

### Việc 4 — Review · [ ]
- [ ] Codex + `/review-claude` một vòng (ảnh giao diện kèm), lọc với co-van

### Việc 5 — Lên · [ ]
- [ ] commit (chưa push) → migration → ghi sổ → người dùng Reload Extension → push
- [ ] `docs/QUYET_DINH.md`, `docs/PROJECT_MAP.md`, `README.md`, `RULES.md`

## Phát sinh

## Lệch kế hoạch

## Nhật ký
- 2026-11-05 Dò WMS + Supabase (số đo ở trên); người dùng chốt Đ1–Đ4.
