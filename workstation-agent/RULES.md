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
- Tem SKU xếp: Tên SP ở trên cùng (tối đa 8 dòng ở cỡ chữ mặc định 22, chia dòng theo bề rộng chữ THẬT khi đo được — xem mục "Đo chữ thật" bên dưới; lùi về đếm cố định 22 ký tự/dòng nếu không đo được) → mã QR canh giữa, đặt ngay dưới khối tên (`y = max(170, 34 + số_dòng*25 + 10)`) nên tên dài đẩy QR xuống chứ không đè → số SKU in đậm dưới QR (`+28`). Vạch kẻ (y=431) và hàng số lượng (trái, chữ thường) / ngày (phải) (chân chữ y=465, lề dưới 15 dot) CỐ ĐỊNH ở đáy tem từ 30/09/2026, không trôi theo số dòng tên — xem mục "Đáy tem SKU cố định" bên dưới. Tên 8 dòng cỡ 22 vẫn vừa: số SKU cách vạch kẻ tối thiểu 12 dot. (Trước 30/09/2026: vạch kẻ `+16` dưới SKU, ngày `+28` dưới vạch kẻ, cả khối trôi theo tên; đã kiểm chứng render + decode jsQR cho 1/7/8 dòng.) QR chứa số SKU, mức sửa lỗi M, dùng `qrcode-generator`. Không còn barcode Code 128 trên tem SKU.
- Tem Group UID in `LOT` (canh trái x=12) và `ROLL` (canh phải x=308) ở đáy tem, y=452 — dưới barcode SKU kết thúc ở y=418, đúng chỗ người vận hành vẫn ghi bút. Trường nào trống thì không vẽ, tem giữ nguyên bố cục cũ. Hai trường này chỉ có ở tab gán tay của `PRINT UID`.
- Tem Group UID vẫn dùng Code 128. Tên sản phẩm (từ 30/09/2026) chia dòng theo bề rộng chữ THẬT như tem SKU, khung x=12→308: ở cỡ 22 tối đa 6 dòng khi có SKU (dòng cuối y=270, vùng SKU bắt đầu y=332), 7 dòng khi không SKU (dòng cuối y=295); tên dài tự thu nhỏ 22→20→18→16, giữ nguyên mép trên/dưới khung — xem mục "Tên sản phẩm trên mọi tem" bên dưới. Không đo được chữ thì lùi về cách cũ: 26 ký tự/dòng cỡ 22.
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

## Đo chữ thật cho tên sản phẩm SKU (24/09/2026)

- Nguồn yêu cầu: tem SKU [SKU_DA_XOA] bị cắt mất đuôi tên ("...DARK NAVY 14-4122") vì bản cũ chia dòng bằng đếm cố định 22 ký tự/dòng bất kể ký tự rộng hay hẹp — dòng toàn ký tự hẹp ("O-E L-S") còn thừa nhiều khoảng trắng trong khi dòng ký tự rộng đã đầy. In thủ công bằng BarTender không gặp lỗi này vì BarTender đo chữ thật qua GDI/GDI+ (và có Best Fit tự giảm cỡ chữ), còn renderer SVG của agent thì không đo gì cả.
- Kiến trúc: đo bề rộng chữ THẬT bằng GDI+ (`System.Drawing.Graphics.MeasureString` với `StringFormat.GenericTypographic`) qua script `powershell/measure-text.ps1`, gọi từ `src/text-metrics.mjs` (`measureTextWidths`). Input/output truyền qua file JSON tạm (không qua stdin/argv) để an toàn với tiếng Việt/Unicode; đọc lại phải bỏ BOM UTF-8 trước khi `JSON.parse`.
- **Chi phí:** đo thật gần như không tốn gì (~0,16ms/chuỗi); chi phí thật nằm ở việc SPAWN tiến trình PowerShell (~800–900ms/lần gọi). Vì vậy kiến trúc BẮT BUỘC gộp toàn bộ phép đo của MỘT lệnh in vào đúng HAI lần gọi PowerShell (không tăng theo số tem, xem bên dưới) — đã đo thật: tổng thời gian thêm vào một lệnh in chỉ ~1,6–1,8 giây dù lệnh có 1 hay 100 tem, giống hay khác tên nhau.
- `src/render.mjs#planSkuProductNames(entries, config, measureText, logger)` là nơi điều phối, chạy trước khi trải phẳng tem ra `labels`:
  - **Vòng 1** — gom mọi token (tách theo `tokenize`, cùng quy tắc token cũ trong `wrapText`) của TOÀN BỘ tên sản phẩm trong lệnh, đo riêng từng token, rồi wrap sơ bộ bằng `wrapByWidth` (`src/templates/text-layout.mjs`) với biên an toàn `WRAP_SAFETY_FACTOR = 0.88`.
  - **Vòng 2** — đo NGUYÊN từng dòng đã wrap sơ bộ (không phải tổng token), rồi `verifyLineWidths` xác nhận: dòng nào đo lại vẫn vượt khung thì tách bớt token cuối xuống dòng mới chèn ngay sau.
  - Cả hai vòng đều gộp cho TOÀN BỘ lệnh trong một lần gọi, nên tổng luôn là 2 lần PowerShell/lệnh, không phụ thuộc số tem hay số tên khác nhau — có test khẳng định (`tests/text-layout-integration.test.mjs`).
