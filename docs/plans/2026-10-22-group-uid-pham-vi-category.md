# Đồng bộ Group UID chỉ giữ category NVL + Phụ liệu + Gia công (2026-10-22)

> **TẠM DỪNG 22/10/2026 (người dùng: "tạm dừng hướng này")** sau khi biết mức giảm thực tế chỉ ~3–4%. Chưa build gì; 2 câu hỏi mở chưa trả lời. Làm tiếp khi được yêu cầu lại.

## Thiết kế
- **Yêu cầu (22/10):** "chỉ cập nhật group UID của 2 category nguyên vật liệu và nguyên phụ liệu thôi, các category khác không cập nhật để giảm dữ liệu".
- **Người dùng chốt (22/10):**
  1. Giữ **957 Thời Trang (NVL) + 954 Thời Trang (Phụ Liệu) + 964 Nguyên liệu nhận Gia công**. Vải ở GARMENT gần như toàn bộ là 964 (7.337 UID; vải NVL 957 ở GARMENT chỉ 85).
  2. UID **chưa có SKU** (New, Canceled…) vẫn lưu để tra cứu; Canceled dọn theo lịch dọn có sẵn.
  3. Group UID thuộc category khác đang có trên Supabase: **sao lưu rồi xoá**.

### Số đo (Supabase, 22/10, chỉ đọc)
| Nhóm | Số UID | Xử lý |
|---|---|---|
| 957 Thời Trang (NVL) | 10.546 | giữ |
| 964 Nguyên liệu nhận Gia công | 7.337 | giữ |
| 954 Thời Trang (Phụ Liệu) | 461 | giữ |
| Chưa có SKU (Canceled 11.053 · New 7.423 · khác 603) | 19.079 | giữ |
| 960 Thời Trang (thành phẩm, kho GLOBAL/FG) | 1.166 | **bỏ** |
| SKU không có trong `SKU_Name` (kho GLOBAL) | 376 | xem câu hỏi mở 1 |

- WMS **không lọc được theo category** (bộ lọc Group UID chỉ có kho, vị trí, trạng thái, loại, SKU/barcode, lô, RFID, ngày) → vẫn đọc đủ từ WMS, lọc ở bước ghi Supabase.
- Category lấy theo SKU hiệu lực của UID (`group_uid_sync_effective_sku`) ↔ `SKU_Name.category_id` (đồng bộ SKU 7 nhóm).

### Cách làm
- **Lọc ở SQL preview/apply**, không ở Extension/web: một chỗ cho cả đồng bộ tự động lẫn tay, không phải phát Extension mới.
  - Staging vẫn nhận đủ dòng WMS (giữ nguyên kiểm `SOURCE_COUNT_MISMATCH`, `FULL_SOURCE_TOO_SMALL`, `fullDropPercent` — không bị báo tụt 4%).
  - Hàm `group_uid_sync_in_scope(sku)`: SKU rỗng → trong phạm vi; SKU có `category_id` thuộc danh sách → trong; còn lại → ngoài.
  - Danh sách category ở bảng cấu hình `group_uid_sync_scope` (một dòng: `category_ids text[] = {957,954,964}`, `keep_no_sku = true`, `keep_unknown_sku`), đổi sau không cần sửa mã.
  - Preview: `added` / `updated` / `stale_source` chỉ cho dòng trong phạm vi; dòng ngoài phạm vi đếm `outOfScope` (không tính vào `unchanged`); UID đang có trong database mà nay ngoài phạm vi (đổi SKU/category) → `removed` (apply xoá). Toàn bộ: `missing` chỉ xét dòng database trong phạm vi.
  - Màn Admin Đồng bộ Group UID: thêm số "ngoài phạm vi" vào dải số/thẻ xem trước (đọc `changeCounts.outOfScope`), không đổi luồng bấm.
- **Dọn một lần:** script chỉ đọc xuất CSV các dòng ngoài phạm vi (`group_uid_details` + `group_uid_products`) ra `D:\UID\backup\` (ngoài git) → migration xoá các dòng đó.
- Ảnh hưởng đã soát: Cắt Group UID, Cấp vải, UID blocked, RFID chỉ dùng 957/964 (đo 22/10: blocked 727 NVL + 24 Gia công; RFID 3.112 NVL + 2.385 Gia công + 231 không SKU) → không mất. Quét UID thành phẩm (960) ở Cắt sẽ báo "chưa có dữ liệu" — chấp nhận.

### Câu hỏi mở (hỏi trước Việc 1)
1. **SKU chưa có trong `SKU_Name`** (376 UID kho GLOBAL hôm nay): lọc ra (gọn hơn) hay giữ (an toàn hơn: SKU vải mới tạo trên Inside mà đồng bộ SKU chưa kịp chạy thì UID vẫn được lưu; nếu lọc ra, phải chờ lượt Toàn bộ kế tiếp sau khi SKU vào danh mục). Lead đề xuất **giữ**.
2. **Mức giảm thực tế nhỏ (~1.166–1.542 dòng ≈ 3–4%)** vì giữ UID chưa có SKU. Phần lớn còn lại là Canceled 11.053 (9.900 dưới 30 ngày) và New 7.423 (6.168 quá 30 ngày). Muốn giảm mạnh thì cân nhắc rút lịch dọn Canceled 180 → 30 ngày (−1.126 ngay, rồi giữ ở mức ~1 tháng) và/hoặc không lưu UID New quá 30 ngày chưa nhận hàng (−6.168).

## Kế hoạch
### Việc 1 — Migration `group_uid_sync_scope_v1` (thuc-thi-logic) · [ ]
- [ ] Bảng `group_uid_sync_scope` (RLS bật, chỉ service_role) + hàm `group_uid_sync_in_scope`
- [ ] `group_uid_sync_preview` / `group_uid_sync_apply` bản mới nhất (chép từ `cut_group_uid_po_v1.sql`) thêm lọc phạm vi, `outOfScope`, `removed`
- [ ] Test SQL tĩnh + đột biến (`tests/group_uid_sync_scope_sql.cjs`), dry-run
### Việc 2 — Sao lưu + dọn (lead) · [ ]
- [ ] Script `scripts/group_uid_scope_backup.py` (chỉ đọc, CSV ra `D:\UID\backup\`) — chạy, đếm khớp
- [ ] Phần xoá trong migration (chạy SAU khi có bản sao), ghi `print_maintenance`
### Việc 3 — Web Admin (lead) · [ ]
- [ ] Hiện "ngoài phạm vi" ở xem trước; test `group_uid_sync_admin_browser`
### Việc 4 — Review Codex (SQL) · [ ]
### Việc 5 — Lên: sao lưu → migration → push web → chạy Toàn bộ tay → kiểm số dòng · [ ]

## Phát sinh

## Lệch kế hoạch

## Nhật ký
- 22/10 đo phân bố category (Supabase) + bộ lọc WMS (DevTools, chỉ đọc); người dùng chốt 957 + 954 + 964, giữ UID chưa SKU, sao lưu rồi xoá.
