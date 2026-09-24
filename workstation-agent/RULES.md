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
| Group UID label | `lot` | Trống hoặc tối đa 20 ký tự | Không bắt buộc; bỏ trống thì không vẽ dòng LOT | OK cả khi trống |
| Group UID label | `roll` | Trống hoặc tối đa 20 ký tự | Không bắt buộc; bỏ trống thì không vẽ dòng ROLL | OK cả khi trống |
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
- Tem SKU xếp: Tên SP ở trên cùng (tối đa 8 dòng, 22 ký tự/dòng — tăng từ 7 ngày 24/09/2026 để tên dài hiển thị trọn vẹn thay vì bị cắt) → mã QR canh giữa, đặt ngay dưới khối tên (`y = max(170, 34 + số_dòng*25 + 10)`) nên tên dài đẩy QR xuống chứ không đè → số SKU in đậm dưới QR (`+28`) → vạch kẻ (`+16`), số lượng (trái, tự thu nhỏ font theo độ dài) và ngày (phải) cùng hàng ở cuối tem (`+28`). Ba khoảng đệm QR→SKU/SKU→vạch kẻ/vạch kẻ→ngày đã thu hẹp từ 36/18/42 xuống 28/16/28 để nhường đúng phần đó cho dòng tên thứ 8 mà tên 8 dòng vẫn còn ~17 dot lề dưới cùng, không tràn mép tem — đã kiểm chứng render + decode jsQR cho cả ba trường hợp 1/7/8 dòng. QR chứa số SKU, mức sửa lỗi M, dùng `qrcode-generator`. Không còn barcode Code 128 trên tem SKU.
- Tem Group UID in `LOT` (canh trái x=12) và `ROLL` (canh phải x=308) ở đáy tem, y=452 — dưới barcode SKU kết thúc ở y=418, đúng chỗ người vận hành vẫn ghi bút. Trường nào trống thì không vẽ, tem giữ nguyên bố cục cũ. Hai trường này chỉ có ở tab gán tay của `PRINT UID`.
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
- **Chính sách vận hành: ưu tiên in tiếp được.** Máy kẹt giữa chừng thì Windows vẫn giữ nguyên job trong hàng đợi và in nốt khi máy sống lại, nên agent phải kiên nhẫn chứ không được bỏ cuộc. Máy báo lỗi hoặc không đọc được trạng thái đều KHÔNG phải lý do dừng ngay — chỉ đầu hàng khi kéo dài quá `SPOOL_STALL_MS` (mặc định 600 giây). Đồng hồ đếm ngược reset mỗi khi in thêm được một trang, nên máy sống lại lúc nào là tiếp tục lúc đó, không phải chờ hết 10 phút.
- Trong lúc chờ, agent phải **đập nhịp gia hạn lease mỗi 30 giây** (`onHeartbeat` → `queue.progress`). Lease chỉ được gia hạn khi báo tiến độ, mà chờ thay giấy thì số trang đứng yên; không có nhịp này thì lease 120 giây hết hạn, backend trả lệnh về `queued` và agent in lại lần hai — trùng tem, đúng thứ chính sách này muốn tránh.
- `SPOOL_TIMEOUT_MS` (mặc định 3600 giây) phải rộng hơn `SPOOL_STALL_MS` nhiều lần, nếu không lệnh sẽ chết vì trần tổng trước khi kịp dùng hết kiên nhẫn.
- Khi máy in hết giấy giữa chừng, **không được xoá job trong spooler**. Lắp giấy, đóng nắp, bấm FEED là in tiếp phần dở. Ngày 17/09 đã xoá job 4 và 5 nên mất hẳn 114 tem, phải tạo lệnh mới. Chỉ xoá khi chủ động quyết định bỏ phần dở để in lại từ đầu, và phải ghi lại UID cuối cùng đã ra giấy trước khi xoá.
- Không được biến "thiếu bằng chứng" thành lỗi cứng: bản 0.3.6 báo `SPOOLER_JOB_MISSING` cho mọi lệnh và chặn đứng sản xuất. Muốn siết thì bật `SPOOL_REQUIRE_CONFIRM=true`, chỉ dùng cho máy in thật sự để lộ job trong hàng đợi.
- Cũng không được coi "không thấy job" là "đã in xong" như bản ≤ 0.3.5: lệnh 136 tem báo hoàn tất sau 9 giây y hệt lệnh 2 tem, và ngày 17/09 mất dấu 114 tem vì thế. `spoolConfirmed` tồn tại để nói thẳng ra chỗ không biết, thay vì đoán về một trong hai phía.
- Job ở trạng thái `Retained` (hàng đợi giữ lại bản ghi sau khi in) tính là đã in xong, vì nó không bao giờ tự biến mất.
- Số trang đã in phải nhúc nhích; đứng yên quá `SPOOL_STALL_MS` (mặc định 600 giây) thì báo `PRINTER_STALLED` kèm `pagesPrinted`. Mọi lỗi in phải mang theo `pagesPrinted` khi biết, vì đó là manh mối duy nhất để biết in lại từ tem nào.
- Tiến độ trang được ghi vào `print_events` (stage `spooling`, kèm `pagesPrinted`) trong lúc in, không đợi tới lúc kết thúc.
- Driver TSC PE200 **không** báo lỗi vật lý về Windows: lúc máy sáng đèn đỏ, `Win32_Printer` vẫn trả `PrinterStatus=3` (Idle) và `DetectedErrorState=0`. Đừng tin trạng thái máy in của Windows để kết luận máy khoẻ; chỉ dùng nó để phát hiện lỗi khi nó có báo.