- **Vì sao bắt buộc có Vòng 2, không tin thẳng tổng token của Vòng 1:** đo thật ngày 24/09/2026 phát hiện tổng bề rộng 5 token đo RIÊNG LẺ của "Opened end/No.3 Plastic Zipper" là 294,7px (dưới khung 296px nên Vòng 1 cho qua chung một dòng), nhưng đo NGUYÊN cả cụm là 313,07px (vượt khung) — lệch 6,2%. Nguyên nhân: `GenericTypographic` bỏ "side bearing" ở hai đầu của MỖI lần đo độc lập; đo rời từng token nghĩa là bỏ bearing nhiều lần thay vì đúng một lần ở đầu và một lần ở cuối dòng thật, càng nhiều token/dòng sai số càng cộng dồn. Tin thẳng Vòng 1 đã làm mất chữ "r" cuối "Zipper" trên tem in thật — đây chính là lỗi đã xảy ra và được người dùng phát hiện qua ảnh tem thật trước khi có Vòng 2. `verifyLineWidths` an toàn tuyệt đối vì bớt nội dung luôn làm dòng hẹp hơn, không phụ thuộc đặc tính đo của GDI+. **ĐÍNH CHÍNH 30/09/2026:** lệch 18,37px ở ví dụ này không phải do side bearing mà vì `GenericTypographic` bỏ qua khoảng trắng CUỐI chuỗi — 3 token "Opened ", "No.3 ", "Plastic " mất 3 dấu cách (3 × 6,1px ở cỡ 22). `measure-text.ps1` nay bật `MeasureTrailingSpaces`; tổng token bằng đúng đo nguyên dòng (lệch 0,0% trên dữ liệu thật). Vòng 2 vẫn giữ làm chốt chặn.
- **Tự giảm cỡ chữ (Best Fit) khi tên vẫn không vừa ở cỡ mặc định:** `fitProductName` thử lần lượt `PRODUCT_NAME_FONT_SIZES = [22, 20, 18, 16]` (giảm dần), dùng cỡ lớn nhất mà số dòng wrap được vẫn nằm trong `maxLinesForSize(cỡ, layout)` (suy từ đúng công thức bố cục `SKU_LABEL_LAYOUT` dùng chung với `sku-label.mjs`, một nguồn sự thật duy nhất — đổi hằng số bố cục ở template thì phải đổi luôn ở `text-layout.mjs`). Không cỡ nào đủ thì dùng cỡ nhỏ nhất (16) và chấp nhận cắt bớt dòng cuối — vẫn tốt hơn bản cũ vì đã thử hết khả năng trước khi cắt. Không hạ xuống dưới 16px: dưới mức đó chữ khó đọc trên tem nhiệt 60mm.
- **Lùi về an toàn khi không đo được:** không truyền `measureText` (ví dụ code gọi cũ chưa nâng cấp), hoặc PowerShell/đo thật lỗi/timeout tại runtime, thì hệ thống lùi về đúng cách cũ — `wrapText` đếm cố định 22 ký tự/dòng ở cỡ chữ cố định 22 — giống hệt hành vi trước khi có tính năng này (byte-for-byte), không làm sập lệnh in. Vòng 1 lỗi thì bỏ qua hoàn toàn tính năng; Vòng 2 lỗi thì vẫn dùng kết quả wrap sơ bộ của Vòng 1 (đã an toàn hơn bản đếm ký tự, dù chưa xác nhận) thay vì bỏ hết.
- Áp dụng cho tem `sku` và (từ 30/09/2026) tem `group_uid` có `productName`; `fabric_relaxation` không in tên nên không đo.
- `planSkuProductNames` không bao giờ sửa `entries`/`job` gốc — luôn trả về mảng mới, vì trường hợp không phải batch thì phần tử `entries[0]` chính là tham chiếu tới `job` gốc của người gọi.
- Kiểm chứng: `tests/text-metrics.test.mjs`, `tests/text-layout.test.mjs`, `tests/text-layout-integration.test.mjs` (gồm test tái hiện đúng số liệu thật của lỗi "Zipper"), cùng kiểm chứng thật trên CLI `dry-run` với đúng tên sản phẩm của SKU [SKU_DA_XOA]: chữ/QR vẽ tới x=299 trong tổng 320px canvas (trước khi sửa là x=319, gần tràn hẳn mép phải) và QR decode lại đúng "[SKU_DA_XOA]".
- CHƯA VERIFY: hành vi trên workstation thật khi PowerShell bị chặn bởi chính sách nhóm (Group Policy) hoặc Execution Policy khác với máy dev; độ chính xác GDI+ với font khác Arial nếu sau này đổi font tem.

