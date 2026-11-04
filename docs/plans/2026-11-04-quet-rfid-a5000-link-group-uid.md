# Quét RFID A5000 → Group UID ở các ô quét Group UID (2026-11-04)

Trạng thái (04/11/2026): **XONG PHẦN MÃ — cả bộ 144/144, commit_gate ĐẠT, Codex vòng 1 đã lọc + sửa, tài liệu xong; CHƯA thử Honeywell thật, CHƯA đo WMS (gắn thử RFID, chuỗi máy quét thật), CHƯA commit / push**. Người dùng chốt 6 màn + camera.

## Thiết kế
- **Yêu cầu:** "Hiện tại tôi đã mapping rfid mã A500, tôi cần lên kế hoạch quét mã rfid A500 cũng link được qua group UID."
- **Kết quả nhìn thấy được:**
  - Ở ô quét Group UID, quét mã RFID (1 chữ + 11 số, vd `A50000000005`) cho đúng kết quả như quét Group UID đang gắn với RFID đó.
  - Thẻ kết quả có dòng nhỏ `RFID <mã>` cạnh mã UID (như `via` của LỰA UID BLOCKED); mọi thao tác ghi vẫn ghi theo Group UID, không ghi mã RFID.
  - RFID chưa liên kết / trùng nhiều UID / chưa kiểm được → báo ngắn + âm lỗi, không đi tiếp.
- **Đã chốt với người dùng:** 04/11 "Chốt 6 màn, build": IN TEM GROUP UID, CẮT GROUP UID, XẢ VẢI, CẤP VẢI, TRẢ NCC, CHUYỂN ĐỔI ĐƠN VỊ (+ camera dùng chung). Cùng ngày: "tạm thời dừng phiên rfid".
- **Đổi quyết định cũ:** `docs/QUYET_DINH.md` mục RFID ghi "quét RFID chỉ ở LỰA UID BLOCKED" (20/10 · N1071–N1073) → mở rộng sang các ô quét ở Việc 0.
- **Số đo thật** (Supabase, chỉ đọc, 04/11/2026 ~15:30):
  - `group_uid_details`: 40.860 UID, 29.547 không Canceled, 13.934 có RFID (12 ký tự, 0 trùng).
  - Theo tiền tố: `A500…` 10.570 (từ `A50000000005` tới `A50000011364`, 0 Canceled, 195 dòng sửa trong 24 giờ), `A300…` 3.364 (mã cũ).
  - Đồng bộ gia tăng chạy mỗi 30 phút (lượt 15:26: 8 dòng nguồn, 5 sửa, Extension 0.12.5), nên RFID gắn trong WMS về Supabase trễ tối đa ~30 phút nếu WMS đổi `updated_date` khi gắn RFID.
  - Hiện chỉ LỰA UID BLOCKED (`#ub-code`) nhận mã RFID: `rfidOf` = `(?<![A-Z0-9])[A-Z][0-9]{11}(?![A-Z0-9])`, `resolveRfid` gọi `group_uid_by_rfid` (≤ 2 giây, chỉ nhận đúng 1 UID, ưu tiên không Canceled).
  - Camera dùng chung `PrintSkuScanUI.openGroupUid` chỉ nhận `^\d{16}$`.
- **Hợp đồng dữ liệu:**
  - RPC `group_uid_by_rfid(p_codes text[])` đã có (anon + authenticated, ≤ 100 mã, trả `rows[{rfid, groupUid, status}]`): **không cần migration, Edge hay Extension mới**.
  - Khối web dùng chung mới `window.PrintSkuRfid`: `rfidOf(raw)`, `resolve(raw)` → `{code}` | `{many}` | `{none}` | `{error}` | `{plain}` (không phải RFID thì trả nguyên mã để màn xử lý như cũ).
  - Chuỗi báo dùng chung: "RFID chưa liên kết", "RFID trùng nhiều UID", "RFID chưa kiểm được".
- **Rủi ro và cách chặn:**
  - RFID mới gắn chưa về Supabase → báo "RFID chưa liên kết"; Admin bấm Đọc WMS (đã có ở Tiến độ A5000, Extension 0.12.5) để kéo về ngay; chưa kiểm WMS có đổi `updated_date` khi gắn RFID (`docs/QUYET_DINH.md` mục Tiến độ A5000): đo ở Việc 1.
  - Mất mạng: màn không có danh sách UID trên máy như LỰA UID BLOCKED → báo "RFID chưa kiểm được", không đoán.
  - Nhầm với mã khác: SKU 9 số, Group UID 16 số, mã vị trí có dấu `-` đều không khớp mẫu RFID; mẫu chỉ khớp khi cả chuỗi là 1 chữ + 11 số.
  - Ô tự tra khi đủ ký tự (xả vải): thêm mẫu RFID 12 ký tự; vẫn chỉ ĐỌC tự chạy, GHI vẫn Enter / Lưu.
  - Một UID Canceled giữ RFID cũ: luật có sẵn (ưu tiên UID không Canceled; nhiều UID → báo trùng).
