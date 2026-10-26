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
- `python scripts/live_status.py` (chỉ đọc) liệt kê tệp migration còn đối tượng chưa có trên DB, bản Edge so với commit cuối, agent, cron. Nguồn: (25/10 · N20261025-2144)
- Phát hành bằng `python scripts/release.py`: `--plan` (mặc định, chỉ đọc) in việc chờ; `--apply` chạy tuần tự migration → Edge → cổng Reload Extension (người làm) → push, mỗi cổng người gõ `y` trên terminal thật; `--status` in sổ; `--init` một lần (gõ `SEED`) tạo sổ rồi ghi nhận tệp và Edge đã chạy. Không có `--yes`; không có terminal thật thì thoát mã 2. Nguồn: (26/10 · N20261026-1548)
- Tệp migration đã sửa sau khi chạy (sha ở `HEAD` khác sổ) làm `--apply` dừng mã 3 trước mọi cổng và in `git diff --stat` từ commit trong sổ. Lối thoát: `--rerun <tệp>` (chạy lại; tệp phải idempotent) hoặc `--accept <tệp>` (chỉ cập nhật sha trong sổ, gõ nguyên tên tệp, không chạy SQL; dành cho sửa chú thích). Nguồn: (26/10 · N20261026-1548)
- Sổ `release_ledger` ở database ghi từng tệp migration, từng Edge (sha256 nội dung đã đổi CRLF → LF), bản Extension và khoá phát hành 30 phút. Việc chờ = tệp chưa có trong sổ; `supabase/*.example.sql` không phải migration. Giữ bởi: `tests/test_release.py`, `tests/release_ledger_sql.cjs`. Nguồn: (26/10 · N20261026-1548)
- `release.py` chỉ phát hành từ commit sạch: nguồn đọc từ `HEAD` (không đọc cây làm việc), cây làm việc không còn thay đổi chưa commit, `HEAD` không tụt `origin/main`, `commit_gate --commit HEAD` đạt. Tệp migration có DROP / DELETE / TRUNCATE phải gõ nguyên tên tệp, chỉ tệp đó được thêm `--allow-destructive`. Nguồn: (26/10 · N20261026-1548)
- Push của `release.py` đi bằng `git push origin <sha>:refs/heads/main` (sha chốt một lần trước preflight, kiểm lại HEAD và nhánh sau khi gõ `y`); script `deploy_<slug>.py` phải có ở commit; `--init` chỉ chạy được khi sổ chưa có dòng migration. Nguồn: (26/10 · N20261026-1548)
- Khối `DO` và `EXECUTE` động trong migration tính là rủi ro như DROP / DELETE: `release.py` đòi gõ nguyên tên tệp (lệnh chạy tay `apply_supabase_sql.py` vẫn chỉ xét DROP / DELETE cấp cao nhất). Nguồn: (26/10 · N20261026-1548)
- Hết giờ, mất mạng hoặc HTTP ≥ 500 khi chạy migration / deploy: `release.py` báo "KẾT QUẢ CHƯA RÕ", không ghi sổ, kiểm chỉ đọc rồi mới chạy lại; chỉ khi bị từ chối rõ ràng (HTTP 4xx trừ 408) mới nói chưa đổi gì. Giữ bởi: `tests/test_release.py`. Nguồn: (26/10 · N20261026-1548)
- Ghi sổ chỉ sau khi xác minh đạt: migration = đối tượng tệp tạo ra có trên database + các dòng `-- kiem:` trả true; Edge = version tăng đúng 1, `updated_at` sau lúc bắt đầu, dấu vết chuỗi ký tự dài của nguồn có trong bundle. Lỗi thì dừng, không rollback tự động. Nguồn: (26/10 · N20261026-1548)
- Migration mới ghi ở đầu tệp một dòng `-- kiem: <một câu SELECT một dòng trả true>` và khối `-- Rút lui` (lệnh lùi viết trong chú thích). Tệp cũ không bắt buộc; thiếu `-- kiem:` thì `release.py` in "xác minh yếu". Nguồn: (26/10 · N20261026-1548)
  - Câu `-- kiem:` đi qua `select_only` của `live_status.py`: không chứa insert / update / delete / drop / alter / create / truncate / grant / revoke, kể cả trong chuỗi.
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
- Extension đổi hành vi thì nâng phiên bản `manifest.json`, cập nhật mọi test và fixture ghim số đó (`commit_gate` liệt kê dòng còn sót) và ghi chú `extension/inside-po-connector/README.md`; Extension cũ phải tương thích hoặc bị cổng bản chặn. Giữ bởi: `commit_gate` (phiên bản Extension). Nguồn: `docs/DOI_AGENT.md` trước 25/10; (17/10, 21/10 · N0919, N1001, N1117)
- Mỗi thay đổi Extension / Edge / hợp đồng RPC phân loại trước khi lên: **tương thích ngược** (bản cũ vẫn chạy đúng, không nâng `min_extension`), **sửa sai dữ liệu** (bản cũ đọc sai mà vẫn ghi: nâng `min_extension` sau khi mọi máy đã Reload), **phá hợp đồng** (bản cũ không chạy được: nâng ngay khi lên, kèm thứ tự lên). Nguồn: (26/10 · N20261026-1102)
- Cổng bản: Extension (từ 0.10.10) và web gửi `extVersion` dạng `x.y.z` ở mọi lệnh Edge `sku-sync` / `group-uid-sync`; Edge ghi nhận máy ở `sync_auto_devices` và trả 409 `EXTENSION_OUTDATED` ở `lease`, `preview` (SKU), `prepare` (Group UID) khi `sync_auto_settings.min_extension[loại]` cao hơn bản gửi lên.
  - Mức rỗng = không chặn; chỉ đặt / hạ bằng SQL tay (Edge không cho đổi; CHECK từ chối giá trị sai dạng và khoá lạ).
  - Giữ bởi: `tests/sku_sync_function.mjs`, `tests/group_uid_sync_function.mjs`, `tests/sync_auto_v3_sql.cjs`, `tests/auto_sync_core.cjs`. Nguồn: (26/10 · N20261026-1102)
- Khối cổng bản chép giống hệt ở hai Edge (deploy gửi một tệp mỗi hàm); hàm so bản ở Extension và web cùng nghĩa, bảng ca so bản chung nằm trong `tests/sku_sync_function.mjs`. Edge lên trước migration phải vẫn chạy như cũ: ghi nhận máy bỏ qua lỗi, `ext_version` ghi lại không có cột. Nguồn: (26/10 · N20261026-1102)

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
