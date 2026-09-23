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
  "version": "0.5.0",
  "capabilities": ["sku:v1", "group_uid:v1", "fabric_relaxation:v1"]
}
```


## Fabric Relaxation v1

Áp dụng thêm `supabase/print_queue_v2_fabric_relaxation.sql` sau schema v1.
Job: `type: "fabric_relaxation"`, `templateVersion: 1`, `copies: 1..500`,
`payload: { "itemCode": "TEST-FABRIC-01" }`.
Mã hàng là chuỗi 1–40 ký tự `[0-9A-Za-z._-]`, giữ số 0 đầu.
Agent chỉ lấy job Fabric khi có capability `fabric_relaxation:v1`.
Ngày/Giờ/Lot không nằm trong payload và luôn để trống trên tem.
