# Print SKU UID Agent

Agent Windows độc lập phục vụ ứng dụng Print SKU. Bản 0.7.0 dùng tem Fabric Relaxation viết tay hoàn toàn; frontend chỉ chọn số lượng tem.

## Cập nhật 0.8.9 — agent chết thì tự chạy lại, không chết im lặng nữa

Sự cố 06–07/10/2026: agent ngừng lúc ~20:21 và nằm im tới khi có người bật tay sáng hôm sau, `agent.log`
không ghi gì. Bản 0.8.9:

- **Task Scheduler chạy agent khi khởi động, khi có người đăng nhập và kiểm tra mỗi 5 phút**
  (`install-agent.ps1`). Agent đang chạy thì bỏ qua (`IgnoreNew`), không bao giờ có hai bản; agent chết
  thì chậm nhất 5 phút sau có lại. Không còn chặn khi máy chạy pin. Script cài tự tắt task và đợi agent
  cũ dừng hẳn trước khi chép đè.
- **Ghi lý do dừng vào `agent.log`**: lỗi không bắt được (kèm stack), mã thoát, tín hiệu dừng; mỗi giờ
  một dòng "Agent còn chạy" kèm RAM. Log dừng mà không có dòng "Agent thoát" nghĩa là tiến trình bị diệt
  từ bên ngoài (tắt máy, Task Manager, `Stop-ScheduledTask`).
- **Khóa `temp\agent.lock` chạm lần cuối trước lần khởi động máy gần nhất thì coi là cũ ngay**, không
  chờ 3 phút (trước đây tắt máy rồi lên lại nhanh có thể làm agent tưởng bản cũ còn chạy rồi tự thoát).
- **Vòng quét đứng quá 10 phút khi không in thì agent tự thoát** (mã 3) để Task Scheduler chạy lại.
  Đang in (kể cả chờ thay giấy) thì không tính. `LOOP_STALL_MS` trong `config\.env`, 0 để tắt.

Không cần migration Supabase, không đổi web. Cài ZIP như bản 0.8.8 bằng `install-agent.ps1` (giữ nguyên
`config\.env` và `temp`); máy trạm đặt chính sách Restricted nên gọi qua
`powershell.exe -ExecutionPolicy Bypass -File`. Chờ lệnh in đang chạy xong trước khi cài.

## Cập nhật 0.8.8 — in nhanh hơn (PowerShell thường trực) và tên vị trí không bắt buộc

### In nhanh hơn

Đo 4 lệnh trên máy trạm với 0.8.6: tổng trung vị 10,6 giây, mỗi lệnh mở PowerShell mới 4–5 lần
(kiểm tra máy in, đo chữ, gửi dữ liệu, 2 lần dò spooler, kiểm tra sau in — mỗi lần ~0,5–1,9 giây chỉ để
khởi động). Bản này giảm các khoản đó, không đổi cách tem được dựng hay cách xác nhận in:

- **PowerShell thường trực** (`src/ps-host.mjs` + `powershell/host.ps1`): một tiến trình giữ sẵn module in,
  System.Drawing và kiểu gửi dữ liệu. Đo trên máy phát triển: kiểm tra máy in ~60 ms (trước ~1,8 s), phần
  khởi động của bước gửi dữ liệu ~10–80 ms (trước ~0,5 s; đo với máy in giả, không in gì). Tiến trình
  lỗi/quá hạn/tạm tắt thì mọi nơi tự dùng cách mở mới như 0.8.7. **Gửi dữ liệu ra máy in không bao giờ bị
  gọi lại bằng cách khác** sau khi yêu cầu đã tới tiến trình (tránh in trùng). `PS_HOST=off` để tắt.
- **Cache đo chữ gộp chữ số**: Arial đo mọi chữ số rộng bằng nhau nên số lượng/ngày ("28.571.429",
  "02/10/26") dùng chung khoá với "00.000.000", "00/00/00". Agent đo lại 10 chữ số mỗi lần khởi động; font
  không còn chữ số đều nhau thì tự tắt cách gộp. Các mẫu số lượng/ngày phổ biến được nạp sẵn một lần, nên
  lệnh in đầu tiên sau nâng cấp cũng không phải mở PowerShell đo chữ.