- **Chưa kiểm được bằng máy:** máy quét thật đọc mã RFID in trên tem hay đầu đọc RFID gõ qua IME (đã xác nhận 20/10 là mã 12 ký tự, chưa thử máy thật), quét A500 thật ở từng màn trên Honeywell.

## Kế hoạch
Thứ tự chạy: Việc 0 (người dùng chốt) → Việc 1 (đo) → Việc 2 (khối dùng chung) → Việc 3 (nối từng màn) → Việc 4 (tài liệu, review, phát hành).

### Việc 0 — Chốt phạm vi · người dùng · [x]
- [x] Chọn màn nhận mã RFID (04/11: chốt cả 6). Đề xuất: cả 6 ô quét Group UID: IN TEM GROUP UID `#uid-code`, CẮT GROUP UID `#cut-code`, XẢ VẢI `#xa-vai-code`, CẤP VẢI `#cap-vai-code`, TRẢ NCC `#vr-code`, CHUYỂN ĐỔI ĐƠN VỊ `#uc-code` (ô nhận SKU hoặc Group UID), cộng camera dùng chung.
- Ngoài phạm vi: ô quét SKU / vị trí (`#uid-bulk-sku`, `#uh-sku`, `#uh-loc`); sửa liên kết RFID trong WMS.

### Việc 1 — Đo · lead · [ ] (đã đo phần Supabase; còn hai việc cần người dùng trên máy thật)
- [ ] Gắn thử 1 RFID cho 1 UID trong WMS, xem lượt đồng bộ gia tăng kế tiếp có thấy dòng đó không (trả lời "WMS có đổi `updated_date` khi gắn RFID").
- [ ] Người dùng quét 1 tem RFID thật vào một ô nhập: ghi lại chuỗi máy quét gửi (có tiền tố / Enter / chữ thường không).
- [x] Đếm UID tồn không Canceled chưa có RFID theo kho (04/11, Supabase chỉ đọc: MTG vật tư 7.149 tồn / 5.791 A500 / 209 chỉ A300 / 1.149 chưa RFID; GARMENT vật tư 4.607 / 4.607 A500; bán thành phẩm GARMENT 3.681 / 86 A500 / 1.148 A300 / 2.447 chưa; bán thành phẩm MTG 2.807 / 87 / 1.490 / 1.230; các kho khác hầu như chưa có; A500 tổng 10.577, 0 sai dạng, 0 trùng) (số liệu cho người dùng biết còn bao nhiêu UID quét RFID chưa ra).

### Việc 2 — Khối dùng chung `window.PrintSkuRfid` · lead · [x] (04/11, test `shared` + `uid_block_browser` đạt)
- Tệp và neo: `index.html` → khối mới `<script id="rfid-resolve-script">` đặt trước `uid-block-script`; `resolveRfid` / `rfidOf` trong `uid-block-script` đổi sang gọi khối này (giữ hành vi, danh sách trên máy làm dự phòng như cũ).
- [x] `resolve(raw)` trả `{code}` / `{many}` / `{none}` / `{error}` / `{plain}`, hết giờ 2 giây, chỉ nhận đúng 1 UID (ưu tiên không Canceled).
- [x] LỰA UID BLOCKED dùng khối chung, test cũ `uid_block_*` vẫn đạt (`uid_block_browser.cjs`; chưa chạy các test SQL `uid_block_*`, không đổi).
- [x] Test đỏ trước (đỏ vì thiếu `PrintSkuRfid`, rồi xanh): `tests/rfid_resolve_browser.cjs` (Supabase giả: 1 UID, nhiều UID, không có, lỗi mạng, mã không phải RFID) rồi xanh.

### Việc 3 — Nối từng ô quét · lead · [x] (6 màn + camera, test đạt)
- Mỗi màn: mã RFID → `PrintSkuRfid.resolve` → dùng Group UID như vừa quét; thẻ kết quả ghi `RFID <mã>`; các trạng thái lỗi có âm `bad`.
- [x] `#uid-code` (IN TEM GROUP UID) — `rfid_resolve_browser.cjs` phần `printLabel` đạt.
- [x] `#cut-code` (CẮT GROUP UID) — `rfid_resolve_browser.cjs` phần `cut` đạt.
- [x] `#xa-vai-code` (XẢ VẢI) — ô tự tra khi đủ 16 số hoặc đủ mã RFID, ô mét nhận mã quét tiếp, thẻ UID có dòng RFID; phần `relax` + `xa_vai_a4_browser` (cả tệp) đạt.
- [x] `#cap-vai-code` (CẤP VẢI) — `rfid_resolve_browser.cjs` phần `issue` đạt.
- [x] `#vr-code` (TRẢ NCC) — `rfid_resolve_browser.cjs` phần `vendorReturn` đạt.
- [x] `#uc-code` (CHUYỂN ĐỔI ĐƠN VỊ) — `rfid_resolve_browser.cjs` phần `converter` đạt.
- [x] Camera `PrintSkuScanUI.openGroupUid`: `check` nhận cả RFID; lớp camera trả mã thô, màn tự giải mã — `rfid_resolve_browser.cjs` phần `camera` đạt (camera giả: mã sai không nhận, RFID → ghi theo Group UID ở CẮT).
- [x] Test của từng màn thêm ca RFID (Supabase giả): `rfid_resolve_browser.cjs` 8 phần; `scan_field_standard_browser` và các test màn cũ chạy trong cả bộ.
- Ngoài phạm vi: đổi cách ghi dữ liệu theo RFID.