## Mức bằng chứng

- N2: validator và unit test.
- N3: PNG preview và TSPL dry-run.
- N4: spooler nhận đủ byte, job rời hàng đợi sau khi đã được nhìn thấy, số trang có tiến triển, trạng thái trước/sau không lỗi.
- N5: người vận hành quét được barcode trên tem thật — CHƯA VERIFY.

Từ 0.3.6, N4 mới thật sự là N4. Trước đó agent báo hoàn tất ngay khi spooler nhận byte, nên mọi sự cố vật lý (hết giấy, kẹt, bung nắp) đều vô hình và lệnh vẫn ghi `completed`.

## Khi nào xem lại

Xem lại khi đổi khổ giấy, máy in, barcode, queue contract, thời hạn lease hoặc nội dung một trong hai template.


## Fabric Relaxation (23/09/2026)

- Nguồn yêu cầu: ảnh tem xả vải và chỉ đạo dùng cùng giấy/agent SKU, UID.
- Object: lệnh in `fabric_relaxation:v1`; mã hàng nhập tay, chưa đối chiếu danh mục (N3).
- Mã hàng: 1–40 ký tự chữ/số/chấm/gạch ngang/gạch dưới; giữ số 0 đầu. Rỗng hoặc ký tự khác: NG, chặn in.
- Số tem: số nguyên 1–500; ngoài phạm vi: NG. Giới hạn kế thừa hàng đợi hiện có.
- Tem 40 × 60 mm; 2 cột, khe ngang 2 mm, khe hàng 3 mm, 8 dot/mm, cùng renderer TSPL SKU/UID.
- Ngày, Giờ, Lot luôn là dòng chấm trống; không điền thời gian hệ thống hoặc dữ liệu Lot.
- Mã dài chia dòng mỗi 16 ký tự, tối đa 3 dòng; font monospace để không cắt mã rộng.
- Gửi qua PrintSkuQueue; khi lỗi mạng giữ nonce cho cùng dữ liệu để thử lại không tạo job trùng.
- Agent cũ không claim Fabric; cần migration v2 và agent 0.5.0. Giữ nguyên cơ chế quyền, lease và spooler hiện có.
- CHƯA VERIFY: chất lượng trên máy in vật lý, căn tem và độ đậm với cuộn giấy thực tế. Xem lại khi đổi giấy, driver, máy in hoặc quy tắc mã hàng.

### Fabric Relaxation v2 — nhiều mã trên một tem

- Payload v2 là `itemCodes`: mảng 1–5 mã, mỗi mã 1–40 ký tự hợp lệ.
- Payload v3 là `{handwritten:true}`; frontend chỉ nhập số tem. Mã hàng và Lot để trống ghi tay, Lot dưới Mã hàng cách khoảng hai dòng; Ngày là `..... / .....`, Giờ là `..... : .....`; các nhãn dùng cỡ chữ 28.
- Mỗi mã in đúng một dòng, xếp liên tiếp ở trên; chỉ một bộ Ngày/Giờ/Lot dùng chung phía dưới, mỗi mục một dòng trống.
- Agent 0.7.0 thêm bố cục v3 viết tay hoàn toàn; vẫn giữ capability v1/v2 để xử lý job cũ.
- Hàng đợi phải dùng migration v3 để agent 0.5.0 không claim job v2.
- CHƯA VERIFY: độ rõ và khoảng ghi tay khi in năm mã trên cuộn tem thực tế.