- **Song song hoá các lần báo không nằm đường găng**: báo "rendering" chạy cùng lúc với kiểm tra máy in và
  dựng tem, báo "spooling" chạy cùng lúc với dò spooler. Báo "sending" vẫn phải đợi "rendering" xong và
  vẫn đứng trước khi gửi dữ liệu (mất lease thì dừng, không in).
- **Dò spooler** `SPOOL_APPEAR_MS` 2,5 s → **1,5 s**, dò mỗi `SPOOL_POLL_MS` **0,5 s** (trước 1 s): mỗi lần
  dò chỉ còn ~60 ms nên được ~4 lần quan sát trong ~1,7 s thay vì 2 lần trong 2,8 s. Lệnh kẹt vẫn nằm lại
  hàng đợi nên vẫn bị phát hiện và agent vẫn chờ tới khi in xong.
- **Sửa lỗi**: đo sẵn danh mục SKU từng đánh dấu "đã đo" cả những tên mà PowerShell đo hỏng (tên bị bỏ qua
  mãi); nay đo hỏng thì không đánh dấu và đo lại vòng sau. Đợt đo sẵn 300 → 100 tên cho nhẹ hơn.
- Script có chữ tiếng Việt (`printer-status.ps1`, `raw-print.ps1`) có BOM UTF-8 để PowerShell 5.1 không
  đọc sai thành "sáºµn sÃ ng"; `host.ps1` và `raw-printer-type.ps1` thuần ASCII.
- Tuỳ chọn `.env`: `PS_HOST`, `SPOOL_POLL_MS`, `SPOOL_APPEAR_MS=1500` (xem `.env.example`). **Máy đã có
  `config\.env` thì trình cài KHÔNG ghi đè** — dòng `SPOOL_APPEAR_MS=2500` (hoặc `8000`) chép từ bản cũ sẽ
  giữ nguyên mức cũ; đổi sang `1500` hoặc xoá dòng đó để dùng mặc định mới.

### Tên vị trí không bắt buộc

Vị trí chỉ có mã thì tem in **QR + mã**, không in tên (QR và mã nằm đúng chỗ như tem có tên để dán thẳng
hàng). Agent báo thêm capability `location:name-optional`; lệnh có tên trống được nhận, tên tối đa 60 ký tự
như trước, và tên trống không tốn lần đo chữ. Web chỉ gửi vị trí không tên khi thấy capability này (agent
0.8.7 từ chối tên trống). Migration: `supabase/warehouse_location_v3_no_table.sql` (03/10/2026 — thay v1/v2,
không còn bảng danh mục vị trí; web gửi thẳng mã + tên trong lệnh in).

## Cập nhật 0.8.7 — tem mã vị trí (`location:v1`)

Agent báo thêm capability `location:v1` và in tem màn **MÃ VỊ TRÍ** (`#location` trên web): giấy 40 × 60 mm
đang lắp, 2 tem/hàng như tem SKU. Template `src/templates/location-label.mjs`:

- **QR** chứa đúng mã vị trí (mức M, chế độ chữ-số khi mã chỉ gồm 0-9 A-Z . / - nên QR nhỏ nhất, module
  to nhất), rộng ~26 mm, lề trắng trên 5 mm (4 module). QR tem SKU giữ nguyên chế độ Byte như cũ.
- **Mã vị trí** Arial đậm cỡ 44 → 24, đo theo bảng bề rộng ký tự Arial Bold (đã đối chiếu GDI+ từng ký
  tự); mã dài thì ép ngang chữ quanh tâm tem.
- **Tên vị trí** Arial thường, đo bề rộng THẬT bằng GDI+ (`src/location-plan.mjs`, cùng `measureText` và
  cache với tên sản phẩm) — một lần cho cả lệnh; một dòng nếu vừa, dài thì xuống dòng/giảm cỡ 30 → 12.
