# Xoá lệnh đã in khi Admin đăng nhập (2026-11-04)

Trạng thái (04/11/2026 22:09): **CHỈ LÀ KẾ HOẠCH.** Chưa build, chưa migration, chưa deploy, chưa commit. Người dùng đã chốt 5 câu: KHÔNG tự xoá khi đăng nhập, chỉ làm nút xoá thủ công. Việc cần build là **Việc 6**; Việc 1–2 (tự xoá khi đăng nhập) HOÃN.

## Thiết kế

- **Yêu cầu (04/11/2026):** "Lập kế hoạch xóa dữ liệu lệnh đã in khi đăng admin."
- **Hiểu yêu cầu:** khi Admin đăng nhập vào web, máy chủ xoá các dòng lệnh in ĐÃ IN XONG (`print_jobs.status = 'completed'`) đã quá hạn giữ.
- **Điều cần biết trước:** việc dọn đã có sẵn.
  - Cron `print-jobs-purge` (jobid 1, 03:00 giờ VN) gọi `print_jobs_purge()`: xoá lệnh `completed` / `failed` / `cancelled` cũ hơn 3 ngày, cứ 3 ngày một lần. (08/10 · N0421, N0425)
  - Cùng hàm đó còn đóng lệnh `queued` kẹt `agent_id` > 30 phút thành `failed` `SENT_UNCONFIRMED` (chống in trùng). Phần này phải giữ. (23/10 · N1185)
  - Vì vậy kích hoạt khi đăng nhập chỉ thêm giá trị nếu người dùng muốn GIỮ NGẮN HƠN 3 ngày hoặc muốn dọn ngay lúc mình đăng nhập. Nếu giữ nguyên 3 ngày thì người dùng gần như không thấy khác gì.
- **Kết quả nhìn thấy được (theo khuyến nghị):**
  - Admin đăng nhập → máy chủ tự xoá lệnh đã in quá 24 giờ; không hộp thoại, không câu hướng dẫn.
  - Đang ở màn Lệnh in (`#admin/lenh-in`) thì hiện một chip nhỏ icon thùng rác + số lệnh đã dọn, rồi danh sách tải lại. Ở màn khác không hiện gì.
  - Màn Lệnh in từ đó chỉ còn lệnh trong ~24 giờ gần nhất (kèm lệnh đang chờ / đang in / lỗi / huỷ), thay vì 3–6 ngày như hiện nay.
- **Đã chốt với người dùng (04/11/2026 22:09):**
  - Không tự xoá khi đăng nhập Admin; chỉ làm nút xoá thủ công ở màn Lệnh in (Việc 6). Quyết định cũ về cron 3 ngày (08/10 · N0072, N0421, N0425) KHÔNG đổi.
  - Xoá thủ công lệnh Xả vải xoá luôn dòng `xa_vai_measures` gắn lệnh ("Xoá cả hai").
  - Không sao lưu CSV. Giữ nguyên cron 03:00 (mặc định, người dùng không phản đối).
  - Đã trả lời "24 giờ" và "chỉ lệnh đã in xong" cho câu 1–2: chỉ có nghĩa nếu sau này bật lại việc tự xoá (Việc 1–2); xoá thủ công không áp hạn 24 giờ (xem Việc 6).
- **Số đo thật** (Supabase MCP chỉ đọc, 04/11/2026 21:49 giờ VN, project `ikzhitdqkoatlmkrxuuh`):
  - `print_jobs`: 70 dòng, 100% `completed` (sku 42, group_uid 23, xa_vai_sheet 5). Cũ nhất 30/10 01:01 UTC (~5 ngày), mới nhất 04/11 10:25 UTC.
  - Tuổi: < 24 giờ 15 lệnh · 1–2 ngày 16 · 2–3 ngày 14 · > 3 ngày 25. Mỗi ngày làm việc 9–16 lệnh; chủ nhật 01/11 0 lệnh.
  - Dung lượng: `print_jobs` 416 kB (kể cả chỉ mục), `print_events` 736 kB (497 dòng, ~7 sự kiện / lệnh), tổng ≈ 16,5 kB / lệnh. Không dọn sẽ tăng ~0,25 MB/ngày ≈ 90 MB/năm; đang giữ ≤ 6 ngày nên ≈ 1,2 MB. Dung lượng KHÔNG phải lý do xoá.
  - Cron: 27 lần `succeeded`; lần xoá thật gần nhất 01/11 20:00 UTC (xoá 56, còn 25); lần xoá thật kế tiếp 04/11 20:00 UTC (= 05/11 03:00 VN), ước xoá 25 lệnh > 3 ngày.
  - Phụ thuộc vào `print_jobs.id` (truy vấn `pg_constraint`, `information_schema`):
    - `print_events.job_id` ON DELETE CASCADE.
    - `xa_vai_measures.print_job_id` ON DELETE SET NULL (8 dòng, đều `printed`, đều có `print_job_id`).
    - `print_jobs.reprint_of` ON DELETE SET NULL.
    - `cut_group_uids.print_job_id` KHÔNG có khoá ngoại (616 dòng, 0 dòng `queued`).
    - `sku_po_receipts` (43 dòng) không tham chiếu `print_jobs`.
  - Trigger trên `print_jobs`: `print_jobs_wake_agent`, `sku_po_receipts_capture` (INSERT), `xa_vai_measures_sync_job` (UPDATE status). Không trigger nào chạy khi DELETE.
  - Chỉ mục `print_jobs_nonce_key` (UNIQUE nonce) là lớp chống gửi trùng ở máy chủ; xoá dòng thì lớp này mất theo dòng đó.
  - `user_roles`: 4 tài khoản `admin`. Hàm `print_admin_allowed()` = `user_roles.role = 'admin'` cho `auth.uid()`.
  - Tên cột thật ở Xả vải là `xa_vai_measures.print_job_id` (không phải `printed_job_id`). Web chỉ dùng `printJobId` của dòng `queued` / `printing` (Cắt UID, Xả vải), không dùng với dòng đã xong.
  - Agent `workstation-agent` đánh thức bằng broadcast từ trigger, không nghe `postgres_changes`; xoá dòng không đánh thức agent. Extension và Edge không đọc `print_jobs`.

