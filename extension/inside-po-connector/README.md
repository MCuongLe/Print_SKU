# HASAKI Inside PO Connector

Tiện ích Chrome chỉ đọc, dùng phiên Inside/WMS đã đăng nhập để lấy PO/SKU, dữ liệu SKU/Combo và Group UID cho Print SKU.

## Người dùng có phải tự cài không?

Có. Chrome không cho một website tự cài extension. Với bản nội bộ trong repo, mỗi máy chỉ cần cài một lần:

1. Tải hoặc clone repository `Print_SKU` về máy.
2. Mở `chrome://extensions`.
3. Bật **Chế độ dành cho nhà phát triển / Developer mode**.
4. Chọn **Tải tiện ích đã giải nén / Load unpacked**.
5. Chọn đúng thư mục `extension/inside-po-connector`.
6. Tải lại tab Inside, tab WMS và tab Print SKU.

Sau khi repository được cập nhật, mở `chrome://extensions` và bấm **Tải lại / Reload** trên tiện ích để nhận mã mới. Sau đó **tải lại các tab Inside và WMS đang mở**: script cầu nối đã nạp trong tab cũ không tự đổi, nên tab cũ vẫn chạy bản trước (ví dụ báo lỗi mạng thô "Failed to fetch" thay vì câu có thử lại).

## Cách sử dụng

1. Mở `https://inside.mastige.vn/` và đăng nhập.
2. Mở Print SKU tại một trong các địa chỉ được phép:
   - `http://localhost:<port>/#inspection`
   - `http://127.0.0.1:<port>/#inspection`
   - `https://mcuongle.github.io/Print_SKU/#inspection`
3. Nhập mã PO và bấm **Lấy từ Inside**.

Đồng bộ SKU dành cho Admin:

1. Mở tab Inside và đăng nhập.
2. Vào `#admin/sku-sync` trong Print SKU.
3. Bấm **Đọc Inside** để xem trước thay đổi (**Toàn bộ** để đối chiếu toàn bộ).
4. Xem danh sách SKU và quan hệ Normal–Combo, sau đó bấm **Cập nhật**.

Extension chỉ đọc Inside. Mọi ghi dữ liệu chạy trong Edge Function `sku-sync`, yêu cầu phiên Supabase có vai trò `admin` và luôn xác minh lại sau khi upsert.

Phiên bản 0.6.1 đọc đầy đủ Combo nhiều thành phần, Group UID hiện tại, lịch sử cắt Group UID và dữ liệu kiểm kê SKU từ WMS theo lô 500 dòng. Tồn kho kiểm kê dùng báo cáo `Stock Location` đã gộp theo SKU/vị trí và chỉ giữ `count_inbin > 0`, tránh tải hàng trăm nghìn dòng UID. Bản này hỗ trợ phản hồi WMS dạng `records/count`, Group UID trạng thái `New` chưa có SKU và Group UID chứa nhiều SKU. Các SKU thành phần được lưu trong `group_uid_products`.

Phiên bản 0.7.1 thêm lệnh chỉ đọc `GET_GROUP_UID_MOVES_PAGE` cho ô LỊCH SỬ GROUP UID: lịch sử `Transfer location` của mọi kho tài khoản được xem, 500 dòng/trang (WMS không lọc endpoint này theo `company-ids` nên chỉ cần một lượt đọc). Sau khi cập nhật extension phải Reload trong `chrome://extensions` và tải lại trang Print SKU.

Phiên bản 0.10.3: `GET_PACKING_LIST_PAGE` trả thêm `group_uid` cho mỗi cuộn (khoá `group_uid_code` của WMS, cột Group UID ở Packing List PO; chưa có UID → `null`, khoá luôn có). Tab Gán WMS của IN TEM GROUP UID chỉ gán tem cho cuộn chưa có Group UID; Extension cũ không trả khoá thì trang vẫn đếm mọi cuộn và nhắc cập nhật. Sau khi cập nhật phải Reload Extension rồi tải lại tab WMS và trang Print SKU.