## Mất mạng giữa chừng (29/09/2026, agent 0.8.1)

- Nguồn: 5/100 lệnh gần nhất trên `may-kho-01` báo `failed` chỉ vì mạng tới Supabase chập chờn, máy in vẫn bình thường. 2 lệnh "The operation was aborted due to timeout" (DOMException mã 23) khi còn đang dựng tem — chưa ra tem. 3 lệnh "fetch failed" khi báo hoàn tất — spooler đã nhận job (`spoolJobId` 3, 4, 11) nên tem gần như chắc đã ra giấy; ít nhất lệnh Group UID lúc 08:23 ngày 29/09 đã bị bấm in lại 3 phút sau.
- Bản 0.8.0 await mọi `queue.progress`/`queue.complete` trong cùng một `try`, nên MỘT lần gọi mạng hỏng ở bất kỳ bước nào cũng thành `agent_fail`. Nguy hiểm hơn: nếu cả `complete` lẫn `fail` đều hỏng, lệnh kẹt ở `spooling`, hết lease bị trả về `queued` và agent TỰ in lần hai.
- Quy tắc mới:
  - Lỗi mạng tạm thời được thử lại 1s/2s/4s, mỗi lần tối đa 20 giây (`src/supabase-queue-client.mjs`); xấu nhất ~87 giây, vẫn dưới lease 120 giây. Lỗi nghiệp vụ không thử lại. Nhận diện lỗi ở `src/network-retry.mjs`.
  - Tiến độ chỉ để hiển thị (dựng tem, `spooling`, nhịp chờ spooler) không bao giờ làm hỏng lệnh. Mốc `sending` là chốt chặn duy nhất trước khi gửi byte: phải báo được để chắc còn giữ lệnh.
  - Mất mạng TRƯỚC khi gửi byte → `agent_requeue` với `NETWORK_UNSTABLE`, không báo failed; không trả được thì hết lease hàng đợi tự trả.
  - Từ lúc bắt đầu gửi byte, lỗi mạng KHÔNG BAO GIỜ thành `failed`. Agent ghi sổ tay `temp/sent-jobs.json` (`sending` → `sent` → `printed`/`failed`) và thử báo hoàn tất giãn dần tới 30 giây/lần, ~10 phút. Báo được kết quả thì xoá mục đó; mục quá 7 ngày tự dọn.
  - Nhận lại một lệnh còn trong sổ tay: `printed` → chỉ báo hoàn tất (`recoveredFromJournal: true`); `failed` → báo đúng lỗi đã ghi; `sending`/`sent` → báo `SENT_UNCONFIRMED` để người vận hành nhìn máy in trước khi in lại. Tuyệt đối không in lần hai.
  - Lỗi máy in thật (`PRINTER_STALLED`, `SPOOLER_TIMEOUT`, spooler từ chối…) vẫn báo failed kèm `pagesPrinted` như cũ.
- Sổ tay chỉ chống in trùng trên CÙNG một máy trạm. Hiện chỉ có một agent (`may-kho-01`); thêm agent thứ hai thì phải xem lại.
- Kiểm chứng: `tests/network-resilience.test.mjs` tái hiện đúng lệnh `22f65c10` (timeout lúc dựng tem) và `706c10a6` (fetch failed lúc báo hoàn tất); thử thật lỗi `ENOTFOUND` và timeout của undici trên máy dev.
- CHƯA VERIFY: chạy trên máy kho thật khi rút dây mạng giữa lúc in; hành vi khi antivirus khoá `temp/sent-jobs.json`.

## Đáy tem SKU cố định (30/09/2026, agent 0.8.2)