### Phạm vi xoá chính xác

| Đối tượng | Quyết định | Lý do |
|---|---|---|
| `print_jobs` `completed`, `COALESCE(completed_at, created_at)` cũ hơn hạn giữ | **XOÁ** | Đây là "lệnh đã in" |
| `print_jobs` `queued` / `claimed` / `rendering` / `sending` / `spooling` | GIỮ | Đang chờ hoặc đang in; cron cũng không xoá |
| `print_jobs` `failed` / `cancelled` | GIỮ (theo khuyến nghị câu 2) | Admin cần xem lỗi và in lại; cron vẫn dọn sau 3 ngày |
| Lệnh `group_uid` còn UID `cut_group_uids.print_status = 'queued'` trỏ tới | GIỮ | Màn Cắt UID đánh dấu `printed` bằng `print_job_status` ở trình duyệt; xoá sớm thì UID kẹt `queued` (`cut_group_uid_mark_result` không cho `printed` khi mất lệnh) |
| Lệnh có `xa_vai_measures.status = 'printing'` trỏ tới | GIỮ (phòng thủ; trigger đã đưa về `printed` cùng giao dịch) | Không để dòng Xả vải mất liên kết lệnh đang in |
| `print_events` của lệnh bị xoá | XOÁ theo CASCADE (không xoá riêng) | Sự kiện không có ý nghĩa khi mất lệnh; ~7 dòng / lệnh |
| `print_agents`, `print_devices`, `print_activation_codes`, `print_maintenance` | KHÔNG đụng | Sổ máy / khoá / lịch dọn, không phải lệnh |
| `sku_po_receipts`, `xa_vai_measures`, `cut_group_uids`, `group_uid_*` | KHÔNG xoá dòng nào | Kết quả nghiệp vụ nằm ở đây; chỉ `xa_vai_measures.print_job_id` về NULL (đã chốt ở khoá ngoại) |
| Nhật ký agent trên máy trạm (`C:\PrintSKUAgent`, sổ gửi `sent-journal`) | KHÔNG đụng | Ngoài Supabase |

- **Tuổi tối thiểu:** sàn cứng 1 giờ trong hàm (web không đặt được); mức mặc định theo câu 1 (khuyến nghị 24 giờ). Vì: web đang thăm dò kết quả lệnh vừa in (`print_job_status`) trong vài phút; 24 giờ chặn luôn nguy cơ gửi lại nonce cũ sau khi dòng nonce đã mất.
- **In lại / tem chờ in KHÔNG phụ thuộc lệnh đã xoá:** in lại tem SKU có PO dùng `sku_po_receipts`; Xả vải in lại dùng `xa_vai_measures` + `item_code`; tem chờ in của Cắt UID dùng `cut_group_uids`. Chỉ nút "In lại" ở màn Lệnh in Admin cần lệnh gốc (đã trả `NOT_FOUND` "có thể đã được dọn" khi lệnh mất).
- **Hệ quả đã có sẵn từ cron, không phải mới:** `cut_group_uids.print_job_id` treo (không khoá ngoại); `xa_vai_measures.print_job_id` về NULL; `print_jobs.reprint_of` của lệnh in lại về NULL (lệnh in lại còn, mất liên kết tới lệnh gốc).

### Cách kích hoạt khi đăng nhập Admin

- **Điểm gắn:** sự kiện `print-sku-admin-ready` do `PrintSkuAdminAuth` bắn khi phiên được xác thực (`becameAuthorized`).
  - Bắn mỗi lần tải trang có phiên Admin (phiên nằm ở `sessionStorage`, nên mở tab mới / tải lại cũng bắn lại) và sau mỗi lần đăng xuất rồi đăng nhập.
  - Khối `print-jobs-admin-script` đã nghe sự kiện này (để gọi `route`); thêm một trình nghe riêng chạy ở MỌI màn Admin, không chỉ `#admin/lenh-in`.
- **Chạy lặp:** hàm máy chủ giữ giới hạn tần suất (6 giờ) trong `print_maintenance` (task `print_jobs_purge_admin`, khoá dòng `for update` để 4 Admin đăng nhập cùng lúc chỉ có một người chạy). Web thêm cờ "đã gọi trong lần xác thực này", đặt lại khi `print-sku-admin-logout`.
- **Sự kiện bắn trước khi khối nạp xong** (đã có ghi chú ở khối khác, `index.html` ~18054): lúc khởi động hỏi `PrintSkuAdminAccess.peekToken()`; có token thì coi như đã đăng nhập và gọi một lần.
- **Phương án (khuyến nghị đứng đầu):**
  1. **Tự chạy im lặng + chip kết quả + trần an toàn (KHUYẾN NGHỊ).** Hệ quả: Admin không phải bấm gì; xoá không hỏi nhưng có trần 200 lệnh / lần (vượt thì hỏi `WhDialog.confirm` kèm số lệnh), giới hạn 6 giờ và nhật ký.
  2. **Hộp xác nhận `WhDialog.confirm` kèm số lệnh mỗi lần đăng nhập.** Hệ quả: an toàn nhất nhưng hộp hiện ở mỗi tab / mỗi lần tải lại, 4 Admin dễ bấm đại mà không đọc.
  3. **Nút dọn thủ công (icon thùng rác + số đếm xem trước) trên màn Lệnh in, không tự chạy.** Hệ quả: không đúng chữ "khi đăng nhập"; quên bấm thì dữ liệu tồn lại tới cron.
- **Lỗi khi gọi** (mạng, 401 / 403, 404 vì migration chưa chạy, hết giờ): im lặng, ghi `console.warn`, không thử lại vòng lặp, không chặn đăng nhập hay màn Lệnh in. Lần đăng nhập sau thử lại. Timeout phía client không chứng minh máy chủ chưa xoá: kết quả đúng nằm ở nhật ký máy chủ.

### Hợp đồng dữ liệu

