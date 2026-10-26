# TÌM GROUP UID · Trả nhà cung cấp (24/10/2026)

Trạng thái: v1 + v2 + bố cục ĐÃ LÊN (24/10/2026); v3 Admin xoá đợt ĐÃ LÊN 26/10/2026 (`c9e790d`, migration chạy 01:25); sửa review vòng 1 làm 26/10, chưa commit. Chưa thử thật: Admin nạp Excel, Đối chiếu, xoá đợt.

## Yêu cầu (người dùng 24/10/2026)
"Tạo modul trong tìm group UID tên Trả nhà cung cấp gồm màu navy và black. Người dùng scan group UID, các group được scan sẽ đánh dấu. Danh sách theo file excel tôi cung cấp." — "Danh sách tạm thời lưu trên database, tôi sẽ báo dọn dẹp sau."

File mẫu (KHÔNG vào git, dữ liệu thật): PKL return vendor — sheet `navy` (118 Group UID, 1 SKU) + sheet `black <mã SKU>` (116 Group UID, 1 SKU); cột chuẩn bản xuất WMS (Group UID Code, Batch Code, Roll Code, Location, SKU, Product Name, Qty, Status); cuối sheet navy có bảng pivot (bỏ qua dòng không phải mã Group UID).

## Người dùng chốt
- C1 Admin nạp Excel ngay trên màn (nút Nạp Excel); chỉ đọc sheet có tên chứa "navy" / "black" → màu theo tên sheet.
- C2 Chỉ máy đã kích hoạt được ghi lượt quét (`floor_access_check`, như Lựa UID blocked / Cấp vải); ai cũng xem tiến độ.
- C3 UID ngoài danh sách → báo đỏ "Không thuộc danh sách trả"; quét trùng → báo "Đã quét" + máy + giờ, giữ lần đầu.
- C4 Hiển thị: thẻ đếm đã quét / tổng mỗi màu (Navy x/118, Black y/116) + danh sách theo tab màu, dòng đã quét được đánh dấu.
- Danh sách tạm, người dùng báo thì dọn (không cron dọn). Đã thay ở v3 (26/10/2026): Admin tự xoá đợt đang dùng trên màn.
- C5 (24/10 chiều) "cần phân theo vị trí hiện tại của group" + "nút đối chiếu… mục đích làm tất cả các group được chuyển về F0-VR-00-00-00-00": Đối chiếu = Admin đọc WMS TRỰC TIẾP qua Extension, lưu Supabase cho mọi máy; hai mốc riêng Đã quét + Về F0-VR.
- C6 UID WMS báo đã rời kho (Canceled / Closed / Transferred, hoặc không còn vị trí) → nhóm riêng "Đã rời kho", không tính Về F0-VR.
- C7 "các thông báo group UID khi scan dạng pop-up" → pop-up không modal như Cấp vải.

## Việc
### 1. Migration `supabase/vendor_return_v1.sql` (thuc-thi-logic)
- [x] Bảng `vendor_return_lists`, `vendor_return_items` (color navy|black), `vendor_return_scans` (khoá list + mã, máy, giờ); RLS bật không policy, revoke anon/authenticated.
- [x] `vendor_return_import(p_file_name, p_items)` Admin (`group_uid_admin_allowed()`), ≤ 2.000 dòng, danh sách mới thay danh sách đang dùng, chép lượt quét của UID còn có.
- [x] `vendor_return_snapshot()` anon: danh sách đang dùng + items + lượt quét.
- [x] `vendor_return_scan(p_access_token, p_list_id, p_group_uid)` qua `floor_access_check` → new / dup / not_in_list / STALE_LIST.
- [x] Test tĩnh `tests/vendor_return_sql.cjs`.
### 2. Web (lead)
- [x] Ô thứ 3 "Trả NCC" trong công tắc TÌM GROUP UID (`find-uid-script`), route `#tra-ncc`, màn `#vendor-return-screen`, khối `vendor-return-style` / `vendor-return-script`.
- [x] Quét (khung quét chuẩn, âm báo `PrintSkuScanCue`), thẻ đếm hai màu, tab Navy / Black, bảng đánh dấu dòng đã quét, Admin Nạp Excel (xem trước rồi lưu).
- [x] Nhãn khoá máy Admin (`FLOOR_FN`), đăng ký route (app-nav, CSS dùng chung các màn).
- [x] Test trình duyệt `tests/vendor_return_browser.cjs` (dữ liệu giả).
### 3. Kiểm + review
- [x] Cả bộ test; Codex 3 vòng + Codex ảnh + /review-claude (A Opus, B+C Sonnet) + Fable; ảnh 390 + 1280.
- [x] PROJECT_MAP, RULES.

