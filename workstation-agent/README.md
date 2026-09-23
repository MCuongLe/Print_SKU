# Print SKU UID Agent

Agent Windows độc lập phục vụ ứng dụng Print SKU. Bản 0.6.1 sửa bố cục Fabric Relaxation: danh sách mã ở trên và một bộ Ngày/Giờ/Lot dùng chung bên dưới.

## Cập nhật Fabric Relaxation

Chờ lệnh in hiện tại hoàn tất, dừng agent cũ rồi cài ZIP theo quy trình hiện có.
Giữ nguyên `config/.env` và token máy trạm. Chạy `powershell/install-agent.ps1`
bằng quyền Administrator để cập nhật cùng Scheduled Task, không tạo agent thứ hai.

Quản trị hệ thống cần chạy `deployment/print_queue_v3_fabric_relaxation_multi_item.sql`
trong Supabase SQL Editor một lần và đưa `deployment/index.html` lên nơi phục vụ web.
Thư mục `deployment` trong ZIP là tài liệu/file triển khai web và database,
không phải cấu hình máy trạm. Migration chỉ mở rộng CHECK constraint và enqueue/claim;
agent cũ tiếp tục dùng SKU/UID, agent 0.6.1 tự báo capability Fabric v1/v2. Nếu đã chạy migration v3 khi cài 0.6.0 thì không cần cập nhật SQL lần nữa.

Chọn FABRIC RELAXATION trên web, nhập mã và số tem. Tem 40 × 60 mm,
hai tem mỗi hàng; mỗi tem có tối đa 5 mã xếp liên tiếp, bên dưới có một bộ Ngày/Giờ/Lot dùng chung, mỗi mục một dòng ghi tay.
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