Phiên bản 0.10.2: bộ đọc Group UID (`normalizeRow` trong `group-uid-sync-core.js`, dùng cho đồng bộ Group UID và Group UID theo PO) trả thêm `group_rfid_mapping` — mã RFID dán trên cuộn (WMS chỉ có khoá này khi UID đã gắn RFID; mã 1 chữ + 11 số). Chỉ nhận chuỗi 1–40 chữ/số, lưu viết hoa; thiếu khoá hoặc giá trị lạ → `null`. Cần chạy `supabase/group_uid_rfid_v1.sql` và deploy Edge `group-uid-sync` trước; sau khi Reload Extension tải lại tab WMS rồi chạy **Đối chiếu toàn bộ** Group UID một lần để nạp RFID. Bản này luôn gửi khoá `group_rfid_mapping` (kể cả `null` = WMS đã gỡ RFID → Supabase xoá theo); Extension cũ không gửi khoá nên Edge đánh dấu `group_rfid_known = false` và Supabase giữ RFID đang lưu.

Phiên bản 0.10.1: `GET_PO` trả thêm `lastModified` (cột LastModified của danh sách PO trên Inside, dạng `26-10-15|14:35` → `2026-10-15`; trang chi tiết PO không có ô này). Màn KIỂM TRA ĐẦU VÀO lấy ô Rcvd date / Ngày nhập từ trường này thay cho Delivery Date; Extension cũ chưa có `lastModified` thì web vẫn dùng Delivery Date như trước. Sau khi cập nhật lên 0.10.1 phải **Reload** Extension rồi tải lại tab Inside.

Phiên bản 0.10.0 thêm đồng bộ tự động cho SKU và Group UID, chạy ngầm trong service worker bằng `chrome.alarms`. Trang Options (`options.html`) có: **Phiên Admin** (đăng nhập email và mật khẩu Admin Supabase; phiên lưu trong `chrome.storage.local`, Extension tự gia hạn bằng refresh token, Edge Function vẫn kiểm vai trò Admin như cũ), **Máy này** (Tên máy bắt buộc, tối đa 40 ký tự, và công tắc bật trên máy này; chưa có tên máy thì công tắc bị khóa), **Trạng thái** (có tab WMS / Inside đang mở hay không, giờ lượt kế, dòng "Admin tạm dừng" khi Admin tắt ở web), **Lượt gần nhất** (SKU và Group UID, kèm nút **Chạy ngay** chọn Gia tăng hoặc Toàn bộ) và **Nhật ký** (50 dòng gần nhất: giờ, loại, chế độ, Đã áp dụng / Chờ Admin / Bỏ qua / Lỗi, thông điệp). Nhịp: gia tăng mỗi 30 phút; toàn bộ một lần mỗi ngày trong khung 07:30–11:00 giờ Việt Nam (đổi từ 00:00–05:00 ngày 17/10/2026 vì ban đêm không có tab WMS/Inside; migration `supabase/sync_auto_window_morning_v1.sql`) nếu lượt toàn bộ gần nhất, kể cả lượt bấm tay, đã quá 20 giờ. Không có kết nối thì bỏ qua. Chỉ chạy khi có tab Inside (SKU) hoặc tab WMS (Group UID) đang đăng nhập; không có thì bỏ qua và ghi "Bỏ qua" vào nhật ký, không cảnh báo. Tự áp dụng khi thay đổi ở mức "Vừa": Group UID không thiếu, không lỗi và thêm + sửa ≤ 3.000; SKU mới rời nhóm ≤ 20 (lượt toàn bộ tự lưu trữ các SKU này, `supabase/sku_missing_archive_v1.sql`), không Combo thừa, SKU sửa ≤ 500 và SKU mới ≤ 500; vượt ngưỡng thì lượt chuyển trạng thái `held` ("Chờ Admin" ở web và nhật ký): không chặn lượt sau, không hết hạn, Admin chạy lại tay để xem bản mới. Hai máy không chạy trùng nhờ khóa thuê 15 phút theo loại (tên thuê = tên máy + mã ngẫu nhiên của máy, gia hạn trong lúc chạy; mất khóa thì lượt bị hủy); Edge từ chối cập nhật tự động khi khóa không còn thuộc máy gọi. Nhiều máy cùng bật thì mỗi chu kỳ chỉ một máy chạy: sau khi một máy hoàn tất, máy khác tới lịch trong vòng nhịp − 2 phút sẽ bỏ qua với dòng "Máy khác vừa đồng bộ lúc …" (nút Chạy ngay không bị giãn cách). Nhịp Admin đặt ở web (15–180 phút) được Extension nhớ lại khi tạo alarm. Token WMS/Inside vẫn không rời tab. Sau khi cập nhật lên 0.10.0 phải **Reload** Extension rồi tải lại tab WMS và tab Inside.

