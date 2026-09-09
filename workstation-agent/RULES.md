# Quy tắc Agent in tem SKU và Group UID

## Phạm vi

Agent này thuộc ứng dụng Print SKU, cài độc lập tại `C:\PrintSKUAgent`. Agent không được đọc, gọi hoặc sửa bất kỳ file nào trong `C:\AuditFactory`.

## Object – Field – Value – Rule

| Object | Field | Value | Rule | OK/NG |
| --- | --- | --- | --- | --- |
| PrintJob | `type` | `sku` hoặc `group_uid` | Loại khác phải bị từ chối, không đoán template | OK nếu thuộc danh sách hỗ trợ |
| PrintJob | `nonce` | Chuỗi duy nhất | Một nonce chỉ được nhận một lần tại queue | NG nếu trùng |
| PrintJob | `copies` | 1–500 | Số nguyên dương | NG nếu ngoài giới hạn |
| SKU label | `sku` | ASCII tối đa 40 ký tự | Phải tạo được Code 128 | NG nếu không hợp lệ |
| Group UID label | `groupUid` | ASCII tối đa 40 ký tự | Phải tạo được Code 128 | NG nếu không hợp lệ |
| Group UID label | `sku` | Trống hoặc ASCII tối đa 40 ký tự | SKU không bắt buộc; chỉ vẽ barcode SKU khi có giá trị | NG nếu có nhưng sai định dạng |
| Group UID label | `productName` | Tên sản phẩm tối đa 180 ký tự | Bắt buộc; có thể tra theo SKU hoặc nhập tay | NG nếu trống |
| Group UID batch | `payload.items` | 1–100 dòng, mỗi dòng có `copies` 1–500 | Tổng `copies` các dòng phải bằng `copies` của lệnh | NG nếu lệch tổng hoặc dòng thiếu dữ liệu |
| Agent | lease | 30–900 giây | Queue phải trả lệnh về `queued` khi lease hết | OK ở backend Supabase, CHƯA VERIFY tình huống mất điện thật |
| Máy in | trạng thái trước/sau | ready/blocked | Không gửi khi blocked | NG nếu offline/hết giấy/lỗi |

## Bảo mật

- Chỉ nhận `PRINT_AGENT_TOKEN`; không dùng Supabase service-role key.
- Token chỉ nằm trong `C:\PrintSKUAgent\config\.env`, không commit và không đóng vào ZIP.
- Không ghi token, Authorization header hoặc payload bí mật vào log.
- Scheduled Task riêng là `Print SKU UID Agent`.

## Vận hành

- Template nằm trong `src/templates`, không trích xuất từ HTML lúc chạy.
- Giấy in là khổ 2 tem mỗi hàng; render phải trải phẳng mọi tem của lệnh (kể cả batch nhiều SKU/Group UID khác nhau) rồi ghép 2 tem liền kề vào một hàng, không được để trống tem bên phải trừ hàng cuối khi tổng lẻ.
- Tem SKU xếp theo thứ tự barcode → mã SKU → Tên SP; vùng số lượng và ngày giữ nguyên ở cuối tem.
- Tên sản phẩm 26 ký tự mỗi dòng, tối đa 7 dòng trên tem SKU và tem Group UID không SKU, 6 dòng trên tem Group UID có SKU (vùng SKU bắt đầu y=332); không được để tên tràn vào vạch kẻ hoặc vùng SKU.
- Bitmap TSPL dùng cực `0 = chấm đen`, `1 = nền trắng`; không đảo lại nếu chưa in thử trực tiếp trên máy TSC.
- Độ đậm mặc định `LABEL_DENSITY=12` (thang 0–15); chỉnh theo máy in thật qua `config\.env`, không sửa code.
- `preview` và `dry-run` tuyệt đối không gọi máy in.
- Chỉ lệnh `service` mới được phép nhận và in job.
- Chưa xác nhận vật lý tem đã ra giấy nếu chỉ có phản hồi WritePrinter; cần kiểm tra thêm trạng thái spooler và máy in.

## Mức bằng chứng

- N2: validator và unit test.
- N3: PNG preview và TSPL dry-run.
- N4: spooler nhận đủ byte, trạng thái trước/sau không lỗi.
- N5: người vận hành quét được barcode trên tem thật — CHƯA VERIFY.

## Khi nào xem lại

Xem lại khi đổi khổ giấy, máy in, barcode, queue contract, thời hạn lease hoặc nội dung một trong hai template.