- **Không bao giờ bỏ ký tự**: không cắt "…"; dòng nào vẫn rộng hơn vùng chữ 296 dot thì ép ngang dòng đó.
  Đo lỗi thì dùng ước lượng (vẫn đủ ký tự). Kiểm tra thật: 6 tên khó in đủ ký tự, không điểm ảnh nào ra
  ngoài vùng chữ, QR đọc lại đúng bằng ZBar.

Lên phiên bản agent mới nên cache đo chữ làm lại và danh mục SKU đo lại nền (~1,5–3 phút khi rảnh) như
mỗi lần nâng cấp. Cần migration mở hàng đợi cho loại tem `location` — nay là
`supabase/warehouse_location_v3_no_table.sql` (không còn bảng `warehouse_locations`); agent cũ vẫn chạy
bình thường, chỉ không nhận lệnh tem vị trí.

## Cập nhật 0.8.6 — in nhanh hơn: chờ spooler ngắn lại, cache đo chữ, danh mục SKU đo sẵn

Đo 40 lệnh gần nhất (01/10/2026): trung vị 16,2 giây từ lúc bấm In tới lúc web báo xong, trong đó
**10,3 giây là chờ spooler** và 1,7 giây dựng tem (chủ yếu mở PowerShell đo chữ).

- **Chờ spooler 8s → 2,5s** (`SPOOL_APPEAR_MS`). TSC PE200 đẩy byte thẳng ra USB, lệnh khoẻ biến mất
  trước nhịp quét đầu nên 8 giây chờ chưa từng thu được gì (`spoolConfirmed: false` ở mọi lệnh); lệnh
  kẹt (hết giấy, bung nắp) nằm lại hàng đợi hàng phút nên 2 nhịp quét vẫn thấy và agent vẫn chờ như cũ.
- **Cache đo chữ** `temp\text-metrics-cache.json`: trùng tên/dòng đã đo thì không mở PowerShell. Khởi
  động đo lại chuỗi mẫu, khác số cũ (Windows đổi font) thì xoá; lên phiên bản agent mới thì làm lại.
- **Danh mục SKU đo sẵn** `temp\sku-catalog.json`: 15 phút/lần hỏi `updated_at` mới nhất của
  `SKU_Name`; đồng bộ SKU buổi sáng xong thì tải lại (~4 MB, ~7 giây) và chỉ đo các tên mới. Lần đầu
  (và sau mỗi lần nâng cấp agent) đo toàn bộ ~21,6 nghìn tên: ~1,5–3 phút, chạy nền, chỉ khi rảnh
  ≥ 2 phút, có lệnh in thì dừng chờ; tắt agent giữa chừng thì lần sau đo tiếp.
- Vòng 2 đo chữ chỉ đo mỗi dòng ở đúng cỡ của phương án — kết quả ngắt dòng giống hệt bản cũ (so 600
  tem từ 300 tên thật), ít phép đo và ít mục cache hơn ~4 lần.

Tắt từng phần trong `config\.env`: `TEXT_CACHE=off`, `SKU_CACHE=off`, `SPOOL_APPEAR_MS=8000`. Agent
dùng thêm khoảng 60–70 MB RAM khi đã có cache đầy đủ (đo thật: 54 → 112 MB; đỉnh +90 MB khoảng 0,4 giây
lúc khởi động đọc file cache, +34 MB lúc ghi lại file). Không cần migration Supabase, không đổi web.

## Cập nhật 0.8.5 — nhận lệnh nhanh hơn ~2 giây

Khi được Realtime đánh thức (hoặc vừa in xong một lệnh), agent dùng lại kết quả kiểm tra máy in
gần nhất nếu chưa quá 60 giây và máy đang sẵn sàng, thay vì chạy PowerShell (~2 giây) rồi mới
nhận lệnh. Kiểm tra thật ngay trước khi gửi xuống máy in vẫn giữ nguyên; nhịp hỏi định kỳ vẫn
kiểm tra thật để đèn trạng thái trên web đúng; máy in kẹt thì luôn kiểm tra thật. Tuỳ chọn
`PRINTER_STATE_CACHE_MS` (mặc định 60000; 0 = luôn kiểm tra như cũ). Không cần migration.

