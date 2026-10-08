# Thiết kế đồng bộ Group UID và dashboard đối chiếu

## 1. Mục tiêu

Giữ đồng thời hai luồng đồng bộ Group UID:

| Chế độ | Mục đích | Lịch đề xuất |
| --- | --- | --- |
| Thay đổi | Chỉ lấy Group UID được cập nhật sau lần thành công gần nhất | Mỗi 1–3 giờ |
| Toàn bộ | Đọc toàn bộ dữ liệu WMS để phát hiện UID thiếu, thừa hoặc sai lệch | Mỗi tuần và khi Admin yêu cầu |

Hai chế độ dùng chung quy trình kiểm tra, upsert, xác minh và lịch sử báo cáo. Đồng bộ toàn bộ không bị loại bỏ khi bổ sung đồng bộ thay đổi.

## 2. Nguyên tắc an toàn

- Lần chạy đầu tiên luôn là đồng bộ toàn bộ.
- Đồng bộ thay đổi dùng bộ lọc API WMS `from_updated_at` và `to_updated_at`.
- `from_updated_at` được lùi 30 phút so với mốc thành công gần nhất để tạo vùng chồng an toàn.
- `to_updated_at` được cố định ngay khi bắt đầu phiên, không thay đổi trong lúc phân trang.
- Mỗi trang lấy tối đa 500 Group UID và lấy tất cả trạng thái.
- Loại trùng theo `group_uid_code`; nếu một UID xuất hiện nhiều lần thì giữ bản có `updated_at` mới nhất.
- Giữ một dòng cha cho mỗi UID trong `group_uid_details`; toàn bộ SKU thành phần và số lượng được lưu trong `group_uid_products` để không mất dữ liệu khi một UID chứa nhiều SKU.
- Chỉ ghi dữ liệu nguồn mới hơn hoặc bằng `group_uid_details.updated_date`.
- Nguồn không trả sản phẩm nào thì giữ SKU và các dòng `group_uid_products` đã biết (v3); UID nhiều SKU để `group_uid_details.sku` trống.
- Không tự xóa UID vắng mặt trong nguồn. UID thiếu chỉ được đưa vào báo cáo đối chiếu.
- Chỉ cập nhật mốc đồng bộ sau khi lấy đủ trang, upsert và đọc lại Supabase thành công.
- Nếu phiên thất bại, giữ nguyên mốc cũ để lần sau tự lấy lại dữ liệu.
- Chỉ cho phép một phiên Group UID chạy tại một thời điểm.

## 3. Luồng đồng bộ thay đổi

```text
Admin hoặc lịch chạy
        ↓
Extension kiểm tra phiên WMS
        ↓
Đọc last_successful_incremental_at từ Supabase
        ↓
from = last_successful_incremental_at - 30 phút
to   = thời điểm bắt đầu phiên
        ↓
Gọi API WMS theo khoảng updated_at, 500 dòng/trang
        ↓
Chuẩn hóa + loại trùng + kiểm tra dữ liệu
        ↓
Edge Function đối chiếu với group_uid_details
        ↓
Tạo preview thay đổi
        ↓
Admin cập nhật hoặc chính sách tự động cho phép cập nhật
        ↓
Upsert + đọc lại xác minh
        ↓
Lưu báo cáo và cập nhật watermark = to
```

Không được dừng phân trang dựa trên thứ tự hiển thị của danh sách WMS. Danh sách hiện sắp theo mã Group UID và `updated_at` không hoàn toàn tuần tự.

## 4. Luồng đồng bộ toàn bộ

```text
Admin bấm “Đối chiếu toàn bộ” hoặc lịch chạy hàng tuần
        ↓
Đọc toàn bộ Group UID WMS, 500 dòng/trang
        ↓
Chuẩn hóa + kiểm tra tổng số dòng
        ↓
Đối chiếu toàn bộ với group_uid_details
        ↓
Phân loại: mới, thay đổi, không đổi, thiếu trên WMS, lỗi nguồn
        ↓
Tạo preview và cảnh báo
        ↓
Upsert các dòng mới/thay đổi nếu đạt ngưỡng an toàn
        ↓
Đọc lại xác minh và lưu báo cáo
```

Đồng bộ toàn bộ có hai mục đích:

1. Cập nhật dữ liệu mới hoặc thay đổi bị bỏ sót bởi luồng tăng dần.
2. Phát hiện bản ghi đang có trên Supabase nhưng không còn xuất hiện trong WMS.

Các UID không còn trong WMS không được tự động xóa. Dashboard hiển thị chúng trong nhóm **Thiếu trên WMS** để Admin kiểm tra.

## 5. Dashboard quản trị

### 5.1. Vị trí

Thêm mục **Đồng bộ Group UID** trong khu vực Quản trị, cùng cấp với **Đồng bộ SKU**.

Đường dẫn đề xuất:

```text
#admin/group-uid-sync
```

### 5.2. Khu vực điều khiển

