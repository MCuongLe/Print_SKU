# Rules — Inside PO Connector

## Object → Field → Value → Rule → OK/NG

| Object | Field | Value source | Rule | Result |
| --- | --- | --- | --- | --- |
| PO | `poCode` | Người dùng nhập/quét | 3–50 ký tự; chỉ chữ, số và `._/-` | Sai định dạng → NG |
| PO | `warehouse` | Inside | Phải chứa `WH - MATERIAL - MTG` | Khác kho → NG |
| PO item | `sku` | Inside | Không rỗng | Rỗng → bỏ dòng |
| PO item | `name` | Inside | Không rỗng | Rỗng → bỏ dòng |
| PO item | `orderedQty` | Inside | Số lớn hơn 0 | Không hợp lệ → bỏ dòng |
| PO item | `supplier` | Tên SKU | Ưu tiên trường thứ 2; lấy phần sau dấu `_`, hoặc phần tên sau mã và khoảng trắng | Không chắc chắn → cho sửa tay |
| PO item | `colour` | Tên SKU | Ưu tiên trường thứ 5; bỏ mã màu/Pantone/SBD ở cuối; chặn Tex, size, gsm và đơn vị | Không chắc chắn → cho sửa tay |
| PO item | `unit` | Tên SKU hoặc dữ liệu Inside | Chuẩn hóa `yard`, `pcs`, `m`, `kg`, `cuộn`; nếu không có thì lấy trường cuối trong tên SKU | Không nhận diện được → mặc định `pcs` |
| Inspection | `sampleQty` | App | `min(lotQty, AQL sample)` | Lô 3 yard → kiểm 3 yard |

## Origin được phép

- `http://localhost/*`
- `http://127.0.0.1/*`
- `https://mcuongle.github.io/Print_SKU/*`
- `https://inside.mastige.vn/*`

Origin khác bị từ chối ở cả manifest, app bridge và background service worker.

## Bảo mật

- Connector chỉ đọc; không có thao tác ghi vào Inside.
- App không nhận cookie, token hoặc HTML gốc.
- Background chỉ chuyển yêu cầu `PING` và `GET_PO`.
- Không log nội dung PO vào console.

## Khi nào xem lại

- Inside đổi URL, HTML, bảng PO hoặc thứ tự cột SKU.
- App chuyển sang domain khác.
- Cho phép ghi kết quả ngược về Inside.
- Thay đổi kho áp dụng hoặc bảng AQL.
