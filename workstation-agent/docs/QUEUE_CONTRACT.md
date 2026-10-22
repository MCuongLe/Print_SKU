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

```json
{
  "version": "0.10.1",
  "capabilities": ["sku:v1", "sku:v2", "group_uid:v1", "location:v1", "location:name-optional"]
}
```

`sku:v2` (0.10.1, 22/10/2026): tem Phụ liệu in ở KIỂM TRA ĐẦU VÀO — lệnh `type: "sku"`, `templateVersion: 2`, mỗi item thêm `po` (≤ 20 ký tự chữ, số, `. _ / -`, khoảng trắng) và `receivedDate` (`dd/mm/yyyy`), cả hai được để trống (khung để ghi bút); không in `quantity`. Sai mẫu thì từ chối cả lệnh. Hàng đợi chỉ giao lệnh v2 cho agent khai `sku:v2` (migration `print_sku_po_v1`), agent cũ để lệnh nằm chờ.


## Fabric Relaxation (đã bỏ từ agent 0.9.0)

Web đã gỡ màn TEM XẢ VẢI ngày 11/10/2026 và agent 0.9.0 không khai capability `fabric_relaxation:*` nữa, nên hàng đợi
không giao lệnh loại này. Máy chủ vẫn giữ CHECK và kiểm payload cho lệnh cũ (migration `print_queue_v2`–`v4` là lịch sử).