- **`print_jobs_purge_admin(p_dry_run boolean default true, p_confirm boolean default false)`** — ai gọi: web, khối `print-jobs-admin-script`; quyền: Admin (`print_admin_allowed()` kiểm ngay đầu hàm), chỉ `authenticated`.
  - Vào: `p_dry_run` (mặc định `true` = chỉ đếm, không xoá, không ghi nhật ký, không tính giới hạn tần suất); `p_confirm` (cho phép xoá khi số lệnh đủ điều kiện vượt trần im lặng).
  - Chính sách đặt cứng trong hàm, KHÔNG là tham số (web không nâng được): trạng thái `completed`; hạn giữ theo câu 1; sàn 1 giờ; tần suất 6 giờ; trần im lặng 200 lệnh; trần mỗi lần gọi 2.000 lệnh.
  - Ra: `{ok: true, data: {dryRun, eligible, deletedJobs, deletedEvents, byType: {sku, group_uid, xa_vai_sheet}, oldestAt, newestAt, protectedCount, hasMore, skipped, nextAllowedAt, keepHours}}`.
  - Lỗi: `{ok: false, error: {code, message}}` — `FORBIDDEN` (không phải Admin); `NEEDS_CONFIRM` (kèm `eligible`, chưa xoá gì).
  - Mẫu phản hồi thật: chưa có; lấy một mẫu từ lần chạy dry-run thật sau migration, ghi tên khoá và kiểu, dùng dữ liệu giả cho test (`docs/DOI_AGENT.md` bước 1).
- **`public._print_jobs_purge_core(p_keep interval, p_dry_run boolean, p_max_rows integer, p_actor uuid, p_actor_name text)`** — phần làm việc thật; `revoke all … from public, anon, authenticated`, không `grant`; chỉ hàm bọc và kịch bản kiểm gọi.
  - Xoá theo lô: mỗi lô ≤ 500 dòng bằng `delete … where id in (select id … for update skip locked limit 500)`, lặp tới trần 2.000; còn dư thì `hasMore = true`, lần đăng nhập sau xoá tiếp.
  - Chọn dòng đủ điều kiện = `completed` + quá hạn + `not exists` Cắt UID `queued` + `not exists` Xả vải `printing`; `protectedCount` = số lệnh `completed` quá hạn nhưng bị giữ vì hai điều kiện sau.
  - Mọi hàm `SECURITY DEFINER` đặt `set search_path = ''` (viết tên đầy đủ `public.…`), có `revoke execute … from public, anon, authenticated` rồi chỉ `grant execute … to authenticated` cho hàm bọc. (`AGENTS.md` luật kỹ thuật)
- **Bảng `public.print_jobs_purge_log`** (nhật ký, RLS bật, không policy, `revoke all` từ anon / authenticated):
  - Cột: `id bigint identity`, `ran_at timestamptz`, `actor_id uuid`, `actor_name text`, `trigger text` ('admin_login' | 'admin_manual'), `keep_hours integer`, `eligible integer`, `deleted_jobs integer`, `deleted_events integer`, `deleted_xa_vai integer default 0` (chỉ nhánh xoá thủ công), `by_type jsonb`, `oldest_created_at`, `newest_created_at`, `outcome text` ('deleted' | 'needs_confirm').
  - Mỗi lần chạy thật một dòng, kể cả lần xoá 0; KHÔNG lưu payload, SKU, UID (chỉ số đếm và mốc thời gian). Lần chỉ đếm (dry-run) và lần bị giới hạn tần suất không ghi dòng.
  - Không tự dọn nhật ký: ≤ 4 dòng / ngày ≈ 300 kB / năm; xem lại khi quá 10.000 dòng.
  - Ai xem: lead qua Supabase MCP chỉ đọc; chưa có màn.

### Rủi ro và cách chặn

- **Không hoàn tác.** Xoá là xoá dòng thật; app không có đường khôi phục.
  - Chặn: chỉ `completed` quá hạn; sàn 1 giờ; trần 200 lệnh im lặng; `p_dry_run` mặc định `true`; nhật ký số đếm.
  - Không dựa vào bản sao lưu tự động của Supabase (chưa kiểm gói nào có hay không, không ghi vào kế hoạch).
- **Có cần sao lưu CSV ngoài git như lần dọn `sample_bags` không?** Khuyến nghị KHÔNG: cron đã xoá cùng loại dữ liệu hằng tuần từ 08/10 không sao lưu; kết quả nghiệp vụ nằm ở bảng khác; 70 dòng ≈ 64 kB. Nếu người dùng muốn (câu 4) thì thêm nút "Tải CSV" trước khi xoá lần đầu: cộng việc, không nằm trong khung này.
- **Mất nonce → gửi trùng:** sau khi dòng bị xoá, `print_jobs_nonce_key` không còn chặn nonce cũ. Chặn: sàn hạn giữ ≥ 24 giờ (khuyến nghị); sổ gửi `sent-journal` ở agent là lớp thứ hai. Không xoá được lệnh `failed` / `queued` nên "Thử lại" lệnh lỗi vẫn gặp dòng cũ. Nếu người dùng chọn hạn 0 thì rủi ro này tăng: nêu rõ ở câu 1.
- **Cắt UID kẹt `queued`:** chặn bằng điều kiện `not exists`; kiểm bằng kịch bản T4 (dưới). Lỗ hổng tương tự ở cron hiện nay (xoá sau 3 ngày không kiểm) ghi ở "Phát sinh", không sửa trong đợt này.
- **Hai Admin đăng nhập cùng lúc / hai tab:** khoá dòng `print_maintenance` cho `for update`; người thứ hai nhận `skipped`.
- **Màn Lệnh in đang mở lệnh sắp bị xoá:** `print_admin_job` đã trả `NOT_FOUND`; web hiện thông báo lệnh đã dọn như hiện nay.
- **Hết giờ câu lệnh (vai `authenticated` 8 giây):** trần 2.000 lệnh + lô 500 dòng; số đo hiện nay ~15 lệnh / ngày nên mỗi lần chỉ xoá vài chục dòng.
- **Web cũ / migration chưa chạy:** web cũ không gọi hàm mới (vô hại, vẫn có cron). Web mới gọi hàm chưa có → 404, im lặng. Vì vậy luật 4: migration trước khi push.
- **Claude không tự xoá dữ liệu thật:** mọi lệnh Supabase của Claude trong đợt này là SELECT. Kiểm hàm bằng giao dịch tự huỷ (`ROLLBACK`) chỉ chạy sau khi người dùng cho phép rõ (DELETE).
- **Nhiều phiên cùng sửa cây làm việc:** `index.html`, `docs/QUYET_DINH.md`, `tests/bridge_ready.cjs` còn hunk chưa commit của phiên "phủ lot theo PO". Commit tách hunk, chỉ phần của đợt này (`docs/chuan/KIEM_THU_GIT.md`).