Phiên bản 0.9.5: mỗi dòng Group UID của `GET_GROUP_UID_PAGE` (đồng bộ Group UID) có thêm `qc_status` = chuỗi `quality_control_status_name` của WMS (`Passed`, `Failed` hoặc giá trị khác WMS trả), `null` khi WMS không có trạng thái QC. Edge `group-uid-sync` lưu trường này vào `group_uid_details.qc_status` (migration `supabase/group_uid_qc_status_v1.sql` phải chạy trước khi deploy Edge); Extension cũ không gửi trường này thì giá trị đã lưu được giữ nguyên. Không có dữ liệu ghi lên WMS. Sau khi cập nhật phải Reload trong `chrome://extensions` và tải lại tab Inside/WMS cùng trang Print SKU.

Phiên bản 0.9.4 (review Codex): ô Modified trống cũng làm Extension quay về đọc toàn bộ Combo, và thứ tự được kiểm trên cả lô 8 trang đã tải trước khi dừng.

Phiên bản 0.9.3: lượt gia tăng của `GET_SKU_SYNC_DATA` đọc Combo theo Modified (dừng ở trang có dòng cũ hơn mốc lùi 24 giờ, trả `comboScope: "changed"` và `comboCutoff` dạng `YYYY-MM-DD HH:MM:SS`); nếu trang Combo không giảm dần theo Modified hoặc định dạng ngày khác thì đọc toàn bộ như cũ (`comboScope: "full"`). Lượt toàn bộ không đổi.

Phiên bản 0.8.2 thêm cờ `full: true` cho `GET_SKU_SYNC_DATA` (nút **Đối chiếu toàn bộ** ở `#admin/sku-sync`): đọc hết trang sản phẩm của từng nhóm hàng (6 trang song song, dừng ở trang không đủ 200 dòng hoặc trang lặp), không lọc theo Modified; kết quả mang `mode: "full"`. Không có cờ thì vẫn đọc theo mốc như cũ.

Phiên bản 0.8.4 thêm lệnh chỉ đọc `GET_PACKING_LIST_PAGE` cho Gán tự động ở IN TEM GROUP UID: Packing List PO của WMS (`inbound-packing-lists`), `purchaseOrders` (1–20 mã PO, lọc `purchase_order_numbers`), 500 dòng/trang. Mỗi dòng là một cuộn: `purchase_order`, `shipment`, `sku` (thường là Combo), `product_name`, `quantity` (kg), `code` (mã cuộn), `batch_code`, `status`, `delivery`. Trang tự đếm số cuộn theo SKU và đổi Combo sang Normal. Không có dữ liệu ghi. Sau khi cập nhật extension phải Reload trong `chrome://extensions` và tải lại trang Print SKU.

