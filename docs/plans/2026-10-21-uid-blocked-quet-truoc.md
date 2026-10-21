# UID blocked: quét trước, vị trí còn thiếu bên dưới, tự nhận UID Blocked mới (2026-10-21)

## Thiết kế
- **Yêu cầu (ảnh màn điện thoại 08:26):** "giao diện ưu tiên phần quét camera lên đầu. phía dưới là phần danh sách vị trí thiếu dạng click thả xem các group UID còn thiếu. vị trí đã quét đủ thì không hiển thị. khi cập nhật có group blocked mới thì đưa qua đây."
- **Hiện trạng:** màn TÌM GROUP UID → UID blocked: công tắc → 4 thẻ số (Danh sách/Blocked/Đã lựa/Còn thiếu) → 4 tab (Quét · Đã lựa · Còn thiếu · Danh sách) → khung quét. Vị trí còn thiếu chỉ có ở tab Còn thiếu (thẻ mở sẵn + bảng). Danh sách chỉ đổi khi Admin bấm "Đọc WMS" (751 UID, 21/10 07:56).

### Màn mới (điện thoại trước, máy tính cùng thứ tự)
```
┌ TÌM GROUP UID ─────────────────────────┐
│ [ Cấp vải ] [ UID blocked ]            │  công tắc (giữ)
│ ┌ Quét ─────────────────────── 🔊 ┐   │  1. KHUNG QUÉT lên đầu: camera to, gõ tay, máy scan
│ │ [⌗ Group UID / RFID  📷 ⌨] [Kiểm]│   │
│ │ (thẻ kết quả BLOCKED / ĐÃ SCAN…) │   │
│ └──────────────────────────────────┘   │
│ Đã lựa 1/751 ▓░░░░  · Chờ gửi 0         │  2. dải số gọn một hàng (thay 4 thẻ to)
│ Vị trí còn thiếu (n vị trí · 750 cuộn)  │  3. DANH SÁCH VỊ TRÍ: đóng sẵn, chạm để mở
│  ▸ F0-A0-01-02-03-01        3 cuộn  🆕  │     – chỉ vị trí còn cuộn chưa quét
│  ▾ F0-B1-00-00-00-04        2 cuộn      │     – mở ra: Group UID · SKU · Lot · Roll (UID mới gắn "Mới")
│     1028…0104  900000004 · L4 · R4      │     – quét đủ → vị trí biến mất (ngay trên máy + máy khác khi đồng bộ)
│  ▸ …                                    │
│ [ Đã lựa ] [ Danh sách ]                │  4. phụ: bảng Đã lựa (xuất Excel), Danh sách (Admin: Đọc WMS, Nạp Excel, Đối chiếu)
└─────────────────────────────────────────┘
```
- Tab "Còn thiếu" bỏ (thay bằng danh sách vị trí ngay dưới khung quét); "Quét" thành màn chính; "Đã lựa", "Danh sách" thành hai nút/tab phụ bên dưới.
- Tìm nhanh trong danh sách vị trí: ô lọc theo mã vị trí / Group UID / SKU (dài 750 cuộn).

### Tự nhận UID Blocked mới (không cần Admin bấm)
- Nguồn: dữ liệu Group UID đồng bộ WMS (lượt tự động 30 phút + toàn bộ mỗi đêm qua Extension máy Admin).
- **pg_cron mỗi 30 phút** gọi hàm `uid_block_refresh_wms()`: nếu danh sách đang dùng là danh sách WMS (tên "WMS Blocked …") và tập UID Blocked của 2 kho khác danh sách → tạo danh sách mới (qua đúng đường `uid_block_import`: chép lượt đã scan, giữ 5 danh sách) và ghi `added_at` cho UID mới để web gắn nhãn "Mới". Máy đang mở màn tự tải lại (đã kiểm phiên bản 20 giây/lần).
- Danh sách Excel (Admin nạp tay) thì KHÔNG tự đổi.
- Giới hạn: WMS không đổi `updated_date` khi chỉ đổi trạng thái → lượt gia tăng có thể sót, lượt toàn bộ ban đêm bắt được (đã ghi từ 12/10).