### Tương thích

- Agent máy trạm: `print_agent_claim` / `complete` / `fail` / `progress` / `requeue` không đổi; agent cũ chạy y nguyên; không cần cài lại agent.
- Extension: không đọc `print_jobs`; không nâng phiên bản, không Reload. Phân loại: **tương thích ngược**.
- Edge: không đổi.
- Cron `print_jobs_purge` (03:00) GIỮ NGUYÊN: vẫn đóng `SENT_UNCONFIRMED`, dọn `failed` / `cancelled`, dọn sự kiện mồ côi, và là lưới an toàn khi không ai đăng nhập. Hệ quả: lệnh đã in tồn ≤ hạn giữ + thời gian tới lần đăng nhập Admin kế tiếp (tối đa 3–6 ngày nếu không ai đăng nhập).
- Web cũ đang mở: không bị ảnh hưởng.

### Chưa kiểm được bằng máy

- Đăng nhập Admin thật trên Chrome: chip kết quả; không có lỗi console; danh sách Lệnh in tải lại đúng sau khi dọn.
- Bốn Admin đăng nhập gần nhau: chỉ một lần xoá, nhật ký đúng người.
- Lần dọn thật đầu tiên trên dữ liệu thật: số dòng xoá khớp số đếm dry-run cùng thời điểm.
- Đồng hồ ranh giới 24 giờ theo giờ Việt Nam (lệnh in lúc 21:49 hôm nay còn hay mất lúc 21:50 hôm sau).

## Chờ người dùng chốt

**Đã trả lời 04/11/2026 22:09:** câu 1 = 24 giờ; câu 2 = chỉ lệnh đã in xong; câu 3 = chỉ nút xoá thủ công, không tự chạy (đổi hướng: Việc 1–2 hoãn); câu 4 = không CSV; câu 5 = giữ cron (mặc định). Nội dung câu hỏi giữ lại dưới đây để lần sau bật lại việc tự xoá.

1. **Giữ lệnh đã in bao lâu trước khi bị xoá lúc Admin đăng nhập?** Khuyến nghị: **24 giờ**.
   - 24 giờ: màn Lệnh in chỉ tìm lại được hôm nay + nửa ngày hôm qua; chặn nguy cơ gửi trùng nonce.
   - 3 ngày (như cron): gần như không đổi gì người dùng thấy.
   - 0 (xoá hết lệnh đã in): màn Lệnh in trống sau mỗi lần đăng nhập, nút In lại Admin không còn lệnh gốc, nguy cơ trùng nonce tăng.
2. **Xoá những trạng thái nào?** Khuyến nghị: **chỉ `completed`** (đúng nghĩa "đã in").
   - Thêm `failed` / `cancelled`: sạch hơn nhưng mất chỗ xem lỗi và in lại sau sự cố.
3. **Kích hoạt thế nào?** Khuyến nghị: **phương án 1** — tự chạy im lặng sau đăng nhập, giới hạn 6 giờ, trần 200 lệnh (vượt thì hỏi `WhDialog.confirm`), chip kết quả ở màn Lệnh in.
   - Phương án 2 (xác nhận mỗi lần): an toàn nhất, hộp hiện liên tục.
   - Phương án 3 (nút thủ công): không tự chạy, không đúng "khi đăng nhập".
4. **Có cần sao lưu CSV các lệnh bị xoá không?** Khuyến nghị: **không** (cron đã xoá cùng loại dữ liệu từ 08/10 không sao lưu; chỉ giữ nhật ký số đếm).
   - Có: thêm nút "Tải CSV" và một bước tải trước lần xoá đầu tiên.
5. **Giữ nguyên cron 03:00 hằng đêm?** Khuyến nghị: **giữ** (còn đóng lệnh kẹt `SENT_UNCONFIRMED` và dọn `failed` / `cancelled`).
   - Bỏ phần `completed` khỏi cron: chỉ còn xoá khi có Admin đăng nhập; không ai đăng nhập thì lệnh đã in tồn mãi.

## Kế hoạch

Thứ tự chạy hiện hành (04/11 22:09): Việc 0 xong → **Việc 6** (xoá thủ công) → kiểm, review (khuôn Việc 3) → tài liệu (khuôn Việc 5) → commit khi người dùng nói → phát hành (khuôn Việc 4). Việc 1 và 2 (tự xoá khi đăng nhập) HOÃN, giữ nguyên nội dung bên dưới để tái dùng; Việc 6 chạm quyền và xoá dữ liệu nên do một lead Fable / Opus làm, phần tài liệu do phiên Sonnet.

### Việc 0 — Chốt 5 câu · người dùng · [x]
- [x] Người dùng trả lời 5 câu (04/11 22:09, xem "Chờ người dùng chốt"); nhật ký `RULES.md` ghi ở mã `[N20261104-2203]` và mục ghi quyết định 5 câu.
- [x] Không đổi quyết định cũ về cron 3 ngày (N0421, N0425): không tự xoá khi đăng nhập nên hạn giữ không đổi.

