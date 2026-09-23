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
  "version": "0.6.1",
  "capabilities": ["sku:v1", "group_uid:v1", "fabric_relaxation:v1", "fabric_relaxation:v2"]
}
```


## Fabric Relaxation v1/v2

Áp dụng thêm `supabase/print_queue_v3_fabric_relaxation_multi_item.sql` sau schema v1 hoặc v2.
Job: `type: "fabric_relaxation"`, `templateVersion: 1`, `copies: 1..500`,
`payload: { "itemCode": "TEST-FABRIC-01" }`.
Mã hàng là chuỗi 1–40 ký tự `[0-9A-Za-z._-]`, giữ số 0 đầu.
Agent chỉ lấy job Fabric khi có capability `fabric_relaxation:v1`.
Job v2: `type: "fabric_relaxation"`, `templateVersion: 2`, `copies: 1..500`,
`payload: { "itemCodes": ["TEST-FABRIC-01", "TEST-FABRIC-02"] }`.
Mỗi tem có 1–5 mã; mỗi mã 1–40 ký tự `[0-9A-Za-z._-]` và giữ số 0 đầu.
Ngày/Giờ/Lot không nằm trong payload; chỉ có một bộ dùng chung bên dưới danh sách mã, mỗi mục một dòng trống.
Agent 0.6.1 vẫn quảng bá v1 để xử lý an toàn các job cũ đang chờ. Bản sửa bố cục giữ nguyên payload và migration v3.