## Thứ tự lên
Migration `vendor_return_v1.sql` → push web → Admin nạp Excel trên màn.
v2: migration `vendor_return_v2.sql` (chỉ thêm cột + create or replace, không DROP) → push web → Admin bấm Đối chiếu (cần Extension + tab WMS).

## Kết quả (24/10/2026)
- Test: `tests/vendor_return_sql.cjs`, `tests/vendor_return_browser.cjs` (1280 / 390: đếm, đánh dấu, ngoài danh sách, trùng, quét dồn, mã có tiền tố, tải lỗi, STALE_LIST, nạp Excel: pivot, thiếu cột SKU, Qty trống, mã trùng chặn Lưu), `tests/find_uid_browser.cjs` (công tắc 3 phần).
- Review: vòng 1 (Codex + Claude cùng báo) quét dồn bỏ lượt, poll ghi đè dấu vừa quét, Excel tự bỏ trùng / Qty 0, thanh trên thiếu nền nhóm → đã sửa; vòng 2 tải lỗi vẫn kết luận ngoài danh sách, sheet thiếu SKU → đã sửa (SQL bắt buộc sku); vòng 3 refresh chờ lượt cũ / STALE_LIST khi tải lỗi → đã sửa + test.
- Codex ảnh: thêm tên danh sách cho mọi người, dòng phụ Lot · SL · vị trí ở điện thoại; giữ khung như UID blocked cho các góp ý còn lại.

## Kết quả v2 (24/10/2026 chiều)
- `supabase/vendor_return_v2.sql`: cột `wms_location` / `wms_status` / `wms_updated_at`, `reconciled_at` / `reconciled_by`; snapshot trả `currentLocation`, `status`, `locationSource` (wms / sync / file), `warehouse`, `reconciledAt`; `vendor_return_reconcile` (Admin, STALE_LIST, ≤ 5.000, `updatedAt` kiểm bằng `pg_input_is_valid` và ≤ 1 ngày tương lai, giữ bản mới hơn, không đếm dòng y hệt).
- Web: bảng chia nhóm vị trí (STT liên tục), thẻ Về F0-VR, nút Đối chiếu dùng `GroupUidSnapshotCore` (lệch → đọc lại ≤ 3 lần → báo đỏ, không lưu), pop-up kết quả quét.
- Test: `tests/vendor_return_v2_sql.cjs`, `tests/vendor_return_browser.cjs` (nhóm vị trí, Đối chiếu: đọc lệch không lưu, id bản ghi lớn thắng, Đã rời kho, số máy chủ cập nhật; pop-up), `tests/group_uid_snapshot_core.cjs` (bản chép trong index.html khớp Extension).
- Review vòng 1 (Codex + 3 Claude + Fable): bộ đọc WMS tự viết không kiểm lệch [cả hai] → dùng core; thông báo sai số [cả hai]; load lỗi bị che; lỗi PING mất gốc; `updatedAt` cast thô [cả hai]; vị trí rỗng lùi về cũ → người dùng chốt C6. Bỏ qua: nút hidden (tailwind-base đã có `[hidden]{display:none!important}`), `to` = now + 1 ngày.
- Review vòng 2 (Codex mã + ảnh, 3 Claude, Fable): chặn Extension < 0.10.6 (0.10.5 trả ids thiếu rowIds), khoá chia sẻ với nạp + mốc `greatest`, SQL đòi đủ khoá location/status, dòng WMS thiếu dữ liệu → dừng không lưu, pop-up đóng khi rời màn, poll chỉ xoá lỗi tải của chính nó, trạng thái WMS tiếng Việt (Đã đóng / Đã huỷ / Đã chuyển). Làm sau: đối chiếu một phần (khi lỗi lệch lặp thật), cột Đã quét ở 390 px (có từ v1), nhãn số ở tiêu đề nhóm.

## Bố cục như UID blocked (24/10/2026 tối)
- Người dùng (ảnh UID blocked): "tôi cần thiết kế tương tự tìm group UID Blocked" + "phần danh sách cũng tương tự" → dải tiến độ, tab Còn thiếu (thẻ vị trí mở/đóng, lọc chữ + màu) | Đã quét (bảng chung, SL, Xuất Excel ngày đủ năm) | Danh sách (như UID blocked); bỏ thẻ màu và bảng nhóm cũ. Codex (mã + ảnh): thêm SL, ngày giờ đủ năm, nút lọc màu 44 px; giữ danh sách vừa quét / nút Kiểm / ô quét như UID blocked.

