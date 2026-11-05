# Queue contract v1

Backend chuẩn nằm ở `supabase/print_queue_v1.sql`. Agent gọi Supabase RPC qua HTTPS bằng publishable key; token agent riêng nằm trong tham số RPC và được đối chiếu bằng SHA-256 ở hàm `SECURITY DEFINER`. Không dùng service-role key trên máy trạm.

## Wrapper

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "updatedAt": "2026-09-08T00:00:00.000Z",
    "schemaVersion": 1
  }
}
```

## Actions

| Action | Mục đích |
| --- | --- |
| `agent_heartbeat` | Cập nhật trạng thái và capability của agent |
| `agent_claim` | Nhận tối đa một job kèm lease |
| `agent_progress` | Gia hạn lease và cập nhật `rendering`/`sending` |
| `agent_complete` | Chuyển job sang `completed` |
| `agent_fail` | Ghi lỗi có cấu trúc |
| `agent_requeue` | Trả job về hàng đợi khi máy in đang bị chặn |

## Lease

- `agent_claim` phải ghi `claimedAt`, `agentId` và `leaseExpiresAt` bằng giao dịch nguyên tử.
- Mỗi `agent_progress` gia hạn lease.
- Job `claimed`, `rendering` hoặc `sending` hết lease phải tự quay về `queued`.
- `nonce` phải unique để chống tạo hai job khi người dùng bấm lại.

## Lỗi mạng (agent 0.8.1)

- Lỗi mạng tạm thời (mất kết nối, DNS, quá 20 giây không phản hồi, HTTP 5xx/429) được thử lại sau 1s/2s/4s; lỗi nghiệp vụ (`ok:false`, ví dụ `LEASE_LOST`) không thử lại. `agent_claim` không thử lại vì vòng quét tự gọi lại.
- Mất mạng trước `sending`: agent gọi `agent_requeue` với `code: "NETWORK_UNSTABLE"`, không gọi `agent_fail`.
- Từ `sending` trở đi tem có thể đã ra giấy: lỗi mạng không bao giờ thành `agent_fail`. Agent ghi sổ tay `temp/sent-jobs.json`; nhận lại job còn trong sổ tay thì chỉ gọi `agent_complete` (`result.recoveredFromJournal: true`) hoặc `agent_fail` với `code: "SENT_UNCONFIRMED"`, không in lần hai.

## Đánh thức bằng Realtime (agent 0.8.4)

- Trigger `print_jobs_wake_agent` (supabase/print_queue_v5_realtime_wake.sql) phát Broadcast công khai topic `print-queue`, event `queued`, payload `{ jobId, type, copies, status }` mỗi khi một dòng `print_jobs` có `status = 'queued'` (insert, requeue, hết lease). Lỗi phát tín hiệu được nuốt — không bao giờ làm hỏng `print_enqueue`.
- Agent nghe topic bằng publishable key; nhận tin thì gọi `agent_claim` ngay. Ngoài ra vẫn gọi `agent_claim` dự phòng mỗi 20 giây khi rảnh (10 giây nếu chưa nối được Realtime), 1 giây/lần trong 120 giây sau mỗi lệnh. Tin là "đánh thức", không phải giao lệnh: lỡ tin chỉ làm chậm ≤ 20 giây.
- `last_seen_at` của agent vì thế có thể cách nhau 20 giây; web coi agent mất liên lạc khi quá 45 giây (trước là 15).
- Từ 0.8.5, `state.printer` gửi kèm `agent_claim` khi được đánh thức có thể là kết quả kiểm tra cũ tới 60 giây (chỉ khi máy đang sẵn sàng); nhịp định kỳ luôn gửi kết quả mới.

## Khả năng agent

Chế độ `label` (mặc định, máy tem TSC):

```json
{
  "version": "0.12.1",
  "capabilities": ["sku:v1", "sku:v2", "sku:v3", "group_uid:v1", "location:v1", "location:name-optional"]
}
```

Chế độ `a4` (`PRINTER_KIND=a4`, 0.11.0) — CHỈ một khả năng, không bao giờ nhận lệnh tem:

```json
{
  "version": "0.12.1",
  "capabilities": ["xa_vai_sheet:v1"]
}
```

`sku:v2` (0.10.1, 22/10/2026): tem Phụ liệu in ở KIỂM TRA ĐẦU VÀO — lệnh `type: "sku"`, `templateVersion: 2`, mỗi item thêm `po` (≤ 20 ký tự chữ, số, `. _ / -`, khoảng trắng) và `receivedDate` (`dd/mm/yyyy`), cả hai được để trống (khung để ghi bút); không in `quantity`. Sai mẫu thì từ chối cả lệnh. Hàng đợi chỉ giao lệnh v2 cho agent khai `sku:v2` (migration `print_sku_po_v1`), agent cũ để lệnh nằm chờ.

## Phiếu theo dõi xả vải `xa_vai_sheet` (agent 0.11.0, chế độ `a4`)

Bản 0.12.0 (máy chủ `xa_vai_a4_v2`, 05/11/2026) nhận thêm, đều tuỳ chọn và không đổi `templateVersion`: `payload.itNumbers` (mảng số phiếu IT 16 chữ số, barcode), và ở mỗi dòng `itNumber`, `fabricCode`, `color`, `unit`, `systemQty`, `actualQty` (số ≥ 0 theo đơn vị gốc hoặc null). Mọi dòng có khoá `unit` → mẫu mới (nhóm SKU, đơn vị gốc); thiếu → mẫu 0.11.0.
Bản 0.12.1 (máy chủ `xa_vai_a4_v3`) nhận thêm `payload.deviceName` (tên máy gửi lệnh, ≤ 60 ký tự, tuỳ chọn) — in trong ô "Người xả" của mẫu mới.

Lệnh: `type: "xa_vai_sheet"`, `templateVersion: 1`, `copies` 1–5 = số bản của **cả phiếu** (không phải số tem). Hàng đợi
chỉ giao cho agent khai `xa_vai_sheet:v1` (migration `xa_vai_a4_v1`).

```json
{
  "itemCode": "CWSH02",
  "productName": null,
  "printedAt": "2026-11-04T08:30:00.123456+00:00",
  "reprint": false,
  "items": [{ "groupUid": "1028260000000001", "sku": "900000001", "lot": "LOT-1", "roll": "1", "systemMm": 50000, "actualMm": 49500, "measuredAt": "2026-11-04T07:00:00Z" }]
}
```

- `itemCode` (CONTRACT V3) = **Mã hàng** (mã kiểu hàng nhập lúc in, khác SKU vải): bắt buộc, chuỗi đúng mẫu
  `^[0-9A-Z._-]{1,40}$` — máy chủ chuẩn hoá (viết hoa, bỏ khoảng trắng hai đầu) trước khi gửi, agent **không** sửa giúp; sai
  → từ chối cả lệnh. Không còn `sku` mức payload: `sku` nằm ở **từng dòng** (theo mẫu SKU của tem), một phiếu được nhiều SKU.
- `productName` tuỳ chọn: `null` / trống → không in dòng tên; có (máy chủ chỉ gửi khi cả phiếu một SKU) thì in
  `SKU <sku> · <tên>` dưới biển, dài quá cắt 180 ký tự. `printedAt`, `measuredAt` là ISO 8601
  **có múi giờ**; `items` 1–100; `groupUid` 1–40 ký tự ASCII; `lot`/`roll` cắt 40 ký tự (tem Group UID vẫn 20); số đo là
  **mm**: `actualMm` số hữu hạn, làm tròn về số nguyên 1–100000000 (≤ 100.000 m); `systemMm` `null` hoặc số hữu hạn, làm
  tròn ≥ 0. Trường `systemM`/`actualM` (mét) của bản nháp đầu đã bỏ — lệnh chỉ có chúng thì thiếu `actualMm` → từ chối.
  Sai bất kỳ → `INVALID_JOB`, không in phần nào.
- Biển lớn đầu mỗi trang: Mã hàng + `Xả dd/mm/yyyy` = ngày giờ Việt Nam (UTC+7) của `measuredAt`; nhiều ngày thì
  `Xả dd/mm – dd/mm/yyyy` (khác năm `Xả dd/mm/yyyy – dd/mm/yyyy`), từ ngày nhỏ nhất tới lớn nhất của cả phiếu.
  Biển chứa được ~16 ký tự; mã dài hơn bị cắt "…" trên biển thì phiếu in thêm `Mã hàng: <mã đầy đủ>` ở dòng ngay dưới
  biển (không cắt), trước `SKU … · tên`.
- Bảng phiếu: STT · Group UID · SKU · Lot · Roll · Hệ thống (mm) · Thực tế (mm) · Chênh lệch (mm) · Giờ nhập (không có cột
  độ co). Số in thẳng **mm nguyên**, nhóm nghìn dấu chấm (`60758` → `60.758`), không đổi sang mét. Chênh lệch =
  `actualMm − systemMm` (âm: `-2.734`); thiếu `systemMm` → "—".
- Dòng TỔNG (mm): tổng thực tế cộng mọi dòng; tổng hệ thống và chênh lệch chỉ tính trên các dòng có `systemMm`
  (chú thích "chênh lệch: n/m UID có mét hệ thống" khi có dòng thiếu).
- Chế độ máy in: `PRINTER_KIND` thiếu / rỗng = `label`; chỉ nhận `label` hoặc `a4` (không phân biệt hoa thường), giá trị
  khác thì agent không khởi động (ghi dòng ERROR vào `logs/agent.log`, thoát mã 1).
- Tiến độ `sending` gửi `{ pages, bytes }`; kết quả `complete`: `{ pages, copies, bytes, spoolJobId, pagesPrinted, spoolConfirmed, templateVersion }`.
  `spoolJobId` có thể `null` khi spooler không để lộ job (máy in chia sẻ qua mạng) → `spoolConfirmed: false`.
- Đã gửi xuống spooler mà mất kết nối: không in lại, báo `SENT_UNCONFIRMED` như tem.


## Fabric Relaxation (đã bỏ từ agent 0.9.0)

Web đã gỡ màn TEM XẢ VẢI ngày 11/10/2026 và agent 0.9.0 không khai capability `fabric_relaxation:*` nữa, nên hàng đợi
không giao lệnh loại này. Máy chủ vẫn giữ CHECK và kiểm payload cho lệnh cũ (migration `print_queue_v2`–`v4` là lịch sử).