Phiên bản 0.8.3 thêm lệnh chỉ đọc `GET_GROUP_UID_NEW_PAGE` cho nút **Lấy từ WMS** ở IN TEM GROUP UID: Group UID trạng thái `New` (`status_ids=1`) của kho 1177 / 1339 (`warehouseIds`), 500 dòng/trang, kèm `from` / `to` nếu muốn thu hẹp theo mốc cập nhật (WMS cần đủ cả hai; thiếu `to` thì lấy giờ hiện tại). Mỗi dòng: `group_uid_code`, `warehouse_id`, `warehouse`, `type`, `created_by`, `created_at`, `updated_at`, `location`, `batch_code`, `roll_code`. Không có dữ liệu ghi; ngày tạo và người tạo do trang lọc. Sau khi cập nhật extension phải Reload trong `chrome://extensions` và tải lại trang Print SKU.

Phiên bản 0.8.1 mở rộng `GET_SKU_COUNT_INVENTORY_PAGE` cho màn RỦI RO LƯU TRỮ (Hàng chưa lên kệ): mỗi dòng tồn kèm `total` (tổng mọi trạng thái), `modified` (Modified date `updated_at`, mốc tính số ngày ở vị trí) và `created` (ngày tạo, dự phòng khi thiếu Modified date). Dòng In-BIN = 0 nhưng `total > 0` (hàng giữ chỗ) không còn bị bỏ khỏi kết quả mà trả `qty = 0`; Kiểm kê SKU vẫn chỉ tính dòng `qty > 0`. Sau khi cập nhật extension phải Reload trong `chrome://extensions`, tải lại trang Print SKU, rồi Admin đồng bộ lại Kiểm kê SKU để bản chụp có Modified date.

Phiên bản 0.9.2 thêm hai lệnh chỉ đọc cho chế độ Theo PO của tab Quét trong CẮT GROUP UID (`#cut-group-uid`): `GET_PO_GROUP_UID_PAGE` và `GET_PO_ASN_PAGE`, cùng nhận `{ purchaseOrder, page, size }` (số PO 6–40 chữ số, tối đa 500 dòng/trang). (1) `GET_PO_GROUP_UID_PAGE`: `group-uid-infos?processing_source_code=<PO>` với khoảng `from_updated_at` 01/01/2020 → ngày mai (WMS cần đủ cả hai đầu). Mỗi dòng như `GET_GROUP_UID_PAGE` (`group_uid_code` luôn là chuỗi, `batch_code` = Lot, `roll_code`, `sku` = SKU Normal, `qty` theo đơn vị SKU, `status`, `products`) kèm `purchase_order` và `source_type`; WMS trả UID của nguồn khác PO đã hỏi thì lệnh báo lỗi thay vì trộn dữ liệu. UID chưa nhận (không SKU, số lượng 0) và UID nhiều SKU vẫn được trả về để app tự loại. (2) `GET_PO_ASN_PAGE`: `asns?purchase_order_numbers=<PO>` (số nhiều; khoảng `from_date`/`to_date` rộng) → `asn_id`, `asn_number`, `type`, `status` (Received/Open…), `shipment`, `warehouse`, `created_at`. Cả hai trả `{ page, size, total, totalPages, rows, sourceRows, purchaseOrder, generatedAt }`. Không có dữ liệu ghi (không tạo Export job). Sau khi cập nhật phải Reload trong `chrome://extensions` và tải lại trang Print SKU.