### Việc 1 (HOÃN — tự xoá khi đăng nhập) — Migration `supabase/print_jobs_purge_admin_v1.sql` · lead (hoặc `thuc-thi-logic`) · [ ]
- Tệp và neo: tệp mới `supabase/print_jobs_purge_admin_v1.sql`; tham chiếu khuôn `print_job_cancel` trong `supabase/backend_hygiene_v1.sql` (`create or replace function public.print_job_cancel`) và `print_jobs_purge` cùng tệp (`-- ---------- (a) P2: print_jobs_purge`).
- [ ] Trước khi viết: so `pg_get_functiondef` của `print_job_cancel`, `print_jobs_purge`, `print_admin_allowed` trên Supabase (MCP chỉ đọc) với bản mới nhất trong repo; ghi kết quả so sánh vào nhật ký. Bằng chứng: kết quả so sánh.
- [ ] Tệp có dòng `-- kiem:` (một `SELECT` trả `true`: hàm bọc có, hàm lõi có, bảng nhật ký có RLS bật, `has_function_privilege` anon = false) và khối `-- Rút lui` (hủy hàm, hủy bảng nhật ký — ghi rõ cần `--allow-destructive`). Bằng chứng: tệp.
- [ ] Bảng `print_jobs_purge_log` + hai hàm theo mục "Hợp đồng dữ liệu"; `revoke … from public, anon, authenticated`; chỉ `grant execute` hàm bọc cho `authenticated`.
- [ ] `notify pgrst, 'reload schema'` ở cuối.
- [ ] Test đỏ trước: `tests/print_jobs_purge_admin_sql.cjs` (kiểm văn bản tệp, khuôn `tests/backend_hygiene_sql.cjs`). Lệnh `node tests/print_jobs_purge_admin_sql.cjs`: chạy khi CHƯA có tệp migration phải ĐỎ, sau khi viết mong đợi PASS. Khẳng định:
  - `security definer` + `set search_path = ''`; `print_admin_allowed()` ở đầu hàm bọc.
  - Chỉ `status = 'completed'`; có điều kiện bảo vệ Cắt UID `queued` và Xả vải `printing`.
  - `p_dry_run` mặc định `true`; có sàn 1 giờ, tần suất 6 giờ, trần 200 / 2.000; có `for update skip locked`.
  - Có ghi `print_jobs_purge_log` và `print_maintenance`; hàm lõi không `grant`.
  - Không `truncate`, không `drop` hàm hiện có, không `delete` ngoài `print_jobs`.
- Ngoài phạm vi: đổi `print_jobs_purge` (cron) — kể cả lỗ hổng Cắt UID `queued` của cron (xem "Phát sinh").

### Việc 2 (HOÃN — tự xoá khi đăng nhập) — Web: khối `print-jobs-admin-script` · lead · [ ]
- Tệp và neo: `index.html` → `id="print-jobs-admin-script"` (tìm bằng `python scripts/index_outline.py print-jobs-admin`); neo `async function rpc(name,args,retry=true)` và `addEventListener("print-sku-admin-ready",route)`. Không sửa theo số dòng; Grep luôn giới hạn độ dài dòng.
- [ ] Hàm `purgeOnLogin()`: gọi `rpc("print_jobs_purge_admin",{p_dry_run:false})` một lần mỗi lần xác thực; xử lý `skipped`, `deletedJobs > 0`, `NEEDS_CONFIRM` (`WhDialog.confirm` có số lệnh → gọi lại với `p_confirm:true`; Huỷ thì thôi), mọi lỗi khác im lặng. Bằng chứng: test trình duyệt.
- [ ] Trình nghe `print-sku-admin-ready` riêng (không phụ thuộc `route`) + kiểm `PrintSkuAdminAccess.peekToken()` lúc khởi động + cờ đặt lại ở `print-sku-admin-logout`.
- [ ] Chip kết quả icon thùng rác (Lucide) + số, tự tắt sau ~4 giây, chỉ khi đang ở `#admin/lenh-in` (`#pj-top-chips` hoặc `#pj-status`); sau đó `loadJobs(true)`. Chữ ngắn, không câu hướng dẫn. Admin chỉ xét máy tính (≥ 1024 px).
- [ ] Test đỏ trước: `tests/print_jobs_purge_login_browser.cjs` (Playwright, Supabase giả lập theo khuôn `tests/print_jobs_admin_browser.cjs`, `BASE` đổi được). Lệnh `node tests/print_jobs_purge_login_browser.cjs`: ĐỎ trước khi sửa `index.html`, sau đó PASS. Mỗi ý một ca:
  - (1) Đăng nhập Admin giả → đúng một lần gọi RPC với `p_dry_run:false`.
  - (2) Tải lại tab / trả `skipped` → không chip, không lỗi.
  - (3) `deletedJobs = 3` ở màn Lệnh in → chip có số 3 rồi danh sách tải lại.
  - (4) `deletedJobs = 3` ở màn Cắt UID → không chip.
  - (5) `NEEDS_CONFIRM` → `WhDialog.confirm` có số lệnh; "Xác nhận" gọi lại với `p_confirm:true`; "Huỷ" không gọi lại.
  - (6) RPC trả 403 / 500 / 404 / mất mạng → không thông báo lỗi, không vòng lặp, màn Lệnh in vẫn dùng được.
  - (7) Chưa đăng nhập → không gọi.
  - (8) Đăng xuất rồi đăng nhập lại → gọi lại.
  - (9) Sự kiện đã bắn trước khi khối nạp → vẫn đúng một lần.
  - (10) Không lỗi console.
- [ ] Chạy lại `tests/print_jobs_admin_browser.cjs` và `tests/admin_entry_browser.cjs` (bản giả lập có thể không biết RPC mới: phải im lặng, không đổi kết quả cũ). Bằng chứng: PASS cả hai.
- Ngoài phạm vi: màn xem nhật ký dọn; nút tải CSV (trừ khi câu 4 = có); bản điện thoại của Admin.