## Cập nhật 0.8.4 — Realtime đánh thức, hỏi thưa khi rảnh

Bản cũ hỏi hàng đợi mỗi giây 24/7 (~86.000 lần/ngày), chiếm gần hết 1 GB nhật ký/tháng
của Supabase gói Free. Bản 0.8.4:

- Giữ một kết nối Supabase Realtime (WebSocket có sẵn của Node, không thêm thư viện); lệnh
  vào hoặc quay về hàng đợi thì trigger `print_jobs_wake_agent` phát tín hiệu và agent hỏi
  hàng đợi ngay (đo thật: ~1 ms sau khi lệnh được ghi).
- Khi rảnh chỉ hỏi dự phòng mỗi 20 giây (10 giây nếu chưa nối được Realtime); trong 120 giây
  sau mỗi lệnh vẫn hỏi 1 giây/lần để bắt các tem tiếp theo của cùng đợt. Số lần gọi giảm
  khoảng 20 lần. Tin đầu tiên ngay sau khi Realtime khởi động đường phát có thể bị lỡ — nhịp
  dự phòng lo phần đó, tệ nhất tem đầu chậm 20 giây.
- Cấu hình trong `config\.env`: `AGENT_IDLE_POLL_MS`, `AGENT_IDLE_POLL_NO_WAKE_MS`,
  `AGENT_ACTIVE_WINDOW_MS`, `REALTIME_WAKE=off` để quay về cách cũ.

Cần chạy `deployment/print_queue_v5_realtime_wake.sql` một lần (đã áp dụng ngày 30/09/2026)
và đưa `deployment/index.html` lên web: ngưỡng "Chưa rõ máy in" nâng từ 15 lên 45 giây cho
khớp nhịp hỏi thưa. Máy trạm phải ra được `wss://<project>.supabase.co` (cổng 443); bị chặn thì
agent tự lùi về hỏi mỗi 10 giây và ghi log "Realtime: mất kết nối".

## Cập nhật 0.8.3 — in đủ tên sản phẩm trên mọi tem

- Tem Group UID chia dòng tên theo bề rộng chữ thật như tem SKU, tên dài tự thu nhỏ
  (22 → 20 → 18 → 16) thay vì bị cắt mất đuôi.
- Đo chữ tính cả dấu cách cuối mỗi từ, nên tên xuống dòng đều và dùng đủ bề rộng tem.
- Trang web (`deployment/index.html`): nút "in bằng máy này" cũng đo chữ thật; in tem Group UID
  mà LOT và ROLL có thể đè nhau thì hỏi xác nhận trước khi gửi lệnh.

Không cần migration Supabase. Cài ZIP như bản 0.8.1 và đưa `deployment/index.html` lên nơi phục vụ web.

## Cập nhật 0.8.2 — đáy tem SKU cố định

- Vạch kẻ và hàng số lượng/ngày luôn nằm cố định ở đáy tem SKU, không trôi theo độ dài tên.
- Số lượng có dấu chấm hàng nghìn (`300000000` → `300.000.000`), chữ thường (không in đậm).
- Số lượng và ngày được đo bằng GDI+; nếu có nguy cơ chạm nhau thì tự thu nhỏ
  (số lượng trước, rồi ngày), luôn hiện đủ ký tự, không cắt.
- Tem in thật dùng Arial như preview (trước đây đường in ra font mặc định có chân).

Không cần migration Supabase và không đổi `index.html`. Cài ZIP như bản 0.8.1.

## Cập nhật 0.8.1 — chịu lỗi mạng

Bản 0.8.0 báo lệnh "failed" mỗi khi mạng tới Supabase chập chờn, kể cả khi tem
đã ra giấy, nên người dùng bấm in lại và ra tem trùng. Bản 0.8.1:

