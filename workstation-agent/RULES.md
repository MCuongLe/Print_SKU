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
- Chỉ một bản agent chạy cùng lúc (khóa `temp\agent.lock`). Khóa được "chạm" mỗi vòng quét; bản mới tự chiếm lại khóa nếu tiến trình chủ không còn HOẶC khóa quá 3 phút không được chạm (bao gồm trường hợp máy tắt đột ngột khiến PID cũ bị cấp lại) — không cần xóa khóa thủ công.

## Vận hành

- Template nằm trong `src/templates`, không trích xuất từ HTML lúc chạy.
- Giấy in là khổ 2 tem mỗi hàng; render phải trải phẳng mọi tem của lệnh (kể cả batch nhiều SKU/Group UID khác nhau) rồi ghép 2 tem liền kề vào một hàng, không được để trống tem bên phải trừ hàng cuối khi tổng lẻ.
- Tem SKU xếp: Tên SP ở trên cùng (tối đa 7 dòng, 22 ký tự/dòng) → mã QR canh giữa, đặt ngay dưới khối tên (`y = max(170, 34 + số_dòng*25 + 14)`) nên tên dài đẩy QR xuống chứ không đè → số SKU in đậm dưới QR → vạch kẻ, số lượng (trái, tự thu nhỏ font theo độ dài) và ngày (phải) ở cuối tem. QR chứa số SKU, mức sửa lỗi M, dùng `qrcode-generator`. Không còn barcode Code 128 trên tem SKU.
- Tem Group UID vẫn dùng Code 128: tên sản phẩm 26 ký tự mỗi dòng, tối đa 7 dòng khi không SKU, 6 dòng khi có SKU (vùng SKU bắt đầu y=332); không để tên tràn vào vạch kẻ hoặc vùng SKU.
- Mã QR phải quét ra đúng số SKU; kiểm chứng bằng cách render preview rồi decode lại (ví dụ jsQR) trước khi phát hành.
- Bitmap TSPL dùng cực `0 = chấm đen`, `1 = nền trắng`; không đảo lại nếu chưa in thử trực tiếp trên máy TSC.
- Độ đậm mặc định `LABEL_DENSITY=12` (thang 0–15); chỉnh theo máy in thật qua `config\.env`, không sửa code.
- `preview` và `dry-run` tuyệt đối không gọi máy in.
- Chỉ lệnh `service` mới được phép nhận và in job.
- Chưa xác nhận vật lý tem đã ra giấy nếu chỉ có phản hồi WritePrinter; cần kiểm tra thêm trạng thái spooler và máy in.
- **Trên TSC PE200, spooler đẩy thẳng byte ra cổng USB: job khoẻ biến mất trước nhịp quét đầu, chỉ khi máy kẹt (hết giấy, bung nắp) job mới nằm lại hàng đợi.** Đã đo trực tiếp ngày 17/09: job 27 không hề xuất hiện trong `Get-PrintJob` dù máy in bình thường, trong khi job 4 và 5 lúc hết giấy thì nằm lại cả chục phút. Do đó ba nhánh kết luận:
  - thấy job rồi nó biến mất → in xong, `spoolConfirmed = true`
  - thấy job nhưng số trang đứng yên quá `SPOOL_STALL_MS` → `PRINTER_STALLED` (đây là nhánh bắt được hết giấy)
  - không bao giờ thấy job → **bình thường, không phải lỗi**, nhưng cũng không chứng minh được tem đã ra giấy: hoàn tất với `spoolConfirmed = false`
- Không được biến "thiếu bằng chứng" thành lỗi cứng: bản 0.3.6 báo `SPOOLER_JOB_MISSING` cho mọi lệnh và chặn đứng sản xuất. Muốn siết thì bật `SPOOL_REQUIRE_CONFIRM=true`, chỉ dùng cho máy in thật sự để lộ job trong hàng đợi.
- Cũng không được coi "không thấy job" là "đã in xong" như bản ≤ 0.3.5: lệnh 136 tem báo hoàn tất sau 9 giây y hệt lệnh 2 tem, và ngày 17/09 mất dấu 114 tem vì thế. `spoolConfirmed` tồn tại để nói thẳng ra chỗ không biết, thay vì đoán về một trong hai phía.
- Job ở trạng thái `Retained` (hàng đợi giữ lại bản ghi sau khi in) tính là đã in xong, vì nó không bao giờ tự biến mất.
- Số trang đã in phải nhúc nhích; đứng yên quá `SPOOL_STALL_MS` (mặc định 120 giây) thì báo `PRINTER_STALLED` kèm `pagesPrinted`. Mọi lỗi in phải mang theo `pagesPrinted` khi biết, vì đó là manh mối duy nhất để biết in lại từ tem nào.
- Tiến độ trang được ghi vào `print_events` (stage `spooling`, kèm `pagesPrinted`) trong lúc in, không đợi tới lúc kết thúc.
- `SPOOL_TIMEOUT_MS` mặc định 900 giây. Không đặt thấp: 100 tem chạy vài phút, bản cũ để 45 giây là quá ngắn cho lệnh thật.
- Driver TSC PE200 **không** báo lỗi vật lý về Windows: lúc máy sáng đèn đỏ, `Win32_Printer` vẫn trả `PrinterStatus=3` (Idle) và `DetectedErrorState=0`. Đừng tin trạng thái máy in của Windows để kết luận máy khoẻ; chỉ dùng nó để phát hiện lỗi khi nó có báo.

## Mức bằng chứng

- N2: validator và unit test.
- N3: PNG preview và TSPL dry-run.
- N4: spooler nhận đủ byte, job rời hàng đợi sau khi đã được nhìn thấy, số trang có tiến triển, trạng thái trước/sau không lỗi.
- N5: người vận hành quét được barcode trên tem thật — CHƯA VERIFY.

Từ 0.3.6, N4 mới thật sự là N4. Trước đó agent báo hoàn tất ngay khi spooler nhận byte, nên mọi sự cố vật lý (hết giấy, kẹt, bung nắp) đều vô hình và lệnh vẫn ghi `completed`.

## Khi nào xem lại

Xem lại khi đổi khổ giấy, máy in, barcode, queue contract, thời hạn lease hoặc nội dung một trong hai template.