- Nguồn yêu cầu: vạch kẻ và hàng số lượng/ngày phải cố định ở cuối tem, không di chuyển; số lượng có dấu chấm hàng nghìn (1.000.000); đo chữ thật để tự chỉnh cỡ khi số lượng và ngày có nguy cơ chồng nhau; số lượng và ngày phải hiện ĐỦ ký tự; số lượng không in đậm.
- Vị trí (`SKU_LABEL_LAYOUT` trong `src/templates/sku-label.mjs`): vạch kẻ y=431 (nét 2 dot: 430–432), chân chữ số lượng/ngày y=465. Đúng bằng chỗ bản cũ đặt khi tên 8 dòng, nên sức chứa tên không đổi: 8 dòng cỡ 22, 9 dòng cỡ 18, 10 dòng cỡ 16. Tên ngắn thì khoảng trống nằm giữa số SKU và vạch kẻ.
- Số lượng cỡ 40 (lớn nhất) có đỉnh chữ ≈ 465 − 0,75×40 = 435, cách mép dưới vạch kẻ 3 dot — `tests/sku-footer.test.mjs` giữ bất biến này. Tăng cỡ tối đa hoặc dời vạch kẻ thì phải tính lại.
- Dấu chấm hàng nghìn (`formatQuantity` trong `src/templates/common.mjs`): chỉ nhóm dãy chữ số nguyên ≥ 4 chữ số đứng riêng. Không đụng số đã có dấu chấm (`1.000`), phần sau dấu phẩy thập phân (`1234,5` → `1.234,5`), số kiểu `12.5`, phân số `1/2`, dãy dính sau chữ cái (mã) hay dãy bắt đầu bằng 0. Dữ liệu thật tới 30/09/2026: số lượng dài nhất 9 chữ số (`300.000.000`), ngày dạng `dd/mm/yy`, có lần `dd/mm/yyyy`.
- Chọn cỡ chữ (`fitFooter` trong `src/templates/text-layout.mjs`): số lượng canh trái x=20, ngày canh phải x=300, phải cách nhau ≥ 10 dot trong khoảng 280 dot. Thu nhỏ số lượng trước (40 → 18, bước 2), rồi ngày (17 → 12), rồi số lượng dưới 18; vẫn không vừa thì hạ số lượng theo đúng tỷ lệ bề rộng (sàn 6). KHÔNG BAO GIỜ cắt ký tự.
- Đo chữ: số lượng và ngày được đo bằng GDI+ trong CÙNG lần gọi PowerShell vòng 1 (`options.extra` của `measureTextWidths`, mỗi nhóm có bộ cỡ chữ riêng), nên cả lệnh in vẫn đúng hai lần gọi PowerShell. Không đo được thì dùng `estimateTextWidth` — đã so với GDI+ thật trên chữ số, chữ hoa/thường, tiếng Việt có dấu và ký hiệu: luôn ước dư (thấp nhất 1,001 lần), chỉ làm chữ nhỏ hơn cần thiết chứ không làm chồng chữ.
- Lỗi thật khi làm: PowerShell 5.1 bung mảng 1 phần tử khi gán `$x = if (...) { @(...) }`, `.Count` rỗng nên nhóm đo thêm không chạy; phải bọc `@(if ...)` ra ngoài. Test giả không bắt được — đã chạy thật `powershell/measure-text.ps1` với 0, 1, 2 nhóm.
- Font in thật (sửa 30/09/2026): `renderRowSvg` (`src/render.mjs`) bỏ thẻ `<svg>` gốc của từng tem nên mất `font-family`; từ bản đầu tiên, đường in thật (hàng 2 tem → bitmap) vẽ bằng font mặc định có chân, chỉ `preview`/`writePreview` (tem đơn) là Arial. Nay gốc hàng khai báo lại `LABEL_FONT_FAMILY` (Arial) — khớp font mà GDI+ đo. Đã kiểm trên dữ liệu thật (286 tem SKU, 1.829 tem Group UID khác nhau): không tem nào có nét chữ vượt x=315 trên tem rộng 320, kể cả tem Group UID chia dòng đếm 26 ký tự. `tests/render.test.mjs` giữ bất biến này.
- CHƯA VERIFY: in thật trên TSC PE200 với số lượng dài (≥ 9 chữ số) và ngày `dd/mm/yyyy`; độ đọc được của số lượng khi phải xuống dưới 18.

## Tên sản phẩm trên mọi tem (30/09/2026, agent 0.8.3)

