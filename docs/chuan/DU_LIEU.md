# Chuẩn dữ liệu: Supabase, RPC, Edge, Extension (25/10/2026)

Áp cho: migration SQL, hàm RPC, Edge Function, lệnh Extension, luồng đồng bộ. Đọc khi: thêm / sửa hàm, bảng, Edge action, lệnh Extension, luồng dữ liệu mới.
Gom từ `docs/QUYET_DINH.md` chủ đề 3, 5, 6, 8, 9, `docs/DOI_AGENT.md` và số đo trên 87 tệp `supabase/*.sql` (25/10); không có luật mới. Luật nền (`SECURITY DEFINER` revoke, Supabase MCP chỉ đọc, thứ tự lên bản): `AGENTS.md`. Hàm nào nằm ở tệp migration nào: `docs/PROJECT_MAP.md` mục 4.

## Nơi lưu và quyền

- Màn / tab mới sinh dữ liệu (quét, đọc WMS, nạp tệp) mặc định lưu Supabase: ghi = máy đã kích hoạt hoặc Admin, xem = mọi người; chỉ hỏi người dùng khi muốn khác. Nguồn: (25/10 · N1212)
- RLS bật mọi bảng; client chỉ đi qua RPC `SECURITY DEFINER` hoặc Edge (service_role); anon chỉ `SELECT` `SKU_Name` với `status='1'`. Bảng không policy và hàm anon hiện có là cố ý; Edge `verify_jwt false` đúng thiết kế (Edge tự kiểm). Nguồn: (08/10, 17/10 · N0047, N0983, N0984)
- Hàm Admin chỉ cho `authenticated` và kiểm `group_uid_admin_allowed()` / `print_admin_allowed()` / `user_roles` ngay đầu hàm; không mở đăng ký tự do (thêm Admin qua Dashboard + `user_roles`); secret không vào `index.html`. Thiết lập Auth / bảo mật trong Dashboard do người dùng tự bấm. Nguồn: (17/10 · N0134–N0144, N0989, N0999); `docs/DOI_AGENT.md` trước 25/10
- Ghi ở xưởng (cắt, lấy mẫu, cấp vải, xả vải, quét UID blocked) chỉ máy đã kích hoạt (`floor_access_check`, không nhận khoá chung), đọc vẫn mở; lỗi kiểm quyền thì chặn (fail-closed). Nguồn: (17/10 · N0992, N0993)
- Lệnh in: `print_enqueue` kiểm khoá máy rồi mới gọi `print_enqueue_unchecked`. Nguồn: (10–17/10 · N0037, N0031, N0992)
- Người chưa đăng nhập Admin chỉ thấy phần trước @ của email người cập nhật; Admin thấy đầy đủ. Nguồn: (23/10 · N1185)

## Migration

- Chạy bằng `python scripts/apply_supabase_sql.py <tệp>` (`--dry-run` trước); `DROP` / `DELETE` cấp cao nhất cần `--allow-destructive`. `UPDATE` dữ liệu đặt trong migration. Nguồn: (10–18/10 · N0034, N0036, N0993, N1030)
- Đổi chữ ký hàm phải `drop` bản cũ (PostgREST không chọn giữa các overload). Nguồn: như trên.
- Sau migration lead kiểm chỉ đọc (đối tượng có trên DB, quyền, gọi thử) rồi mới báo đã lên. Nguồn: như trên; `docs/DOI_AGENT.md` bước 6.
- Sửa hàm đang chạy: so bản trên Supabase (`pg_get_functiondef`) với tệp mới nhất trong repo trước khi viết; lệch thì xuất phát từ bản đang chạy. Nguồn: `docs/DOI_AGENT.md` bước 1; (25/10 · N1212)
- Bỏ module vẫn giữ phần ở máy chủ khi gỡ có rủi ro (CHECK `print_jobs.type`, nhánh `fabric_relaxation`, migration cũ). Nguồn: (11/10 · N0035)

## Ghi an toàn và lỗi