Phiên bản 0.9.1 thêm lệnh chỉ đọc `GET_INTERNAL_TRANSFER` cho nút **Phiếu IT** ở IN TEM SKU: `{ number }` (số phiếu IT) → tìm đúng số phiếu bằng `internal-transfers?internal_transfer_numbers=` (không cần khoảng ngày, phiếu cũ vẫn tìm được; WMS trả phiếu khác số thì coi như không có), rồi đọc `transfer/internal-transfer-items/list-details?internal_transfer_id=` (WMS trả hết các dòng một lần, bỏ qua `size`). Trả về `number`, `id`, `status`, `type`, `fromWarehouse`, `toWarehouse`, `description`, `createdBy`, `createdAt`, `totalItems` và `items` (`sku`, `name`, `quantity` = số lượng của phiếu, không dùng `stock_out_quantity`; `unit` = `uom`, có thể rỗng). Không tìm thấy thì lỗi `INTERNAL_TRANSFER_READ_FAILED` "Không tìm thấy phiếu IT …". Không có dữ liệu ghi. Sau khi cập nhật phải Reload trong `chrome://extensions` và tải lại trang Print SKU.

Phiên bản 0.9.0 thêm hai nguồn chỉ đọc cho màn KIỂM SOÁT CÔNG TRÌNH (`#site-control`). (1) `GET_STOCK_IMPORT_EXPORT_PAGE`: báo cáo Import/Export của WMS (`/api/v2/wms/report-management/stock-import-exports`), `warehouseIds` + `companyId`, `from` / `to` (ISO hoặc mili giây; WMS cần đủ cả hai), 500 dòng/trang, mỗi trang kèm một lệnh `config_query=2` lấy tổng dòng nên mọi trang cùng báo một `totalPages`. Mỗi dòng: `sku`, `kind` (`in` = nhập, `out` = xuất), `qty`, `balance`, `sourceType`, `sourceCode`, `mappingId`, `reason`, `createdAt`. (2) `PING_HCM` và `GET_HCM_DATA` (`resource`: `stock` hoặc `wmsImports`): đọc app Hasaki Construction Management qua tab app đã đăng nhập (`hcm-bridge.js`, chạy trong `https://apps-mastige.inshasaki.com/apps/hasaki-construction-management*`). Cầu nối dùng cookie Cloudflare Access của tab và Bearer token app trong localStorage của chính tab đó, chỉ GET, chỉ hai đường dẫn cố định (`/api/stock`, `/api/wms-imports`), đọc 1.000 dòng/lượt; token không rời tab app. Manifest thêm quyền host `https://apps-mastige.inshasaki.com/*`. Sau khi cập nhật phải Reload extension trong `chrome://extensions` và tải lại trang Print SKU.

Cập nhật lịch sử Group UID (chỉ Admin):

1. Mở tab WMS và đăng nhập.
2. Vào trang chủ Print SKU, mở ô **LỊCH SỬ GROUP UID** và bấm biểu tượng khiên để đăng nhập Admin.
3. Bấm **Đọc WMS**: lần đầu lấy 365 ngày, các lần sau chỉ lấy phần mới (lùi 30 phút). Nút **Đọc lại 365 ngày** (biểu tượng đồng hồ) bên cạnh đọc lại toàn bộ 365 ngày.
4. Mọi nhân viên mở cùng ô đó (không cần đăng nhập) để lọc SKU, kho, vị trí và khoảng ngày.

Dashboard kiểm kê SKU dành cho Admin:

1. Mở tab WMS và đăng nhập bằng tài khoản có quyền trên cả Mastige và Hasaki Garment.
2. Vào `#admin/kiem-ke` trong Print SKU.
3. Bấm **Đọc WMS**.
4. Extension tự đọc `WH - MATERIAL - MTG` dưới công ty Mastige và chuyển header `company-ids` sang công ty Garment để đọc `WH - MATERIAL - GARMENT`; không thay đổi công ty đang chọn trên giao diện WMS.
5. Dashboard đối chiếu tồn kho `In-BIN`, `qty > 0` với kết quả kiểm kê SKU có trạng thái `APPROVED`, rồi chia nhóm chưa kiểm kê, trong 30 ngày và quá 30 ngày.

Nếu tài khoản thiếu quyền ở một công ty, dashboard vẫn hiện phần kho đọc được nhưng cảnh báo rõ kho còn thiếu; không được xem kết quả một kho là kết quả đủ hai kho.