## v3 — Admin xoá đợt (26/10/2026)
Trạng thái: ĐÃ LÊN 26/10/2026 (commit `c9e790d`, migration `vendor_return_v3.sql` chạy 01:25, push); chưa xoá thử bằng Admin thật.
- Người dùng: "đăng nhập admin cho phép xóa đợt return vendor". Thay quyết định 24/10 "chưa có chức năng xoá, báo thì lead dọn tay": nay Admin tự xoá trên màn.
- "Đợt" = một danh sách Admin nạp bằng Excel. Màn chỉ hiện đợt đang dùng (`active`), nên chỉ xoá đợt đó. Số liệu thật 26/10: 1 đợt (234 dòng, 209 lượt quét), chưa có danh sách tắt nào.
- Dữ liệu quét xoá THEO đợt (có chủ ý): `vendor_return_items` / `vendor_return_scans` khoá ngoại `ON DELETE CASCADE`; lượt quét không thể sống thiếu dòng danh sách và không có màn xem lại.
- `supabase/vendor_return_v3.sql`: `vendor_return_delete(p_list_id)`, SECURITY DEFINER + `search_path = ''`, `group_uid_admin_allowed()` đầu tiên, khoá độc quyền chung với nạp / quét / đối chiếu, `STALE_LIST` (không xoá) / `NO_LIST`, chỉ `authenticated`.
- Web: nút `#vr-delete` (Admin + có danh sách) → `WhDialog.confirm` danger (tên tệp, số UID đã quét) → RPC bằng phiên Admin; máy quét gặp `NO_LIST` thì tải lại và hiện "Chưa có danh sách".
- Thứ tự lên: migration `vendor_return_v3.sql` → push web (web gọi hàm mới) — đã làm đúng thứ tự.
- Không làm (chưa ai yêu cầu): xoá các danh sách đã tắt (`active = false`) từ lần nạp thay thế; hiện chưa có dòng nào.
- Hợp đồng dữ liệu `vendor_return_delete(p_list_id uuid)`: vào = mã đợt web đang hiện; ra `{ok:true, data:{deleted, listId, items, scans}, meta}`; lỗi `{ok:false, error:{code, message}}` với `FORBIDDEN` (không Admin), `INVALID_LIST` (thiếu mã), `NO_LIST` (không còn đợt nào), `STALE_LIST` (đợt đã đổi, kèm `data.listId` hiện hành, không xoá gì).
- Lên thật 26/10/2026: commit `c9e790d`, migration chạy 01:25 (kiểm: SECURITY DEFINER, `search_path` rỗng, anon không execute, authenticated execute; dữ liệu nguyên 1 đợt / 234 dòng / 209 lượt quét), push. Chưa thử xoá bằng Admin thật.
- Review vòng 1 (Codex + Claude A + BC + Fable, 26/10/2026; báo cáo `outputs/claude-review/review-20261026-0825.md`): NÊN SỬA G1 (lỗi bất định báo chắc "Chưa xoá được") và G6 (tài liệu lệch); LÀM SAU G2, G3, G5; BỎ QUA G4 (báo "Đã quét" từ bản chụp trên máy là thiết kế đã chốt).
- Sửa review (26/10/2026, chưa commit): G1 — lỗi không có mã nghiệp vụ dạng chuỗi (mất mạng, hết giờ chờ — `TimeoutError` mang code số 23 —, cổng 502, thân hỏng) thì tải lại rồi báo "Chưa rõ kết quả xoá" kèm đợt còn / không còn / đợt mới, có nút Thử lại.
- G2 — xoá xong mà tải lại lỗi: "Đã xoá… chưa tải lại được danh sách", giữ nút Thử lại. G3 — `NO_LIST` tải lại thấy đợt mới thì quét lại, tải lại lỗi thì bỏ bản chụp cũ; sau tải lại không còn đợt thì "Chưa có danh sách". G5 — một cờ bận chung khoá nút Xoá / Đối chiếu / Nạp khi một việc đang chạy.
- Test: `tests/vendor_return_browser.cjs` thêm 10 tình huống (5 kiểu mất phản hồi, G2, G3a / G3c / G3d, G5 hai chiều); trên `index.html` cũ cả 5 nhóm đỏ (bản sao assert mềm), trên bản sửa xanh.