- Nguồn yêu cầu: mọi phần in tem có tên sản phẩm phải làm như tem SKU để không in thiếu tên.
- Tem Group UID (agent): trước đây đếm cố định 26 ký tự/dòng và LẶNG LẼ cắt từ dòng thứ 7 (6 khi có SKU). Dữ liệu thật tới 30/09/2026: 2 tên dài bị cắt, ứng với 558 tem đã in thiếu đuôi tên. Nay dùng chung `planProductNames` (`src/render.mjs`) với tem SKU; khung tên và công thức số dòng ở `GROUP_UID_NAME_LAYOUT`/`groupUidMaxLines` (`src/templates/group-uid-label.mjs`). Kiểm trên toàn bộ tên thật: 0 tên bị cắt, 0 tem tràn mép; 558 tem trên chuyển xuống cỡ 20, còn lại giữ cỡ 22.
- Chọn cỡ (`productNameCandidates`, `src/templates/text-layout.mjs`): mỗi cỡ thử chia dòng dùng đủ khung trước, rồi mức thận trọng `WRAP_SAFETY_FACTOR`. Vòng 2 đo lại nguyên dòng của MỌI phương án còn lại trong cùng một lần gọi PowerShell; chọn phương án vừa khung ở cỡ lớn nhất, cùng cỡ thì ưu tiên phương án không phải tách dòng. Trước đây dòng bị tách ở vòng 2 làm vượt số dòng thì bị cắt đuôi tên; nay chuyển sang cỡ nhỏ hơn, chỉ cắt (có log cảnh báo) khi đã ở cỡ 16 vẫn không vừa.
- In tạm bằng trình duyệt (`index.html`, hàm `x` trong bundle — nút "in bằng máy này" khi hàng đợi không phản hồi): trước đây ước lượng 0,55em/ký tự nên tên viết hoa/token dài tràn ra ngoài tem (đo lại: tới 446px trên khung 272px). Nay đo bằng `canvas.measureText` cùng font Arial của SVG; không có canvas thì dùng lại cách cũ (`xUocLuongCu`). Đây là sửa tay trong bundle đã minify — repo không có mã nguồn gốc của bundle.
- LOT/ROLL tem Group UID: hai chuỗi cùng một hàng cỡ 24 (LOT x=12, ROLL canh phải x=308) và KHÔNG tự thu nhỏ. Dữ liệu thật: 67/149 tem có cả LOT và ROLL bị chồng chữ (cả font Times lẫn Arial). Người dùng quyết định: không tự sửa bố cục, chỉ cảnh báo trước khi in. `index.html` đo bằng canvas (`window.PrintSkuQueue.lotRollOverlaps`), trang PRINT UID và Cắt Group UID hỏi xác nhận với câu "Tem in Lot và roll có thể trùng lên nhau, cần báo kiểm tra." — Cancel thì không gửi lệnh. Lưu ý: ROLL như `N03-76/5/26DT-004` nghĩa là roll 004, phần trước là tên Lot; nhưng rút gọn ROLL thành `004` vẫn chưa đủ vì riêng `LOT: N03-76/5/26DT` đã rộng 221/296px.
- CHƯA VERIFY: in thật tem Group UID tên dài ở cỡ 18–20 trên TSC PE200; nút "in bằng máy này" qua hộp thoại in thật của trình duyệt; đo canvas trên điện thoại (không có Arial thì trình duyệt thay font khác, ngưỡng cảnh báo lệch vài px).

## Realtime đánh thức, hỏi thưa khi rảnh (30/09/2026, agent 0.8.4)

- Nguồn: Supabase báo Log Ingestion 0,76/1 GB gói Free; nguyên nhân là agent hỏi `print_agent_claim` mỗi giây 24/7 (~86.000 lần/ngày) trong khi cả tháng chỉ có ~140 lệnh in. Người dùng yêu cầu "chỉ nhận lệnh khi cần".
- Cách làm: trigger `print_jobs_wake_agent` phát Broadcast công khai topic `print-queue` khi dòng `print_jobs` có status `queued` (insert / requeue / hết lease). Agent (`src/realtime-wake.mjs`) nối WebSocket có sẵn của Node tới `/realtime/v1/websocket`, `phx_join` topic công khai, heartbeat 25 giây, không phản hồi 10 giây thì đóng nối lại (giãn 1s→30s). Tín hiệu chỉ ĐÁNH THỨC vòng quét (`createWaiter`), không mang lệnh.
- Nhịp hỏi (`nextPollDelay`): trong 120 giây sau lệnh gần nhất hỏi 1 giây/lần; rảnh thì 20 giây/lần khi Realtime đang nối, 10 giây/lần khi chưa nối. Vì sao 20 chứ không 60: web báo "Chưa ai nhặt lệnh sau 25 giây — máy trạm chưa bật agent" nên nhịp dự phòng phải dưới 25 giây; và ngưỡng "Chưa rõ máy in" trên web (`last_seen_at`) đã nâng 15 → 45 giây cho khớp.
- Đo thật 30/09/2026: tin từ trigger tới agent sau ~1 ms kể từ khi lệnh được ghi. Lần đầu thử KHÔNG tới: tin đầu tiên sau khi Realtime khởi động đường phát từ cơ sở dữ liệu bị rớt (tài liệu Supabase cũng nói client phải kết nối trước để tạo phân vùng ngày của `realtime.messages`). Vì vậy `realtime.send` trong trigger bọc EXCEPTION, và nhịp dự phòng là bắt buộc — không được tắt.
- Test: `tests/realtime-wake.test.mjs` (WebSocket giả: join, broadcast, heartbeat timeout, nối lại giãn dần, bị từ chối, stop), `tests/agent-poll.test.mjs` (nhịp hỏi, waiter, runService với wake giả). Test `runService` phải tiêm `queryPrinter` giả — bản thật gọi PowerShell và `path.join(config.rootDir)` ném lỗi ngoài try khi thiếu rootDir.
- CHƯA VERIFY: chạy trên máy trạm thật (tường lửa công ty có cho WebSocket tới supabase.co không); nhật ký thực tế giảm bao nhiêu sau một tuần.