### Việc 3 — Kiểm, review · lead + `kiem-thu` + Codex + `review-claude` + `co-van` · [ ]
- [ ] Kịch bản trên Supabase thật trong MỘT giao dịch rồi `ROLLBACK`, chỉ dòng giả (nonce `purge-test-<n>`, SKU `9000000xx`, UID `1028260000000xxx`). **Cần người dùng cho phép rõ (có lệnh DELETE)**; kịch bản tạm nằm ngoài git (scratchpad), đóng vai Admin bằng `set_config('request.jwt.claims', …, true)` với id một Admin đọc từ `user_roles`. Bằng chứng: bảng kết quả từng kịch bản.
  - T1 không phải Admin → `FORBIDDEN`, 0 dòng đổi.
  - T2 `p_dry_run = true` đếm đúng, 0 dòng đổi, 0 dòng nhật ký.
  - T3 `completed` 25 giờ bị xoá; `completed` 23 giờ giữ; `queued` / `claimed` / `rendering` / `sending` / `spooling` / `failed` / `cancelled` cũ 10 ngày giữ.
  - T4 lệnh `group_uid` `completed` có `cut_group_uids` `queued` → giữ; sau khi UID `printed` → xoá.
  - T5 `xa_vai_measures` `printed` trỏ lệnh bị xoá → `print_job_id` NULL, `status` / `item_code` / `actual_mm` còn nguyên.
  - T6 `print_events` của lệnh bị xoá mất hết (CASCADE), không còn mồ côi.
  - T7 lệnh in lại: `reprint_of` về NULL, lệnh in lại còn.
  - T8 gọi lần 2 trong 6 giờ → `skipped`, không thêm dòng nhật ký.
  - T9 201 lệnh đủ điều kiện → `NEEDS_CONFIRM`, 0 xoá; `p_confirm = true` → xoá, nhật ký đúng số.
  - T10 nhật ký đúng `actor_id`, `by_type`, `oldest_created_at`, `newest_created_at`.
  - T11 quyền: `has_function_privilege` anon = false, authenticated = true cho hàm bọc; cả hai = false cho hàm lõi.
- [ ] Codex (tối đa 3 vòng, vòng sau chỉ phần vừa sửa) + `/review-claude` song song + `co-van` lọc; ghi sửa / làm sau / bỏ qua kèm lý do.
- [ ] Cả bộ `python scripts/run_tests.py` PASS; `python scripts/commit_gate.py` KHÔNG ĐẠT = 0; `git diff --check` sạch. Bằng chứng: dòng tổng kết nguyên văn.

### Việc 4 — Phát hành (luật 4) · lead · [ ]
- Điều kiện: người dùng nói commit; commit tách hunk (không đụng hunk của phiên khác); chưa push.
- [ ] `python scripts/apply_supabase_sql.py supabase/print_jobs_purge_admin_v1.sql --dry-run`; dry-run cho biết có cần `--allow-destructive` không (có `DELETE` trong thân hàm). Nếu cần thì xin phép người dùng rõ cho đúng tệp này, không tự thêm cờ.
- [ ] Chạy thật migration. Kiểm chỉ đọc (MCP): hàm và bảng có; dòng `-- kiem:` trả `true`; anon không gọi được; gọi hàm bọc bằng vai `postgres` trả `FORBIDDEN` (`auth.uid()` rỗng) — không xoá gì.
- [ ] Không cần deploy Edge, không Reload Extension, không cài lại agent.
- [ ] Push `main` (web lên ngay) — SAU migration.
- [ ] Ghi sổ: `python scripts/record_ledger.py supabase/print_jobs_purge_admin_v1.sql`; ghi `docs/QUYET_DINH.md` mục "Trạng thái lên thật".
- [ ] Người dùng đăng nhập Admin thật. Lead kiểm chỉ đọc: `print_jobs_purge_log` có đúng một dòng mới; `deleted_jobs` khớp số lệnh đủ điều kiện đo ngay trước đó; `print_maintenance` có task `print_jobs_purge_admin`; `count(*) from print_events where job_id not in (select id from print_jobs)` = 0. Bằng chứng: kết quả truy vấn.

### Việc 5 — Tài liệu · Sonnet · [ ]
- [ ] `docs/QUYET_DINH.md` mục 3: sửa dòng "`print_jobs` KHÔNG phải lịch sử" (thêm luật xoá khi Admin đăng nhập, hạn giữ, phạm vi, bảo vệ Cắt UID / Xả vải); mục 9 và mục "Trạng thái lên thật" khi lên thật; mục 12 bỏ dòng "chờ chốt" nếu có.
- [ ] `docs/chuan/DU_LIEU.md` mục "Dọn dữ liệu": cập nhật dòng `print_jobs` (và dòng hợp đồng RPC nếu khuôn yêu cầu).
- [ ] `docs/PROJECT_MAP.md`: mục 2 (hàng Lệnh in / QUẢN TRỊ thêm hàm và test mới), mục 4 (chuỗi migration "In:" thêm `print_jobs_purge_admin_v1`).
- [ ] `README.md` mục module Lệnh in: hành vi mới (hạn giữ, chip), một đoạn ≤ 600 ký tự.
- [ ] Nhật ký `RULES.md` mã `[N<yyyymmdd>-<hhmm>]` (quyết định, số đo trên, commit / lên thật, chưa kiểm); bộ nhớ dự án `project_print_jobs_manually_purged` cập nhật theo kết quả.
- [ ] `python scripts/commit_gate.py --cached` không cảnh báo dòng > 400 ký tự; mọi mã `N…` grep ra đúng một dòng trong `RULES.md`.

## Phát sinh
- 04/11/2026 21:50 Cron `print_jobs_purge` không kiểm Cắt UID `queued` trước khi xoá lệnh `completed` > 3 ngày (không khoá ngoại; hiện 0 dòng `queued`) → để sau đợt · cân nhắc commit riêng.
- 04/11/2026 22:00 Người dùng: "Tôi cần chức năng xóa để xóa các lệnh in do tôi test chiều giờ." → **Việc 6 (xoá thủ công), làm TRƯỚC phần tự xoá khi đăng nhập** · commit riêng.

### Việc 6 — Xoá thủ công lệnh đã chọn ở màn Lệnh in (VIỆC CẦN BUILD) · Fable / Opus · [ ]
- **Số đo (Supabase MCP chỉ đọc, 04/11 22:00 VN):** hôm nay 15 lệnh, đều `completed`. Năm lệnh `xa_vai_sheet` từ 15:05 đến 17:25 trông như lệnh thử:
  - 15:05 người gửi `test-a4`, 27 dòng, không gắn dòng Xả vải nào.
  - 15:16, 15:29, 17:23, 17:25 người gửi `xa-vai` từ máy `XV-MB`, gắn 8 dòng `xa_vai_measures` (đều `printed`).
  - 10 lệnh còn lại (sku / group_uid từ 07:33 đến 13:23, nhiều máy) không giống lệnh thử; không tự quyết thay người dùng.
