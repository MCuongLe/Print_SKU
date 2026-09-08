# Print SKU UID Agent

Agent Windows độc lập phục vụ ứng dụng Print SKU. Agent hỗ trợ tem SKU và tem Group UID, không phụ thuộc AuditFactory.

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
