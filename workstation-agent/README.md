# Print SKU UID Agent

Agent Windows độc lập phục vụ ứng dụng Print SKU. Bản 0.7.0 dùng tem Fabric Relaxation viết tay hoàn toàn; frontend chỉ chọn số lượng tem.

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