- **Hướng:**
  - RPC Admin `print_job_delete(p_job_ids uuid[])`: chỉ lệnh `completed` / `failed` / `cancelled`; lệnh đang chờ / đang in trả `JOB_ACTIVE`, không xoá; ≤ 100 lệnh / lần; trả số đã xoá và danh sách bị bỏ qua kèm lý do; giữ lệnh Cắt UID còn UID `queued`.
  - KHÔNG áp hạn giữ 24 giờ (lệnh thử hôm nay phải xoá được ngay). Đề xuất sàn 5 phút kể từ `completed_at` (`TOO_RECENT`) để không xoá lệnh mà tab khác đang thăm dò kết quả; người build chốt hoặc bỏ nếu thấy thừa.
  - Dòng đã chọn không còn / đã bị xoá: bỏ qua, không lỗi (`NOT_FOUND` trong danh sách bị bỏ qua).
  - Bảng nhật ký `print_jobs_purge_log` tạo trong chính migration này (cột như mục "Hợp đồng dữ liệu"; chỉ dùng `trigger = 'admin_manual'`): ai, thời điểm, số lệnh, số dòng Xả vải, theo loại; `print_events` đi theo CASCADE.
  - Web (`print-jobs-admin-script`): ô tick từng dòng + "chọn tất cả" trong danh sách Lệnh in; nút thùng rác (icon) hiện khi có chọn; `WhDialog.confirm` nêu số lệnh và số tem; xoá xong tải lại danh sách. Admin chỉ xét máy tính.
  - Hàm `SECURITY DEFINER` + `set search_path = ''` + `revoke … from public, anon, authenticated` rồi `grant … to authenticated`; migration có `-- kiem:` và `-- Rút lui`.
- **Đã chốt (người dùng 04/11 22:0x: "Xoá cả hai"):** xoá thủ công lệnh `xa_vai_sheet` xoá luôn các dòng `xa_vai_measures` gắn với lệnh đó (`print_job_id` = lệnh bị xoá, `status = 'printed'`), cùng một giao dịch, dòng Xả vải trước rồi lệnh.
  - Hộp xác nhận nêu cả hai số (ví dụ "5 lệnh · 8 dòng Xả vải") để Admin thấy trước khi bấm; chỉ chạy với lệnh `xa_vai_sheet` được chọn, không đụng lệnh loại khác.
  - Hệ quả mong muốn: Group UID thử trở lại chưa đo, đo lại được; tab "Đã in" và Excel Xả vải không còn dòng thử. Không hoàn tác được; số mét thử mất hẳn.
  - Nhật ký `print_jobs_purge_log` có cột `deleted_xa_vai integer default 0`.
  - Chỉ nhánh XOÁ THỦ CÔNG làm vậy. Cron (và Việc 1–2 nếu sau này làm) KHÔNG xoá dòng Xả vải: dòng vẫn ở "Đã in", chỉ `print_job_id` về NULL, vì đó là dữ liệu làm thật.
  - Chỉ xoá dòng Xả vải gắn với lệnh đã chọn: các lệnh thử có dòng gắn là 15:16, 15:29, 17:23, 17:25 (8 dòng); lệnh `test-a4` 15:05 không gắn dòng nào.