```text
┌───────────────────────────────────────────────────────────────┐
│ Đồng bộ Group UID                         Extension WMS: Sẵn sàng │
├───────────────────────────────────────────────────────────────┤
│ Lần thành công gần nhất: 07/10/2026 08:45                    │
│ Mốc lấy thay đổi tiếp theo: 07/10/2026 08:35                 │
│                                                               │
│ [Kiểm tra thay đổi]        [Đối chiếu toàn bộ]                │
└───────────────────────────────────────────────────────────────┘
```

- **Kiểm tra thay đổi**: chạy preview theo watermark.
- **Đối chiếu toàn bộ**: đọc toàn bộ WMS, không làm mất luồng tăng dần.
- Hai nút chỉ tạo preview trước. Nút **Cập nhật Supabase** và **Hủy xem trước** nằm ở phần kết quả; hủy giải phóng khóa phiên ngay thay vì chờ 30 phút.
- Ô cảnh báo hiện khi xem trước: tổng UID giảm từ 2% (đối chiếu toàn bộ), có UID thiếu trên WMS, có UID nguồn cũ hơn database, hoặc trên 5.000 UID cập nhật. Chỉ cảnh báo, không chặn.
- Khi đang chạy, khóa cả hai nút để tránh hai phiên chồng nhau.

### 5.3. Thẻ tổng quan phiên hiện tại

| Thẻ | Ý nghĩa |
| --- | --- |
| UID nguồn | Số UID WMS trả về trong phạm vi của phiên |
| UID mới | Chưa tồn tại trong Supabase |
| UID cập nhật | Có ít nhất một trường thay đổi |
| Không đổi | Đã khớp Supabase |
| Thiếu trên WMS | Chỉ dùng khi đối chiếu toàn bộ |
| Lỗi nguồn | Thiếu mã, SKU, trạng thái hoặc ngày cập nhật không hợp lệ |

Bổ sung hàng trạng thái:

| Trạng thái | Nội dung |
| --- | --- |
| Chế độ | Thay đổi / Toàn bộ |
| Khoảng dữ liệu | `from_updated_at` – `to_updated_at` |
| Số trang | Số trang đã đọc / tổng số trang |
| Xác minh | Chờ cập nhật / Đã khớp / Có sai lệch |

### 5.4. Bảng chi tiết thay đổi

Admin bấm vào từng thẻ để lọc bảng. Bảng dùng dạng text đơn giản:

| Group UID | Loại thay đổi | Giá trị cũ | Giá trị mới | Cập nhật WMS |
| --- | --- | --- | --- | --- |
| 1028261006000050 | Số lượng | `7.200` | `7.429` | 07/10/2026 08:41 |
| 1028261006000049 | Trạng thái | `Available` | `Allocated` | 07/10/2026 08:40 |

Một UID thay đổi nhiều trường vẫn hiển thị trên một dòng. Cột giá trị dùng chuỗi dễ đọc:

```text
status: Available | qty: 7.200 | location: F0-KHO-HM-04-01-01
```

Các nhóm chi tiết:

- UID mới.
- UID cập nhật.
- UID thiếu trên WMS.
- Dòng lỗi nguồn.
- Dòng xác minh không khớp sau cập nhật.

### 5.4b. Công cụ trên danh sách (đã làm 08/10/2026)

Ô tìm (không dấu), lọc theo nhóm trường, sắp xếp, phân trang 50 dòng, xuất CSV, sao chép mã; mỗi dòng thay đổi hiện `cũ → mới` theo từng trường. Thanh cơ cấu và tab theo nhóm nằm trên bảng. Edge Function trả tối đa 1.000 dòng mỗi nhóm nên tìm/CSV chỉ trên phần đã tải.

### 5.5. Lịch sử đồng bộ

| Thời gian | Chế độ | Trạng thái | Phạm vi | Kết quả | Người chạy |
| --- | --- | --- | --- | --- | --- |
| 07/10 08:45 | Thay đổi | Hoàn tất | 08:05–08:45 | +12 · sửa 7 | admin |
| 06/10 23:00 | Toàn bộ | Có cảnh báo | 28.468 UID | thiếu 2 | lịch hệ thống |

Khi bấm một phiên lịch sử, dashboard tải lại đúng số liệu và chi tiết của phiên đó. Không phụ thuộc vào file tạm trên máy chạy extension.

### 5.6. Cảnh báo cần ưu tiên

Dashboard dùng màu trạng thái nhưng luôn kèm chữ:

| Mức | Điều kiện |
| --- | --- |
| Thành công | Upsert và xác minh đều khớp |
| Cảnh báo | Có UID thiếu trên WMS, dữ liệu bị từ chối hoặc biến động vượt ngưỡng |
| Thất bại | API lỗi, thiếu trang, upsert lỗi hoặc xác minh không khớp |
| Đang chạy | Phiên đã giữ khóa nhưng chưa hoàn tất |

## 6. Dữ liệu Supabase đề xuất

### 6.1. `group_uid_sync_runs`