## Bỏ kiểm tra máy in trước khi nhận lệnh khi được đánh thức (30/09/2026, agent 0.8.5)

- Đo trên máy trạm thật với 0.8.4: agent hỏi hàng đợi 3,5–7 giây sau khi lệnh vào, trong khi tín hiệu tới sau ~1 ms — phần lớn là PowerShell `printer-status.ps1` (~2 giây trên máy đó) chạy TRƯỚC khi nhận lệnh, rồi `processClaimedJob` lại chạy lần nữa trước khi in.
- Quy tắc (`shouldSkipPrinterCheck`): chỉ bỏ bước kiểm tra trước khi nhận khi vòng quét do tín hiệu Realtime hoặc vừa in xong một lệnh, VÀ lần kiểm tra gần nhất còn mới hơn `PRINTER_STATE_CACHE_MS` (60 giây), VÀ lần đó máy sẵn sàng. Kết quả kiểm tra sau khi in (`after` trong processClaimedJob) được đưa lại làm bộ nhớ, nên một đợt nhiều lệnh chỉ tốn 2 lần PowerShell/lệnh thay vì 3.
- Máy kẹt thì KHÔNG bao giờ bỏ qua: nếu nhận lệnh với trạng thái cũ, processClaimedJob sẽ trả lệnh về hàng đợi → trigger phát tín hiệu → agent lại nhận → lặp mãi và `attempt_count` tăng. Nhịp định kỳ cũng luôn kiểm tra thật để đèn "Máy in rảnh" trên web đúng trong vòng ~40 giây.
- Kiểm tra thật ngay trước khi gửi byte xuống máy in (`before`) giữ nguyên — đây mới là bước an toàn.
- Test: `tests/agent-poll.test.mjs` (quy tắc, runService đếm số lần kiểm tra khi được đánh thức, máy kẹt).
- Đo trên máy trạm thật 30/09/2026 (máy `may-kho-01` báo 0.8.5; tính theo đồng hồ Supabase: `created_at` của lệnh so với `last_seen_at` do `agent_claim` ghi): tín hiệu Realtime tới sau ~0,4 giây, agent gọi `agent_claim` sau 1,2–1,5 giây kể từ lúc lệnh vào hàng đợi (4 lần thử) — dưới 2 giây nên bước PowerShell đã được bỏ qua. Lưu ý khi đo: đừng lấy đồng hồ máy đo trừ `last_seen_at` — máy đo lệch Supabase 1,7 giây làm các số 0.8.4 (3,5–7 giây) bị đội lên.

## In nhanh hơn: chờ spooler 2,5s, cache đo chữ, danh mục SKU đo sẵn (01/10/2026, agent 0.8.6)