- **Luật dự án:** việc chạm xoá dữ liệu, quyền và migration thuộc phiên Fable / Opus (`docs/DOI_AGENT.md` mục "Chọn model và phiên"); phiên Sonnet này không tự build. Chạy xoá thật trên Supabase cần người dùng cho phép rõ từng lần.
- **Người dùng chốt thêm (04/11 ~22:15):** xoá thủ công KHÔNG áp hạn 24 giờ (xoá được ngay lệnh thử hôm nay); sàn 5 phút kể từ lúc lệnh xong là đề xuất, người build giữ hay bỏ → GIỮ (`TOO_RECENT`), vì tab khác có thể còn thăm dò kết quả lệnh vừa in.
- **Người dùng đổi hướng (04/11 ~22:25):** "tôi muốn đăng nhập admin và xóa ở đây" (tab Đã in của THEO DÕI XẢ VẢI). Chốt qua 3 câu hỏi: xoá **dòng đã chọn + lệnh in A4 không còn dòng nào**; **chỉ ở Xả vải** (bỏ ô chọn + nút xoá ở màn Lệnh in đã build lúc đầu); **chỉ Admin** thấy nút.
- **Đã build (04/11, phiên Opus, chưa commit, CHƯA chạy migration):**
  - Tệp:
    - `supabase/xa_vai_printed_delete_v1.sql`: bảng `print_jobs_purge_log` + hàm `xa_vai_printed_delete(p_group_uids text[], p_dry_run boolean default true)`.
    - `index.html`: `xa-vai-screen` (icon khiên `#xa-vai-admin`, nút `#xa-vai-delete` cạnh Xuất Excel) + `xa-vai-script` (`renderDelete`, `syncAdmin`, xử lý xoá); nhãn `xa_vai_sheet` = "Xả vải" ở màn Lệnh in.
    - Test: `tests/xa_vai_printed_delete_sql.cjs`, `tests/xa_vai_printed_delete_browser.cjs`.
  - Hợp đồng:
    - Quyền: Admin (`print_admin_allowed()`, gọi bằng JWT phiên Admin, không phải khoá máy).
    - Vào: `p_group_uids` (≤ 1000, btrim, bỏ rỗng / trùng); `p_dry_run` (mặc định / NULL = chỉ đếm, không khoá, không ghi nhật ký).
    - Ra: `{ok, data: {dryRun, requested, uids, rows, jobs, events, skipped: [{groupUid, reason, status}]}}`.
    - Lý do bỏ qua: `NOT_FOUND`, `NOT_PRINTED`, `JOB_ACTIVE` (UID còn trong lệnh A4 đang chờ / đang in), `TOO_RECENT` (in xong < 5 phút). Lỗi: `FORBIDDEN`, `BAD_REQUEST`, `TOO_MANY`.
  - Xoá:
    - Dòng `xa_vai_measures` status `printed` → Group UID về chưa đo.
    - Lệnh `xa_vai_sheet` xong / lỗi / huỷ mà mọi dòng gắn lệnh đều bị xoá → xoá lệnh (`print_events` theo CASCADE); lệnh còn dòng chưa chọn giữ.
    - Lệnh không gắn dòng nào (15:05 `test-a4`) và lệnh in lại không đụng tới: cron dọn sau 3 ngày.
    - Khoá `print_jobs` rồi `xa_vai_measures` (thứ tự trigger `xa_vai_measures_sync_job`). Nhật ký `print_jobs_purge_log` trigger `xa_vai_manual`.
  - Web: Admin chọn dòng → "Xoá · N" → máy chủ đếm → `WhDialog` danger `N dòng · M lệnh in A4 · K dòng giữ lại · Không hoàn tác` + danh sách UID → xoá đúng `uids` bước đếm trả → tìm lại, "Đã xoá N dòng · M lệnh in A4". Phiên Admin hết hạn → báo, mở hộp đăng nhập.
  - Số đo chỉ đọc (04/11 ~22:20): `xa_vai_measures` 8 dòng, đều `printed`, gắn 15:16 (1), 15:29 (1), 17:23 (3), 17:25 (3); lệnh 15:05 `test-a4` 0 dòng. Chọn đủ 8 dòng → hộp nêu "8 dòng · 4 lệnh in A4".
  - [x] Test đỏ trước: `node tests/xa_vai_printed_delete_sql.cjs` ĐỎ "thiếu tệp migration"; `node tests/xa_vai_printed_delete_browser.cjs` ĐỎ "icon khiên ở thanh tiêu đề". Sau khi build: cả hai PASS (1280 + 375 px).
  - [x] `python scripts/apply_supabase_sql.py supabase/xa_vai_printed_delete_v1.sql --dry-run`: 10 câu lệnh, không cần `--allow-destructive`.
  - [x] Test liên quan PASS: `xa_vai_a4_browser`, `cut_group_uid_browser`, `print_jobs_admin_browser`, `design_tokens_ratchet` (màu 429), `icon_standard_browser`, `ui_standard_browser`, `a11y_axe_browser`, `mobile_modules_browser`.
  - [ ] Kiểm kịch bản trên Supabase thật trong giao dịch tự huỷ (`ROLLBACK`) — cần người dùng cho phép (có DELETE). Chưa kiểm cú pháp PL/pgSQL trên Postgres thật.
  - [x] Review Codex 2 vòng (nhật ký `RULES.md` [N20261104-2316]): sửa `p_dry_run` NULL (`v_dry_run`), `JOB_ACTIVE` (UID còn trong lệnh A4 đang chờ / đang in), web (cờ trước await, gia hạn 401/403 một lần, "Chưa rõ" + tải lại khi mất phản hồi / 5xx / 2xx thân hỏng); ghi nhận không sửa: bước đếm không ràng buộc lần xoá (Admin khác xoá cùng lúc có thể làm xoá thêm một lệnh A4 vừa trống).
  - [x] Cả bộ `python scripts/run_tests.py` 146/146 PASS (447 s); `commit_gate` ĐẠT; `git diff --check` sạch. `PROJECT_MAP.md` mục Xả vải thêm một dòng.
  - [x] Phát hành theo luật 4 (05/11/2026): commit `76c19a3` → migration chạy + kiểm chỉ đọc (`-- kiem:` true; dry-run Admin 8 dòng / 4 lệnh A4, không ghi) → sổ ledger → push `7073a60..5ce360f`; trang công khai có nút khiên. Nhật ký `RULES.md` [N20261105-0805], [N20261105-0812].
  - [ ] Người dùng đăng nhập Admin thật và xoá 8 dòng thử; kiểm chỉ đọc `print_jobs_purge_log` có một dòng `xa_vai_manual`, `xa_vai_measures` còn 0 dòng thử.

## Lệch kế hoạch
- 04/11/2026 Việc 6: đổi chỗ xoá từ màn Lệnh in sang tab Đã in của Xả vải (người dùng 22:25), hàm `print_job_delete(p_job_ids uuid[])` của kế hoạch thay bằng `xa_vai_printed_delete(p_group_uids text[], p_dry_run)`; lệnh SKU / UID thử không xoá tay được (cron 3 ngày). Bản Lệnh in đã build (ô chọn, nút thùng rác, `print_job_delete_v1.sql`) đã gỡ, chưa từng commit.
- 04/11/2026 Việc 6: thêm `p_dry_run` (mặc định chỉ đếm) để hộp xác nhận nêu đúng số dòng / lệnh A4 sẽ xoá; xoá thật chỉ gửi `uids` đã đếm.
- 04/11/2026 Việc 6: bảng `print_jobs_purge_log` tạo ở migration Việc 6 (lên trước Việc 1); CHECK `trigger in ('admin_login', 'xa_vai_manual')` — bỏ 'admin_manual' của kế hoạch. Việc 1 sau này dùng `create table if not exists` cùng cột.

## Nhật ký
- 04/11/2026 21:50 Lập kế hoạch (phiên Sonnet, chỉ đọc). Đo Supabase MCP chỉ đọc: 70 lệnh `completed`, ~16,5 kB / lệnh, phụ thuộc khoá ngoại như mục "Số đo thật". Chưa chạy lệnh ghi nào.
- 04/11/2026 22:0x Người dùng chốt: xoá cả lệnh in lẫn dòng Xả vải gắn lệnh (chỉ nhánh xoá thủ công); sau đó chọn CHỜ chức năng xoá, KHÔNG xoá một lần ngay. Chưa xoá gì trên Supabase. Việc 6 chờ phiên Fable / Opus build.
- 04/11/2026 22:09 Người dùng trả lời 5 câu: 24 giờ / chỉ lệnh đã in xong / CHỈ nút xoá thủ công, không tự chạy / không CSV / giữ cron. Đổi hướng: Việc 1–2 (tự xoá khi đăng nhập) HOÃN; Việc 6 là việc cần build; xoá thủ công không áp hạn 24 giờ. Chưa xoá gì trên Supabase.
