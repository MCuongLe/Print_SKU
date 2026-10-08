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
| SKU | `sku`, `product_name`, `category_id`, `status` | Inside `/sales/product` | Thuộc đúng 1 trong 7 category được quản lý; mã và tên không rỗng | Sai cấu trúc hoặc trùng mã → NG, dừng xem trước |
| Combo link | `combo_sku`, `normal_sku`, `quantity` | Inside `/sales/product/combo` | Tách đủ từng thành phần trong `Combo A=B+C`; nếu không ghi số lượng thì mặc định 1. Hai đầu quan hệ có category trong database | Ngoài phạm vi → bỏ qua; dữ liệu nguồn dưới 1.000 dòng → NG. Dòng mô tả sai dạng hoặc thành phần không đọc được → báo `sourceIssues`, không bỏ lặng lẽ |
| Sync run | `changes`, `status`, `verification` | Edge Function `sku-sync` | Admin xem trước rồi mới áp dụng; tối đa 2.000 dòng ghi mỗi nhóm | Vượt ngưỡng hoặc đọc lại không khớp → NG |
| Group UID | Mã, SKU, số lượng, trạng thái, `updated_date` | WMS `/api/v1/wms/group-uid-infos` | Mã 6–40 chữ số; số lượng không âm; trạng thái và ngày cập nhật bắt buộc | Sai một dòng → NG, dừng phiên |
| Group UID sync run | `mode`, khoảng thời gian, trang, thay đổi, xác minh | Edge Function `group-uid-sync` | Incremental lùi watermark 30 phút; full đọc toàn bộ; 500 dòng/trang; chỉ một phiên hoạt động | Thiếu trang, lệch tổng hoặc xác minh sai → NG, không cập nhật watermark |

## Origin được phép

- `http://localhost/*`
- `http://127.0.0.1/*`
- `https://mcuongle.github.io/Print_SKU/*`
- `https://inside.mastige.vn/*`
- `https://wms.inshasaki.com/*`
- `https://wms-gw.inshasaki.com/*`

Origin khác bị từ chối ở cả manifest, app bridge và background service worker.

## Bảo mật

- Connector chỉ đọc; không có thao tác ghi vào Inside hoặc WMS.
- App không nhận cookie, token hoặc HTML gốc.
- Background chỉ chuyển các yêu cầu đọc `PING`, `PING_WMS`, `GET_PO`, `GET_SKU_SYNC_DATA` và `GET_GROUP_UID_PAGE`.
- Access token WMS chỉ đi giữa tab WMS và extension, không được gửi tới ứng dụng hoặc Supabase.
- Extension không chứa Supabase secret/service-role key. Dữ liệu được gửi tới Edge Function bằng phiên Supabase Admin đang đăng nhập.
- Không tự xóa SKU hoặc quan hệ Combo vắng mặt trong nguồn.
- Không tự xóa Group UID vắng mặt trong WMS; full sync chỉ báo `missing`.
- Dữ liệu Group UID cũ hơn `updated_date` trong Supabase không được ghi đè.
- Staging và dấu trang được xóa ngay khi hoàn tất hoặc hủy; dữ liệu bỏ dở quá 7 ngày được dọn khi tạo phiên mới. Báo cáo thay đổi và lịch sử vẫn được giữ.
- Không log nội dung PO vào console.

## Khi nào xem lại

- Inside đổi URL, HTML, bảng PO hoặc thứ tự cột SKU.
- WMS đổi URL API, tên header xác thực hoặc cấu trúc `products`.
- App chuyển sang domain khác.
- Cho phép ghi kết quả ngược về Inside.
- Thay đổi kho áp dụng hoặc bảng AQL.