- Tự thử lại mỗi lần gọi Supabase khi mất kết nối/quá thời gian chờ (1s, 2s, 4s).
- Mất mạng trước khi gửi xuống máy in: trả lệnh về hàng đợi (`NETWORK_UNSTABLE`)
  và tự in khi mạng ổn lại, người dùng không phải bấm lại.
- Mất mạng sau khi đã gửi xuống máy in: không bao giờ báo "failed"; ghi sổ tay
  `temp\sent-jobs.json` và thử báo hoàn tất tới khi được. Lệnh bị trả về hàng
  đợi thì lần nhận lại chỉ báo hoàn tất, không in lần hai.
- Log và `print_events` ghi rõ nguyên nhân mạng (ví dụ `ECONNRESET`, `ENOTFOUND`).

Không cần migration Supabase và không đổi `index.html`. Cài ZIP như bình thường
bằng `powershell/install-agent.ps1` (giữ nguyên `config/.env` và thư mục `temp`).

## Cập nhật Fabric Relaxation

Chờ lệnh in hiện tại hoàn tất, dừng agent cũ rồi cài ZIP theo quy trình hiện có.
Giữ nguyên `config/.env` và token máy trạm. Chạy `powershell/install-agent.ps1`
bằng quyền Administrator để cập nhật cùng Scheduled Task, không tạo agent thứ hai.

Quản trị hệ thống cần chạy `deployment/print_queue_v4_fabric_relaxation_handwritten.sql`
trong Supabase SQL Editor một lần và đưa `deployment/index.html` lên nơi phục vụ web.
Thư mục `deployment` trong ZIP là tài liệu/file triển khai web và database,
không phải cấu hình máy trạm. Migration chỉ mở rộng CHECK constraint và enqueue/claim;
agent cũ tiếp tục dùng SKU/UID, agent 0.7.0 tự báo capability Fabric v1/v2/v3.

Chọn FABRIC RELAXATION trên web và nhập số tem. Tem 40 × 60 mm,
hai tem mỗi hàng; Mã hàng, Lot, Ngày và Giờ đều để trống để ghi tay.
`npm run dry-run:fabric` tạo ảnh và TSPL để xem trước, không gọi máy in.
Sau khi cập nhật, thử 1, 2 và 3 tem để kiểm tra căn giấy thực tế.

## Yêu cầu phát triển

- Windows 10/11 x64
- Node.js 20 trở lên
- Máy in TSC PE200 đã được cài trong Windows

## Cài dependency

```powershell
cd workstation-agent
pnpm install
```

Nếu máy phát triển chỉ có npm, có thể dùng `npm install`; file khóa chuẩn của dự án là `pnpm-lock.yaml`.

## Tạo preview, không in

```powershell
pnpm preview:sku
pnpm preview:uid
```

## Dựng TSPL, không in

```powershell
pnpm dry-run:sku
pnpm dry-run:uid
```

Kết quả nằm trong `preview`. Hai lệnh trên không gọi Windows Spooler.

## Cấu hình service

Sao chép `.env.example` thành `config\.env`, sau đó nhập Supabase URL, publishable key, token riêng của agent và tên máy in. Không đưa `.env` lên Git và không dùng service-role key trên máy trạm.

## Chạy kiểm tra

```powershell
pnpm test
pnpm diagnose
```

## Chạy service

```powershell
pnpm service
```

Queue backend phải hỗ trợ các action được mô tả trong `docs/QUEUE_CONTRACT.md`. Backend chưa được xây trong giai đoạn agent đầu tiên, vì vậy service chỉ chạy sau khi có URL và token hợp lệ.

## Cài Scheduled Task

Chạy PowerShell bằng quyền Administrator:

```powershell
.\powershell\install-agent.ps1
```

Script tạo task `Print SKU UID Agent` và không thay đổi AuditFactory, BIOS, nguồn điện, Wake-on-LAN hoặc network profile.