- **Số liệu gốc:** 40 lệnh hoàn tất gần nhất, trung vị: chờ nhận 1,6s · kiểm tra máy in trước khi in 1,2s · dựng tem 1,7s (~0,43s/SKU) · gửi 0,9s · **chờ spooler + kiểm tra sau in 10,3s** · tổng 16,2s. Bước cuối gần như cố định ~10s bất kể 1 hay 155 tem → không phải thời gian in thật. Mọi `result` đều `spoolConfirmed: false`.
- **Chờ spooler:** `SPOOL_APPEAR_MS` mặc định 8000 → **2500**. Lý do an toàn (đọc kỹ mục "Trên TSC PE200…" ở trên): `StartDocPrinter` tạo job và trả mã job TRƯỚC khi gửi byte, nên job kẹt có mặt trong hàng đợi ngay từ nhịp quét đầu; ngày 17/09 job kẹt nằm lại hàng chục phút. Rút ngắn không mở thêm rủi ro: trường hợp máy nhận hết byte vào bộ nhớ trong rồi mới hết giấy thì không để lại dấu vết dù chờ 8s hay 2,5s (driver TSC không báo lỗi vật lý về Windows). Không được coi "không thấy job" là "đã xác nhận" — vẫn `spoolConfirmed: false`.
- **Cache đo chữ** (`src/text-cache.mjs`, `temp/text-metrics-cache.json`): khoá `cỡ|chuỗi` (measure-text.ps1 đo mọi nhóm cùng font Arial + GenericTypographic + MeasureTrailingSpaces, chỉ khác cỡ). Bảo vệ: `version` = phiên bản agent + font (khác → bỏ file); `validate()` đo lại 6 chuỗi mẫu ở cỡ 22/16 khi khởi động, lệch ≥ 0,01px → xoá hết và đổi `generation`; chưa đối chiếu được (PowerShell lỗi) → KHÔNG dùng cache, đo như cũ. Ghi file tạm rồi `rename`; file hỏng → làm lại. Trần 400.000 mục, vượt thì bỏ 10% mục cũ nhất. `cachedMeasure()` trả đúng dạng `measureTextWidths` (Map + `.extra`), vẫn đúng MỘT lần gọi PowerShell cho phần thiếu. **Bẫy đã gặp khi viết:** `ensureValid` ban đầu trả kết quả `validate()` (= "chuỗi mẫu có giống lần trước") — lần chạy đầu tiên luôn `false` nên bước đo sẵn tưởng cache chưa sẵn sàng; phải trả "cache dùng được".
- **Danh mục SKU đo sẵn** (`src/sku-catalog.mjs`, `temp/sku-catalog.json`): lúc in agent KHÔNG tra SKU (web gửi tên), giá trị của danh mục là đo sẵn chữ cho mọi tên. Script đồng bộ SKU ghi `updated_at` cho MỌI dòng mỗi lần chạy (sáng 01/10 lúc 07:56) → 15 phút/lần hỏi `updated_at` mới nhất (1 dòng), khác thì tải lại cả bảng theo trang 1.000 (publishable key, ~4 MB, ~7s) và chỉ đo tên chưa đo. Đo theo đợt 300 tên qua chính `planProductNames` (tem SKU + tem Group UID có SKU) với `cachedMeasure`, nên khoá cache khớp đúng những gì lệnh in thật sẽ hỏi; chỉ chạy khi `isBusy()` false (không in và đã qua `AGENT_ACTIVE_WINDOW_MS` sau lệnh cuối). `generation` của text-cache đổi → đo lại toàn bộ. Lỗi mạng → giữ danh mục cũ, chỉ ghi log.
- **Vòng 2 `planProductNames`:** trước đo MỌI dòng ở MỌI cỡ đang dùng; nay mỗi dòng chỉ đo ở cỡ của phương án chứa nó (mỗi cỡ một nhóm `extra`, vẫn một lần gọi). Bước chọn chỉ đọc `lineWidths.get(dòng).get(cỡ của phương án)` nên kết quả không đổi — đã so 600 tem từ 300 tên thật (PowerShell thật): khác 0 tem, cả khi qua cache. Giả lập `measureText` trong test phải hỗ trợ `extra` như hàm thật.
- **Đo thật trên máy phát triển (01/10/2026):** đo sẵn toàn bộ 21.582 tên trong 94s, cache 207.216 mục (7,1 MB), danh mục 4,3 MB; chạy lại khi không có tên mới 6 ms; mở lại cache khi khởi động 0,4s; dựng 600 tem trúng cache 46 ms (không cache 1.313 ms). Chạy thử `runService` thật (hàng đợi giả): tải danh mục 7,7s sau khởi động, tắt giữa chừng thì lần sau không tải lại và đo tiếp.
- Test: `tests/text-cache.test.mjs`, `tests/sku-catalog.test.mjs`, `tests/config-086.test.mjs` (mặc định 2,5s; job kẹt vẫn chờ tới khi in xong).
- **RAM (đo 02/10/2026 trên file cache đầy đủ 207.216 mục):** agent rỗng 54 MB → có cache + danh mục 112 MB ổn định (heap: cache đo chữ ~20 MB, danh mục ~10 MB; phần còn lại là vùng nhớ V8 giữ lại sau khi parse file 7 MB). Đỉnh tạm: +90 MB khi khởi động đọc cache (~0,4s), +34 MB khi ghi lại cả file (`Object.fromEntries` + `JSON.stringify`); in lệnh trúng cache +0,4 MB. Muốn giảm: bỏ `rows`/`warmed` khỏi RAM sau khi đo, hoặc ghi cache kiểu nối tiếp thay vì ghi lại cả file.
- **Đo trên máy trạm thật sau khi cài (02/10/2026, 4 lệnh SKU 1–10 tem):** chờ spooler 3,8–4,5s (trước 10,1s), tổng trung vị 10,6s (trước 15,5s), không lệnh nào lỗi. Dựng tem CHƯA nhanh lên (1,8–2,6s): tên đã trúng cache nhưng SỐ LƯỢNG ở đáy tem mỗi lệnh một khác nên lệnh nào cũng thiếu cache → vẫn mở PowerShell một lần ở vòng 1. Hướng đã kiểm chứng nhưng chưa làm: đổi mọi chữ số thành 0 trong khoá cache — GDI+ Arial đo mọi chữ số rộng bằng nhau ở cả 18 cỡ ("1.234" = "9.876", "02/10/26" = "31/12/99"); kèm kiểm tra lúc khởi động, font không còn chữ số đều thì tắt. Còn lại mỗi lệnh mở PowerShell ~4–5 lần (kiểm tra máy in, raw-print, 2 nhịp spooler, kiểm tra sau in, ~0,5–0,8s mỗi lần khởi động) — tiến trình PowerShell thường trực sẽ bớt thêm ~2–3s.
- CHƯA VERIFY trên máy trạm thật: thời gian đo sẵn lần đầu, RAM agent, và phép thử mở nắp máy in rồi in 1 tem (agent phải đứng chờ, không báo đã in).

