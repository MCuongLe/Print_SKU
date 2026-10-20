# RFID ↔ Group UID (2026-10-20)

## Thiết kế
- **Yêu cầu:** "mở Chrome dev tool mcp dò rfid mapping với group UID. Cho phép Scan RFID mapping link với group UID".
- **Đã chốt với người dùng (20/10/2026):** nguồn liên kết = **đồng bộ từ WMS** (không lấy cột RFID trong Excel — tệp blocked chỉ 1/719 dòng có); máy quét bắn **mã in trên tem RFID** (1 chữ + 11 số, giống cột RFID mapping WMS).
- **Dò WMS (Chrome DevTools MCP, chỉ đọc, 20/10):** dòng `group-uid-infos?active_tab=group-list` có trường `group_rfid_mapping` (khoá chỉ có khi đã gắn); lọc `group_rfid_mappings=<RFID>` trả đúng 1 UID (thử 3 cặp từ tệp xuất); 1.933/9.789 UID kho Material MTG có RFID.
- **Lead tự quyết (đổi được):** (1) WMS gỡ RFID (dòng mới hơn không có trường) → Supabase xoá theo (bản sao trung thực; khác qc_status giữ giá trị cũ vì WMS đôi khi không trả QC); (2) không ràng buộc duy nhất RFID ở database (dữ liệu WMS lỗi không được làm hỏng cả lượt đồng bộ) — chỉ index một phần (cột khác null); (3) lấp dữ liệu cũ bằng một lượt "Đối chiếu toàn bộ" sau khi lên (lượt toàn bộ ban đêm cũng làm); (4) phạm vi quét RFID đợt này = màn LỰA UID BLOCKED; màn khác (Cắt, Cấp vải, Tìm SKU) đợt sau nếu cần.
- **Hợp đồng:**
  - Extension `normalizeRow` thêm `group_rfid_mapping` (chuỗi 1–40 ký tự chữ/số, viết hoa; không có → null); manifest 0.10.1 → 0.10.2.
  - Edge `group-uid-sync` `normalizedRows` nhận + kiểm `group_rfid_mapping`.
  - Migration `supabase/group_uid_rfid_v1.sql`: cột `group_rfid_mapping text` ở `group_uid_sync_staging` + `group_uid_details`, index một phần; preview (changedFields `group_rfid_mapping`) + apply (gu_touch, insert/on conflict, verify) bản mới nhất chép từ `group_uid_qc_status_v1.sql` thêm cột; hàm anon `group_uid_by_rfid(p_codes text[])` (≤ 100 mã) → `[{rfid, groupUid}]`; `uid_block_snapshot` trả thêm `rfid` mỗi item (ghép `group_uid_details`).
  - Web LỰA UID BLOCKED: mã quét dạng `^[A-Z][0-9]{11}$` (không phân biệt hoa thường) = RFID → tra danh sách trên máy theo `rfid`, không có thì hỏi `group_uid_by_rfid` → Group UID rồi kiểm như quét UID; thẻ ghi "RFID … → UID …"; RFID chưa liên kết → thẻ cảnh báo. Màn đồng bộ Admin: nhãn trường "RFID".
- **Thứ tự lên:** migration → deploy Edge `group-uid-sync` → Reload Extension (+ tải lại tab WMS) → push web → Đối chiếu toàn bộ Group UID một lần.
- **Rủi ro:** WMS có thể không đổi `updated_date` khi chỉ đổi RFID → lượt gia tăng không thấy; lượt toàn bộ ban đêm bắt được (ghi rõ). Mỗi lượt ghi ~28.000 dòng → index một phần nhỏ (~2.000 dòng).
- **Chưa kiểm được bằng máy:** máy quét RFID thật.

## Kế hoạch
### Việc 1 — Extension + Edge + migration · thuc-thi-logic · [ ]
- [ ] Test đỏ trước (group_uid_sync_extension, po_group_uid_core, Edge normalizedRows, test SQL tĩnh mới)
- [ ] normalizeRow + Edge + migration group_uid_rfid_v1 + version 0.10.2 (manifest, test, README)
### Việc 2 — Web: quét RFID ở LỰA UID BLOCKED + nhãn Admin · lead · [x]
- [x] Test đỏ trước trong uid_block_browser (RFID trong danh sách / tra máy chủ / chưa liên kết / mất mạng)
### Việc 3 — Review · Codex + /review-claude · [ ]
### Việc 4 — Xác minh + lên · lead · [ ]
- [ ] Cả bộ test + cổng; PROJECT_MAP + README; commit (chưa push) → migration → deploy Edge → Reload Extension → push → Đối chiếu toàn bộ → kiểm chỉ đọc số UID có RFID

## Phát sinh

## Lệch kế hoạch

## Nhật ký
- 20/10 Việc 2: uid_block_browser khối 14 (RFID có trên máy / tra máy chủ / chưa liên kết, chữ thường) đỏ trên bản cũ → xanh 2 lần liền; nhãn UF "RFID" màn đồng bộ Admin. Kèm sửa 2 chỗ chờ racy trong test cũ (thẻ đỏ báo ngay rồi nâng cấp ĐÃ SCAN).