### Việc 4 — Tài liệu, review, phát hành · lead · [ ]
- [x] `docs/QUYET_DINH.md` mục RFID: bỏ "chỉ ở LỰA UID BLOCKED", ghi danh sách màn; `docs/PROJECT_MAP.md`: khối `rfid-resolve-script` ↔ test (04/11).
- [x] Codex một vòng (chỉ web, không SQL / Edge / Extension): vòng 1 đã lọc + sửa (xem Nhật ký); cả bộ `python scripts/run_tests.py` 144/144 PASS trong 527 s (`--jobs 4`) + `python scripts/commit_gate.py` ĐẠT (7 mục, 1 cảnh báo: tệp chưa theo dõi không soát).
- [ ] Không migration nên push `main` được ngay sau commit (luật 4 chỉ cần thứ tự khi có hàm mới).
- [ ] Dòng nhắc commit kèm danh sách tệp khi xong.

## Phát sinh
- 04/11 Codex vòng 1 (xem Nhật ký): sửa 3 điểm trong phạm vi RFID; hai điểm CẮT (hàng đợi khi `busy`) và camera đổi đơn vị gọi tra hai lần là hành vi có sẵn, để sau · commit riêng nếu người dùng muốn.

## Lệch kế hoạch
- (chưa có)

## Nhật ký
- 2026-11-04 ~18:00 Cả bộ lần 1 (mã giữa chừng) 143/144: `vendor_return_browser` hỏng THẬT do (c) ở dòng dưới (TRẢ NCC từ chối mã tiền tố `PO-…`) → bỏ (c), chạy lại cả bộ trên mã cuối: 144/144 PASS 527 s, `commit_gate` ĐẠT. `sku_catalog_race_browser` / `sku_catalog_screens_browser` chập chờn lượt 1 của bộ giữa chừng (đạt lượt 2), lượt cuối không hỏng. Chưa chạy Codex vòng 2 (phần sửa nhỏ, có test đỏ → xanh).
- 2026-11-04 ~17:40 Làm tiếp theo lời người dùng. Chạy lại 8 phần test (đạt), thêm test camera, đo Supabase (Việc 1c), cập nhật QUYET_DINH + PROJECT_MAP, Codex vòng 1 (7 phát hiện): SỬA (a) IN TEM xoá ô ngay khi nhận mã, lỗi / trùng trả mã về ô nếu ô còn trống (hai RFID liên tiếp không nối nhau), (b) CHUYỂN ĐỔI ĐƠN VỊ thêm `lookupSeq` (RFID tra chậm không ghi đè lượt mới), (c) ĐÃ THỬ rồi BỎ: `PrintSkuRfid.uid` trả đúng 16 số khi chuỗi có Group UID — làm hỏng quy tắc TRẢ NCC "mã có tiền tố không hợp lệ" (`vendor_return_browser` đỏ), nên trả nguyên chuỗi như trước, mỗi màn tự xét độ chặt, (d) XẢ VẢI xoá ô quét ngay khi tra bắt đầu (lỗi trả mã về ô); BỎ QUA có lý do: CẮT mất lượt quét thứ hai khi `busy` (hành vi có sẵn với UID, ô giữ mã khi lỗi là quyết định đã chốt), camera CHUYỂN ĐỔI ĐƠN VỊ tra hai lần (hành vi có sẵn của `check` + `onCode`), CẮT giữ thẻ thành công cũ khi RFID lỗi (như mọi lỗi khác). Test đỏ trước cho (a)–(d) rồi xanh.
- 2026-11-04 16:30 Người dùng chốt 6 màn rồi bảo tạm dừng. Đã làm: khối `<script id="rfid-resolve-script">` (trước `uid-block-script`), `uid-block-script` dùng khối chung, nối 6 ô quét, `check` của camera nhận mã RFID (chưa có test camera). Test: `rfid_resolve_browser.cjs` từng phần đạt, `uid_block_browser`, `xa_vai_a4_browser` đạt. CHƯA: cả bộ `run_tests.py`, `commit_gate`, Codex, QUYET_DINH / PROJECT_MAP, đo Việc 1, commit. Lưu ý: các hunk RFID nằm trong `index.html` cùng hunk pop-up xả vải (`lookupNow`, `renderUid`, `RFID_RE`) và hunk phiên "Đối chiếu phủ lot theo PO" — tách commit cẩn thận.
- 2026-11-04 Lập kế hoạch sau khi đọc: `uid-block-script` (`rfidOf`, `resolveRfid`), `group_uid_rfid_v1.sql` (`group_uid_by_rfid`), `docs/QUYET_DINH.md` mục RFID / Tiến độ A5000, danh sách ô quét (`scan_field_standard_browser`); đo Supabase chỉ đọc (số liệu ở mục Thiết kế). Chưa đo WMS trực tiếp.