Kiểm soát công trình dành cho Admin:

1. Mở hai tab: WMS (đăng nhập tài khoản có quyền kho `OFFICE - 130 AP CHANH - MTG`) và app Hasaki Construction Management (đã đăng nhập tài khoản app).
2. Vào ô **KIỂM SOÁT CÔNG TRÌNH** trên trang chủ Print SKU, bấm biểu tượng khiên để đăng nhập Admin rồi bấm **Đọc WMS**.
3. Extension đọc tồn và dòng nhập đã nạp của app xây dựng, tồn theo vị trí (`GET_SKU_COUNT_INVENTORY_PAGE`) và nhập xuất (`GET_STOCK_IMPORT_EXPORT_PAGE`) của kho WMS, từ ngày dòng nhập đầu tiên của app tới hiện tại. Kết quả chỉ nằm trong trình duyệt, không lưu lên Supabase.

Đồng bộ Group UID dành cho Admin:

1. Mở tab WMS và đăng nhập.
2. Vào `#admin/group-uid-sync` trong Print SKU.
3. Chọn **Đọc WMS** hoặc **Toàn bộ**.
4. Xem báo cáo rồi bấm **Cập nhật**.

Luồng thay đổi đọc chồng lại 30 phút. Luồng toàn bộ vẫn được giữ để tìm UID thiếu hoặc sai lệch. Access token WMS không rời extension.

Đối chiếu UID đã cắt:

1. Đăng nhập WMS bằng tài khoản có quyền xem **Group UID → History**.
2. Mở `#cut-group-uid`, chọn **4 · Đối chiếu** và bấm **Đọc WMS**.
3. Extension chỉ đọc kho `warehouse_id=1177` (**WH - MATERIAL - MTG**), nhận diện dòng Cut theo Note và gửi dữ liệu đã chuẩn hóa về ứng dụng.
4. Ứng dụng nạp vào Supabase bằng phiên Admin, lùi mốc lần trước 30 phút và loại trùng theo Group UID + thời gian Cut.

Nút **Nạp ZIP/XLSX** vẫn dùng được để đối chiếu toàn bộ hoặc khi API WMS tạm thời không khả dụng.

## Triển khai cho nhiều người

- Giai đoạn thử nghiệm: gửi repository và để từng máy dùng **Load unpacked**.
- Muốn người dùng bấm một lần để cài và tự cập nhật: phát hành extension qua Chrome Web Store, có thể để chế độ **Unlisted**.
- Máy do công ty quản lý: IT có thể cài bắt buộc bằng Chrome Enterprise Policy. Đây là cách phù hợp nhất nếu không muốn từng người tự cài.

Không thể tạo nút trên `index.html` để bỏ qua màn xác nhận cài đặt của Chrome.

## Bảo mật và phạm vi

- Chỉ đọc dữ liệu PO/SKU/Group UID; không ghi ngược vào Inside hoặc WMS.
- Token WMS chỉ được đọc tạm trong tab WMS để gọi API và không gửi tới Print SKU hoặc Supabase.
- App chỉ nhận dữ liệu đã chuẩn hóa: PO, kho, NCC, ngày giao và các dòng SKU.
- Extension không chứa Supabase secret/service-role key.
- Từ 0.10.0 Extension giữ phiên Admin Supabase riêng (email, mật khẩu chỉ gửi tới Supabase Auth; chỉ access/refresh token được lưu trong `chrome.storage.local`) để đồng bộ tự động; Đăng xuất ở trang Options xóa phiên.
- Chỉ kết nối với Inside, WMS và các địa chỉ Print SKU đã khai báo trong `manifest.json`.
- Import `.xls/.xlsx` vẫn là phương án dự phòng.

Nếu triển khai Print SKU trên domain khác, phải thêm domain đó đồng thời vào `manifest.json`, `background.js` và `app-bridge.js`.