- Hết giờ chờ phía client không chứng minh máy chủ chưa ghi: báo "chưa rõ", tải lại / tra lại rồi mới cho gửi lại. Nguồn: (19/09 · N0198); ví dụ đối soát theo mã thao tác trong `sourceName`: (24–25/10 · N1207, N1208)
- Lệnh in mang nonce; "Thử lại" dùng lại nonce cũ; lỗi giữa lô giữ thẻ và chỉ gửi nốt phần còn lại. Nguồn: (03/10, 17/10, 23/10 · N0079, N0953, N1178)
- Dữ liệu Supabase là bản đúng; bản lưu trên máy (IndexedDB, localStorage) chỉ để hiện nhanh hoặc chờ gửi, không ghi ngược. Nguồn: (18/10 · N1033, N1035)
- Giới hạn thời gian câu lệnh đo 24/10: vai `authenticated` 8 s, `anon` 3 s — danh sách lớn chia lô. Nguồn: (24–25/10 · N1207)

## Đồng bộ từ Inside / WMS

- Đọc nguồn qua Extension trong tab người dùng đã đăng nhập; token WMS / Inside không rời tab; Extension giữ phiên Admin Supabase riêng, không có service_role. Nguồn: (17/10 · N0923; N0134–N0144)
- Đọc hết vào bộ nhớ, kiểm nhất quán (tổng, trùng mã) rồi mới ghi; ghi qua staging theo `run_id`, luôn xem trước (preview) rồi mới apply; không tự xoá bản ghi `missing`; giảm mạnh → dừng (SAFETY_LIMIT). Nguồn: (08–22/10 · N0059, N0004, N0740, N0746, N0657)
- Dò API WMS / Inside chỉ bằng GET qua Chrome DevTools MCP; không dùng thao tác tạo job (export "By PO"); không dùng `get_network_request` (lộ token). Nguồn: (12/10 · N0003, N0004); `docs/DOI_AGENT.md` bước 1
- Extension đổi hành vi thì nâng phiên bản `manifest.json`, cập nhật mọi test khẳng định số đó và ghi chú `extension/inside-po-connector/README.md`; Extension cũ phải tương thích hoặc bị màn Admin chặn. Giữ bởi: `commit_gate` (phiên bản Extension). Nguồn: `docs/DOI_AGENT.md` trước 25/10; (17/10, 21/10 · N0919, N1001, N1117)

## Dọn dữ liệu (cron, giờ Việt Nam)

- `print_jobs` không phải lịch sử: xoá lệnh xong > 3 ngày lúc 03:00. Nguồn: (03/10, 08/10 · N0072, N0421, N0425)
- `sync_history_purge` 03:30 (changes 30 ngày, runs 180 ngày), không đụng dữ liệu nghiệp vụ. Nguồn: (10/10, 17/10 · N0040, N0934)
- UID Canceled > 180 ngày: thứ Hai 03:15; SKU ngừng > 180 ngày lưu trữ: thứ Hai 03:45. Nguồn: (11–16/10 · N0841, N0034, N0718)

## Khuôn hợp đồng luồng

Mỗi RPC / Edge action / lệnh Extension mới ghi hợp đồng trong tệp kế hoạch hoặc thiết kế (mục "Hợp đồng dữ liệu" của `docs/plans/README.md`):

```markdown
- **<tên RPC | action | lệnh>** — ai gọi: <web màn … | Extension | Edge>; quyền: <anon | máy đã kích hoạt | Admin>
  - Vào: <tham số, kiểu, giới hạn>
  - Ra: `{ok: true, data: {…}}` — <khoá camelCase, kiểu>
  - Lỗi: `{ok: false, error: {code, message}}` — <các mã>
  - Mẫu phản hồi thật: <đã lấy lúc …, chỉ ghi tên khoá / kiểu / định dạng mã, không giá trị thật>
```

Mẫu phản hồi thật lấy trước khi viết test giả (`docs/DOI_AGENT.md` bước 1; 25/10 · N1210).

## Quy ước đang dùng trong mã, chưa chốt thành luật (đo 25/10/2026)

- Hàm web gọi trả `{ok: true, data}` / `{ok: false, error: {code, message}}` (48 tệp); mã lỗi chữ hoa gạch dưới (`FORBIDDEN` 53 lần, `INVALID_INPUT` 45, `NOT_FOUND` 16, `ACCESS_DENIED` 7…), `message` tiếng Việt cho người dùng.
- Hàm nội bộ của luồng đồng bộ (Edge gọi bằng service_role) dùng `raise exception '<MÃ>'` (20 tệp).
- Khoá JSON trả về camelCase (`updatedAt`, `runId`, `groupUid`…), cột bảng snake_case.
- Tệp migration `<module>_v<n>.sql`, bọc `begin; … commit;` rồi `notify pgrst, 'reload schema';` (12/12 tệp mới nhất); hàm đặt `set search_path = ''` (74/87 tệp).
