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

## Khả năng agent

```json
{
  "version": "0.7.0",
  "capabilities": ["sku:v1", "group_uid:v1", "fabric_relaxation:v1", "fabric_relaxation:v2", "fabric_relaxation:v3"]
}
```


## Fabric Relaxation v1/v2

Áp dụng thêm `supabase/print_queue_v4_fabric_relaxation_handwritten.sql` sau schema v1, v2 hoặc v3.
Job: `type: "fabric_relaxation"`, `templateVersion: 1`, `copies: 1..500`,
`payload: { "itemCode": "TEST-FABRIC-01" }`.
Mã hàng là chuỗi 1–40 ký tự `[0-9A-Za-z._-]`, giữ số 0 đầu.
Agent chỉ lấy job Fabric khi có capability `fabric_relaxation:v1`.
Job v2: `type: "fabric_relaxation"`, `templateVersion: 2`, `copies: 1..500`,
`payload: { "itemCodes": ["TEST-FABRIC-01", "TEST-FABRIC-02"] }`.
Job v3: `type: "fabric_relaxation"`, `templateVersion: 3`, `copies: 1..500`,
`payload: { "handwritten": true }`. Tem v3 không nhận mã hàng từ frontend.
Mỗi tem có 1–5 mã; mỗi mã 1–40 ký tự `[0-9A-Za-z._-]` và giữ số 0 đầu.
Ngày/Giờ/Lot không nằm trong payload; chỉ có một bộ dùng chung bên dưới danh sách mã, mỗi mục một dòng trống.
Agent 0.7.0 vẫn quảng bá v1/v2 để xử lý an toàn các job cũ đang chờ.