### Người dùng đã chốt (21/10)
1. UID trong danh sách mà WMS **hết Blocked** → bỏ khỏi "còn thiếu"; UID đã quét vẫn giữ trong Đã lựa; **phải hiển thị cho người dùng biết** UID nào đã hết Blocked → mục "Hết Blocked (n)" dưới danh sách vị trí (UID · trạng thái WMS hiện tại · lúc phát hiện), quét trúng UID đó → thẻ "HẾT BLOCKED" (không phải BLOCKED, không phải "Không blocked" trơn), bảng Đã lựa gắn nhãn "Hết Blocked". Giữ mục này 7 ngày.
2. Tự cập nhật **30 phút** (pg_cron `*/30`).
3. 4 thẻ số → **một dải gọn** dưới khung quét; tên danh sách / giờ nạp sang tab Danh sách.
- Lead: khung quét luôn ở đầu; bên dưới hàng tab phụ **Còn thiếu** (mặc định: danh sách vị trí đóng sẵn) · **Đã lựa** · **Danh sách** — đổi tab không đẩy khung quét đi.

## Kế hoạch
### Việc 1 — Migration `uid_block_auto_v1` (thuc-thi-logic) · [x]
- [x] `uid_block_lists.source` ('excel' | 'wms') + `uid_block_items.added_at`, `released_at`, `wms_status`; tách thân `uid_block_import` (không kiểm Admin) để cron dùng
- [x] `uid_block_refresh_wms()` (chỉ cron) so tập Blocked 2 kho với danh sách WMS đang dùng → khác thì nạp danh sách mới (UID mới: added_at; UID hết Blocked: released_at + wms_status, giữ 7 ngày); snapshot trả addedAt / releasedAt / wmsStatus; `cron.schedule` 30 phút; test SQL tĩnh + đột biến
### Việc 2 — Web: quét trước + vị trí còn thiếu (lead) · [x]
- [x] Thứ tự: công tắc → khung quét → dải số gọn → danh sách vị trí đóng sẵn (chỉ vị trí còn thiếu, nhãn "Mới", lọc) → Đã lựa / Danh sách phụ
- [x] Test đỏ trước (uid_block_browser: thứ tự, vị trí đủ biến mất, mở/đóng, UID mới có nhãn) + ảnh 390/1280
### Việc 3 — Review Codex (SQL + ảnh) · [x]
### Việc 4 — Lên: commit → migration → push → kiểm chỉ đọc · [ ]

## Phát sinh

## Lệch kế hoạch
- 21/10 agent SQL: (a) 'hết Blocked' chỉ tính khi danh sách trước là WMS; (b) hết Blocked = không còn trong tập Blocked các kho (kể cả chuyển kho) — lead đồng ý. Lead quyết: UID hết Blocked đã quét giữ luôn (không bỏ sau 7 ngày). Không ghi print_maintenance.

## Nhật ký
- 21/10 Việc 2: uid_block_browser (thứ tự công tắc → quét → dải → tab; vị trí đóng sẵn, chạm mở, lọc; Hết Blocked + thẻ HẾT BLOCKED + không ghi lượt quét; nhãn Mới) đỏ trước → xanh; test chung (find_uid, src_read_style, a11y, group_banners, mobile_modules, scan_field, icon) PASS; ảnh 390/1280.
- 21/10 Việc 1 (thuc-thi-logic): 51/51 đột biến đỏ, dry-run 34 câu; 3 test SQL cũ vẫn đạt.
- 21/10 Review: Codex ảnh 7 góp ý (làm cả 7); Codex mã V1 5 nhóm (uid_block_scan ghi UID hết Blocked — nghiêm trọng; backfill theo tên; danh sách rỗng; so tập thiếu vị trí; tên tệp ở dải), V2 3 nhóm (STALE_LIST xoá lượt trước lúc hết Blocked; NO_ROWS kẹt Excel; backfill vẫn suy đoán → ghi đích danh id fbeef2e5…), V3 0 lỗi. Agent 74/74 đột biến đỏ. Cả bộ test 89/89 PASS (713 giây).
