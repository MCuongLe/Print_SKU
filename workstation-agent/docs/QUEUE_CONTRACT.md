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

## Khả năng agent

```json
{
  "version": "0.1.0",
  "capabilities": ["sku:v1", "group_uid:v1"]
}
```