## Tem mã vị trí kho — `location:v1` (02/10/2026, agent 0.8.7)

- **Phạm vi:** màn MÃ VỊ TRÍ (`#location`) lưu mã + tên vị trí trong `public.warehouse_locations` và in tem QR dán kệ 40 × 60 mm (2 tem/hàng) qua hàng đợi, loại tem mới `location`, template 1, capability `location:v1`. Chi tiết bố cục và cách đo chữ: README mục 0.8.7.
- **Mã không bao giờ bị cắt:** mã bị cắt là tem của một vị trí KHÁC. Validator agent (`LOCATION_PATTERN`), CHECK của bảng và web dùng đúng một mẫu `^[0-9A-Z][0-9A-Z._/-]{0,39}$`; sai thì từ chối cả lệnh. Mã dài ép ngang chữ (bảng Arial Bold đã đối chiếu GDI+), tên dài xuống dòng/giảm cỡ, dòng nào còn quá rộng ép ngang riêng dòng đó.
- **Tên do server quyết định:** `print_enqueue` bỏ tên web gửi, lấy tên từ `warehouse_locations` theo mã; vị trí chưa lưu hoặc đã ẩn thì `LOCATION_NOT_FOUND`. Agent vẫn kiểm tra payload (1–60 ký tự, tổng số tem khớp lệnh).
- **Migration `supabase/warehouse_location_v1.sql` thay `print_enqueue` và `print_agent_claim`** — hai hàm mọi loại tem đi qua. Đã so từng mệnh đề với bản ĐANG CHẠY trên Supabase (02/10/2026): chỉ thêm nhánh `location` (kiểu tem được phép, kiểm tra/đọc tên trong `print_enqueue`, một điều kiện capability trong `print_agent_claim`); phần còn lại giống hệt. Không đụng trigger đánh thức Realtime 0.8.4. Phải chạy bằng `--allow-destructive` vì đổi CHECK loại tem và `drop trigger if exists` (không xoá dữ liệu).
- **Thứ tự triển khai** (README gốc): migration → agent 0.8.7 → `index.html`. Web chống đưa sai thứ tự: chưa có migration thì màn #location báo "chưa chạy warehouse_location_v1.sql"; chưa có agent `location:v1` (đọc từ `queueStatus`) thì KHÔNG gửi lệnh và báo cần cập nhật agent — không có lệnh nào nằm chờ vô hạn.
- **Đã kiểm tra (02/10/2026):** 8 test `location-label.test.mjs` + cả bộ 127/130 (3 test lỗi vẫn là 3 test cũ bị che dữ liệu mẫu `[SKU_DA_XOA]`/`[UID_DA_XOA]`); tem mẫu dựng bằng CLI, QR đọc ngược bằng ZXing ra đúng mã; web ở 375 px không tràn ngang, lưu → chọn → in qua Supabase và hàng đợi giả lập gửi đúng `type: location`, `templateVersion: 1`, nonce. CHƯA kiểm tra: in thật ra giấy, quét QR bằng máy quét WMS, và chạy migration lên Supabase.
- Lên phiên bản agent mới nên cache đo chữ làm lại và danh mục SKU đo lại nền (~1,5–3 phút khi rảnh).