| Cột | Nội dung |
| --- | --- |
| `id` | UUID phiên đồng bộ |
| `mode` | `incremental` hoặc `full` |
| `status` | `running`, `previewed`, `applying`, `completed`, `failed`, `expired` |
| `range_from` | Mốc bắt đầu lấy thay đổi; rỗng với full |
| `range_to` | Mốc kết thúc cố định của phiên |
| `source_count` | Tổng UID nguồn |
| `valid_count` | Tổng UID hợp lệ |
| `page_count` | Số trang đã đọc |
| `change_counts` | JSON số lượng theo nhóm |
| `verification` | JSON kết quả đọc lại Supabase |
| `error_message` | Lỗi cuối cùng nếu có |
| `created_by` | Admin hoặc lịch hệ thống |
| `created_at` | Thời điểm tạo |
| `completed_at` | Thời điểm hoàn tất |

### 6.2. `group_uid_sync_changes`

| Cột | Nội dung |
| --- | --- |
| `run_id` | Phiên đồng bộ |
| `group_uid_code` | Mã Group UID |
| `change_type` | `added`, `updated`, `missing`, `invalid`, `verification_failed` |
| `before_data` | JSON dữ liệu cũ |
| `after_data` | JSON dữ liệu mới |
| `changed_fields` | Danh sách trường thay đổi |
| `source_updated_at` | Thời gian cập nhật của WMS |

### 6.3. `group_uid_sync_state`

Chỉ cần một dòng trạng thái:

| Cột | Nội dung |
| --- | --- |
| `last_successful_incremental_at` | Watermark cho lần lấy thay đổi tiếp theo |
| `last_successful_full_at` | Lần đối chiếu toàn bộ gần nhất |
| `active_run_id` | Khóa chống chạy song song |
| `updated_at` | Thời điểm cập nhật trạng thái |

## 7. Edge Function và Extension

### Extension

- Đọc token từ phiên WMS đang đăng nhập.
- Gọi API WMS theo cấu hình Edge Function trả về.
- Không gửi access token WMS lên Supabase.
- Gửi từng lô dữ liệu đã chuẩn hóa, tối đa 500 UID.
- Báo tiến độ số trang về dashboard.

### Edge Function `group-uid-sync`

Các action đề xuất:

| Action | Chức năng |
| --- | --- |
| `prepare` | Tạo phiên, giữ khóa và trả về mode/range |
| `ingest` | Nhận một lô UID và ghi staging |
| `preview` | Đối chiếu staging với database |
| `apply` | Upsert và xác minh |
| `history` | Trả lịch sử phiên |
| `detail` | Trả chi tiết một phiên |
| `cancel` | Kết thúc phiên lỗi và giải phóng khóa |

Edge Function phải từ chối `apply` nếu:

- Chưa nhận đủ số trang.
- Có trang trùng hoặc thiếu.
- Preview đã hết hạn.
- Có phiên khác đang giữ khóa.
- Biến động vượt ngưỡng an toàn.

## 8. Ngưỡng an toàn đề xuất

| Kiểm tra | Ngưỡng ban đầu |
| --- | --- |
| Dữ liệu incremental rỗng | Hợp lệ nếu API trả tổng bằng 0 |
| Dòng lỗi nguồn | Dừng khi lớn hơn 0 |
| UID cập nhật trong một phiên incremental | Cảnh báo trên 5.000 |
| Tổng nguồn full giảm | Cảnh báo từ 2% |
| UID thiếu trên WMS | Không tự xóa; luôn yêu cầu kiểm tra |
| Sai lệch sau xác minh | Dừng và không cập nhật watermark |

Các ngưỡng nên lưu ở cấu hình server để có thể điều chỉnh mà không cần phát hành lại extension.

## 9. Trình tự triển khai

1. Tạo migration ba bảng theo dõi phiên, thay đổi và trạng thái.
2. Tạo Edge Function `group-uid-sync` với khóa phiên và staging.
3. Mở rộng extension để đọc API WMS theo khoảng thời gian và phân trang 500 dòng.
4. Thêm màn `#admin/group-uid-sync` vào giao diện quản trị.
5. Chạy full lần đầu và xác nhận tổng dữ liệu.
6. Chạy incremental trong một tuần, mỗi ngày kiểm tra chéo với full ở chế độ preview.
7. Sau khi ổn định, chuyển full sang lịch hàng tuần và giữ nút chạy thủ công trên dashboard.

## 10. Tiêu chí hoàn tất

- Incremental chỉ tải các UID trong khoảng thời gian được ghi trên dashboard.
- Full vẫn đọc và đối chiếu toàn bộ dữ liệu WMS.
- Hai chế độ cho cùng kết quả với các UID nằm trong phạm vi kiểm tra.
- Không mất watermark khi phiên thất bại.
- Không có hai phiên chạy đồng thời.
- Admin xem được dữ liệu cũ, dữ liệu mới và trường đã thay đổi của từng UID.
- Mọi phiên đều có lịch sử và kết quả xác minh đọc lại từ Supabase.
- File tạm chỉ được dọn sau khi phiên đã xác minh thành công.
