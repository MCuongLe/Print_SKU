# BẢN ĐỒ DỰ ÁN Print_SKU (cập nhật 18/10/2026)

Đọc tệp này trước khi trinh sát. Mọi vị trí ghi theo **id khối** hoặc **chuỗi neo** (grep được), không ghi số dòng vì `index.html` đổi liên tục. Khi thêm hoặc đổi module, lead cập nhật tệp này trong cùng commit.

## 1. Kiến trúc một câu
Trang tĩnh `index.html` (GitHub Pages, `mcuongle.github.io/Print_SKU`) + Chrome Extension `extension/inside-po-connector` (đọc Inside/WMS trong tab đã đăng nhập, token không rời tab) + Supabase (PostgREST/RPC, RLS, pg_cron, 4 Edge Functions) + agent in ở kho `may-kho-01` (TSC PE200 USB, đọc `print_jobs`).

```
Người dùng ─ index.html ─ postMessage ─ app-bridge.js ─ background.js ─ inside-bridge.js / wms-bridge.js / hcm-bridge.js
                 │                                           │ (content script trong tab Inside / WMS / app xây dựng)
                 ├─ REST/RPC (publishable key, JWT Admin) ──► Supabase ◄── Edge: sku-sync · group-uid-sync · print-assistant · sku-vision
                 └─ print_enqueue (khoá máy tb-khoa) ──────► print_jobs ──► agent may-kho-01 ──► máy in
Extension nền (từ 0.10.0): chrome.alarms 30 phút → auto-sync.js → Edge (phiên Admin riêng trong chrome.storage.local)
```

## 2. index.html — khối theo id (`<style id>` / `<script id>` / `<section id>`)
Trang chủ: nhóm `section.barcode-home__group[data-tone]` (print / ops / check / admin), ô `button.barcode-choice#…`, router `renderRoute` (neo `const homeOpen = !current || current === "home";`), bản đồ thanh bên `app-nav-script` (LABEL / ROUTE / TITLE, neo `"barcode-location": "Mã vị trí",`). Khuôn panel mở từ ô: `#uidhist-screen` + `uidhist-script`. Điện thoại ≤ 620 px: nhóm Kiểm tra + Quản trị là danh sách thả (`home-fold` / `home-fold-script`, nhớ ở `localStorage["wh-home-fold"]`).

| Module (ô trang chủ) | Hash | Khối chính | Ghi chú |
|---|---|---|---|
| IN TEM SKU `#barcode-print-sku` | `#worker` | bundle React (dòng minified duy nhất chứa `window.PrintSkuWorker`), `sku-queue-ui-script`, `sku-it-script` (nút Phiếu IT + cổng `window.HasakiSkuIt`), `sku-combo-picker`, `print-sku-scan-ui`, `wms-print-button` | Chỉ sửa bundle bằng neo ngắn |
| IN TEM GROUP UID `#barcode-print-uid` | `#group-uid` | `uid-wms-script` (nút Đọc WMS `#uid-wms-open`), `uid-po-script` (tab Gán WMS), `#uid-screen` | Extension `GET_GROUP_UID_NEW_PAGE`, `GET_PACKING_LIST_PAGE` |
| MÃ VỊ TRÍ `#barcode-location` | `#location` | `#location-screen`, `location-theme` | enqueue type `location` |
| TRỢ LÝ IN `#home-assistant` (ẩn ≤ 800px) | `#assistant` | `print-assistant-style/-script`, `#assistant-screen` (id `pa-*`) | Edge `print-assistant`; dùng `window.HasakiSkuIt` |
| CẮT GROUP UID `#barcode-cut-uid` | `#cut-group-uid` | `#cut-group-uid-screen`, `cut-sample-core`, `cut-sample-script` (Theo PO, pop-up `cs-pop`), `cut-adj-reconcile` (tab Đối chiếu ADJ, STATES gồm `qc`) | RPC `cut_group_uid_*`, `cut_group_uid_reconcile` |
| LỊCH SỬ GROUP UID `#barcode-uid-history` | `#uidhist` | `uidhist-script`, `#uidhist-screen` | Mẫu panel chuẩn |
| TÌM SKU `#barcode-find-sku` | `#find-sku` | `#find-sku-screen` (neo `web-find-sku`), Edge `sku-vision` (Gemini đọc tem) | |
| CHUYỂN ĐỔI ĐƠN VỊ | `#unit-converter` | `unit-converter-app` | |
| THEO DÕI XẢ VẢI `#barcode-xa-vai` | `#xa-vai` | `#xa-vai-screen` | bảng `xa_vai_log` |
| CẤP VẢI `#barcode-cap-vai` | `#cap-vai` | `cap-vai-script`, `#cap-vai-screen` | migration `fabric_issue_*` |
| KIỂM TRA ĐẦU VÀO `#barcode-inspection` | `#inspection` | `#ins-screen` | |
| RỦI RO LƯU TRỮ `#barcode-storage-risk` | `#storage-risk` | `storage-risk-script` (Hàng chưa lên kệ), `storage-risk-temp-script` (UID tạm, `window.HasakiStorageRiskTemp`) | Hai nút `sr-run` / `srt-run`, một luồng đọc (sr-run = Kiểm kê + UID tạm); UID tạm lưu Supabase `uid_temp_snapshot_v1` (`uid_temp_save` Admin, `uid_temp_overview` anon) |
| KIỂM KÊ SKU `#barcode-inventory-audit` | `#inventory-audit` | `inventory-audit-script`, `#inventory-audit-screen` | migration `sku_count_v1` |
| KIỂM SOÁT CÔNG TRÌNH `#barcode-site-control` | `#site-control` | `site-control-script` | app xây dựng qua `hcm-bridge.js`, không lưu Supabase |
| QUẢN TRỊ `#barcode-admin` | `#admin/...` | `admin-sync-shared` (UI.createList, chip, dialog), `sku-sync-admin-script` (`#sku-sync-screen`), `group-uid-sync-admin-script` (`#group-uid-sync-screen`), `print-jobs-admin-script` (`#print-jobs-screen`, tab Thiết bị `print-devices-tab-script`), `admin-command-header-b-script` | Chỉ xét desktop |

Dùng chung: `PrintSkuQueue` (đầu tệp: `enqueue`, `jobStatus`, `queueStatus`, `deviceKey` = `localStorage["tb-khoa"]`, `publishableKey`), `PrintSkuBridgeReady` + `extensionRequest` (8 helper, test `bridge_ready` đếm), `PrintSkuAdminAccess` (peekToken/getToken/logout) và `PrintSkuAdminAuth` (accessToken, gia hạn khi 401/403, phiên ở `sessionStorage["print-sku-admin-session-v1"]`), `print-device-script` (ô KÍCH HOẠT MÁY), chuẩn giao diện `type-standard` / `icon-standard` / `ui-standard` / `app-nav-theme`; nút đọc trong dải mốc giờ `strip-read` (Kiểm kê, Công trình, Lịch sử UID: nhóm nút Admin trong `.as-strip__lead`; Rủi ro lưu trữ: `.sr-tabrow`); khung quét chuẩn `scan-field-std` (CSS) + `scan-field-std-script` (`window.PrintSkuScanField.keyboard`, nút có `data-kb-key` + `aria-controls`) cho mọi ô quét trừ TÌM SKU — ba màn Cắt / Xả vải / Cấp vải vẫn dùng khối `scan-field` cũ. Khuôn hero `.ss-hero` (8 màn: thanh lệnh gọn, h2 sr-only, không Admin thì ẩn) + nút đọc nguồn `.src-read` (12 nút "Đọc WMS"/"Đọc Inside"/"Toàn bộ", `data-busy` = vòng xoay + "Đang đọc…", nhãn trong `.src-read__t`) nằm trong `<style id="hero-standard">` cuối tệp; test `src_read_style_browser`. Từ 18/10: nút đang chạy có vạch load `::after` dưới nút (biến `--p` 0–1 khi biết trang x/y), các thanh tiến độ rời (`#sku-sync-progress`, `#gu-progress`, `#ia-progress`, `#sc-progress`, `#uh-progress`) chỉ còn ẩn; hai màn đồng bộ có ô Tự động `#ss-strip-auto` / `#gu-strip-auto` trong dải mốc giờ (nút icon `#*-auto-toggle`).

## 3. Extension `extension/inside-po-connector` (manifest 0.10.1)
- `app-bridge.js`: content script trên trang Print SKU; allow-list lệnh; `window.postMessage` ↔ `chrome.runtime.sendMessage`.
- `background.js`: service worker; kiểm `APP_URL_PATTERN`; `WMS_READ_TYPES`; tìm tab Inside/WMS; nhánh `AUTO_*` cho trang Options; alarms `auto-sync` / `auto-keepalive`; `chrome.storage.local.setAccessLevel(TRUSTED_CONTEXTS)`.
- `inside-bridge.js`: `GET_PO` (danh sách + trang chi tiết PO; trả `lastModified` = cột LastModified, `deliveryDate`, `items[{sku, orderedQty}]`), `GET_SKU_SYNC_DATA` ({full}|{cutoff}), đọc 7 nhóm hàng `SKU_CATEGORIES`, Combo theo Modified; `sku-sync-core.js` (cutoffKey, comboStampsOrdered).
- `wms-bridge.js`: `GET_GROUP_UID_PAGE` (group-uid-infos, size ≤ 500, from/to epoch ms), `GET_INTERNAL_TRANSFER` (phiếu IT), đọc Import/Export, history (QC không có lệnh riêng: `qc_status` đi theo `GET_GROUP_UID_PAGE`); token từ `localStorage["auth_store"]`; `group-uid-sync-core.js` (`normalizeRow` có `qc_status`), `inventory-audit-core.js`.
- `hcm-bridge.js`: app xây dựng (Cloudflare Access + Bearer) cho Kiểm soát công trình.
- Nền tự động: `auto-sync.js` (`decide`, `tick`, `runNow`, lease/cooldown, held), `group-uid-snapshot-core.js` (đọc WMS chống lệch, chép từ `readWmsSnapshot` của web), `supabase-session.js` (đăng nhập/gia hạn phiên Admin), `supabase-config.js`, `options.html/js` (Phiên Admin, Tên máy, Trạng thái, Lượt gần nhất, Nhật ký).
- Nâng phiên bản: đổi `manifest.json` + `tests/inside_po_connector.cjs` + `tests/sku_sync_extension.cjs` + README Extension; sau Reload phải tải lại tab Inside/WMS.

## 4. Supabase
Edge (`supabase/functions/*/index.ts`, deploy một tệp bằng `scripts/deploy_<tên>.py`, `verify_jwt` false, tự kiểm JWT Admin qua `/auth/v1/user` + `user_roles`):
- `sku-sync`: preview (full|incremental, source/device) · apply (auto → ngưỡng/held, lưu trữ SKU rời nhóm sau completed) · history (lastSnapshotAt, lastAutoFullAt) · detail · lease · release · auto-config.
- `group-uid-sync`: prepare · ingest · preview · apply · history · detail · cancel · lease · release · auto-config; RPC `group_uid_sync_prepare/preview/apply`.
- `print-assistant`: tách ý định in tem phiếu IT (Anthropic nếu có khoá, không thì Gemini; `output_config.format` / `responseSchema`), log `print_assistant_log`.
- `sku-vision`: Gemini đọc ảnh tem cho Tìm SKU.

Bảng chính: `SKU_Name`, `sku_combo_links`, `sku_archive`, `sku_sync_runs`; `group_uid_details`, `group_uid_products`, `group_uid_sync_runs/staging/pages/changes/state`; `cut_group_uids`, `cut_sample_*`; `print_jobs`, `print_events`, `print_devices`, `print_activation_codes`; `sync_auto_settings`, `sync_auto_leases`; `print_assistant_log`; `user_roles`.

Migration là chuỗi tệp `supabase/*.sql` (idempotent, `notify pgrst`); **bản mới nhất của một hàm nằm ở tệp mới nhất đụng nó**:
- SKU sync: `sku_sync_admin_v1` → `sku_sync_full_v1` → `sync_auto_v1` → `sku_missing_archive_v1` (RPC `sku_archive_missing`, `sync_history_purge` mới nhất).
- Group UID sync: `group_uid_sync_v1` (prepare gốc) → … → `group_uid_sync_v7_apply_guard` → `group_uid_qc_status_v1` (preview v6, apply v8, reconcile) → `sync_auto_v1` (prepare 5 tham số, lease).
- In: `print_queue_v1` → `print_jobs_admin_v1` → `print_devices_v1` (print_enqueue kiểm khoá) → `sku_inactive_v1` (print_enqueue_unchecked, sku_inactive_archive).
- UID tạm (Rủi ro lưu trữ): `uid_temp_snapshot_v1` — bảng `uid_temp_runs` / `uid_temp_rows` (chỉ service_role), `uid_temp_save(p_run, p_rows)` kiểm `group_uid_admin_allowed()`, `uid_temp_overview()` cho anon; giữ 10 lượt.
- Cache trên máy + kiểm phiên bản: `snapshot_cache_v1` — chỉ thêm hàm đọc cho anon: `sku_count_snapshot(p_known_run_id)` / `uid_temp_snapshot(p_known_run_id)` (trùng lượt → `{unchanged:true}`, khác → nguyên `*_overview()` + `unchanged:false`), `sku_catalog_changes(p_since)` (`version {activeCount,maxUpdatedAt}`, `upserts`, `removed` gồm cả `sku_archive`, quá 2.000 → `tooMany`). Web: khối `snapshot-cache-script` (`window.PrintSkuSnapshotCache`, IndexedDB `print-sku-cache`, khoá `sku_count` dùng chung Kiểm kê + Hàng chưa lên kệ, `uid_temp`); TÌM SKU ghép phần đổi vào `print-sku-find-sku` và đọc lại tên `SKU_Name` lúc bấm in (`verifyNames`, in theo tên database). Kế hoạch: `docs/plans/2026-10-18-cache-phien-ban.md`.
- Tên SKU khi in: `print_name_from_db_v1` — `print_enqueue_unchecked` (bản mới nhất) với `sku` + `group_uid`: SKU có trong `SKU_Name` (status '1', tên khác rỗng) → `productName` = tên database, không có → giữ tên web; vẫn chặn SKU ngừng (`sku`); trả `data.renamed` (lệnh trùng → `[]`). Web: cổng `PrintSkuQueue.enqueue` (`namesWatch`) → `PrintSkuCatalog.patchNames` + sự kiện `print-sku-names-updated` + thông báo `#sku-name-note`. Danh mục trên máy dùng chung: khối `sku-catalog-script` (`window.PrintSkuCatalog`: `ensure/check/get/search/patchNames/onChange`, IndexedDB `print-sku-find-sku`/`catalog`, tự nạp khi vào `#worker`, `#unit-converter`, `#group-uid`, `#find-sku`); In tem SKU móc `uv`/`sv` trong bundle, ô quét, Chuyển đổi đơn vị, Gán tự động tra trên máy trước. Kế hoạch: `docs/plans/2026-10-18-danh-muc-sku-tren-may.md`.
- Khoá máy nhóm ghi xưởng: `floor_access_v1` — 11 hàm ghi (6 `cut_group_uid_*` ghi, `cut_sample_scan/confirm`, `fabric_issue_scan`, `xa_vai_start/end`) bọc thân cũ `_<tên>_body` và gọi `floor_access_check(p_access_token, fn)`: chỉ nhận máy đã kích hoạt (`print_device_by_token`), mode `floor_access_settings` ('enforce' mặc định từ 17/10; 'log' = vẫn chạy + `accessWarning`), máy lạ ghi `floor_access_denials` một dòng/phút; bản mới 5 hàm sample/fabric/xa_vai có `p_access_token` đầu (không default), bản cũ còn để trang cũ nhận ACCESS_DENIED (drop ở v2). RPC Admin `floor_access_summary`/`floor_access_set_mode`. Web: `window.PrintSkuFloorAccess {token, check}` trong `print-device-script`, thẻ `#pdm-floor` ở tab Thiết bị.
- Cron: `print-jobs-purge` 20:00, `sync-history-purge` 20:30, `print-assistant-purge` 20:50, `floor-access-purge` 20:55, `sku-inactive-archive` CN 20:45, `group-uid-canceled-purge` CN 20:15 (UTC).

Chạy migration: `python scripts/apply_supabase_sql.py <tệp> [--dry-run] [--allow-destructive]` (token Management trong `.env`, gitignored). Thứ tự lên luôn là migration → deploy Edge → Reload Extension.

## 5. Kiểm thử và công cụ
- `python scripts/run_tests.py [--no-server] [--only <tên>] [--no-retry]` chạy mọi `tests/*.cjs|*.mjs` (≈ 70 tệp, ~8–10 phút); test hỏng được chạy lại một lần tuần tự, in mục CHẬP CHỜN.
- Hook Claude Code (`.claude/settings.json` → `scripts/claude_hooks.py`, 18/10/2026): mọi lệnh Bash có `git commit` tự chạy `commit_gate.py` (`--cached`, hoặc cả cây khi cùng lệnh có `git add`) và chặn khi KHÔNG ĐẠT; chặn Write ghi đè cả `index.html` và mọi sửa `.env`. Kỹ năng `/commit-push` (chỉ người dùng gọi): chọn tệp của đợt, test, cổng, commit, push, ghi RULES.md.
- `python scripts/commit_gate.py [--cached | --commit <sha>]`: cổng trước commit bằng máy (bí mật, dữ liệu thật, mojibake, CRLF cả tệp, phiên bản Extension, CDN/npm, cảnh báo bản đồ). Máy chủ tĩnh cổng 8000 cho cây chính (`.claude/launch.json` → `print-sku-test-8000`); worktree của agent dùng cổng khác + `BASE=`.
- Playwright: `PLAYWRIGHT_MODULE=C:/Users/HASAKI/playwright-tools/node_modules/playwright`. Bộ chuẩn: `typography_browser`, `ui_standard_browser`, `icon_standard_browser`, `a11y_axe_browser`, `app_nav_browser`, `mobile_home_browser` (trang chủ điện thoại ≤ 1,25 màn).
- Edge test Node: `tests/sku_sync_function.mjs`, `group_uid_sync_function.mjs`, `print_assistant_function.mjs`, `sku_vision_function.mjs` (giả `Deno` + `fetch`).
- Review độc lập: `python scripts/codex_review.py --working-tree|--commit <sha>|--images <thư mục> --brief <md>` (skill `review-codex`).
- Kế hoạch cho việc có migration nhiều bước hoặc kéo dài hơn một phiên: `docs/plans/<ngày>-<tên>.md` (mẫu `docs/plans/README.md`).
- Đội agent: `docs/DOI_AGENT.md` (bản 3, 18/10/2026: lead tự làm, bốn luật, Codex một vòng kể cả giao diện, mẫu bản giao việc 7 dòng; 18/10 thêm `/review-claude` song song Codex, bỏ `thuc-thi-khuon`, `kiem-thu` lên Sonnet + chẩn đoán test hỏng), hồ sơ `.claude/agents/{trinh-sat,thuc-thi-logic,kiem-thu,co-van}.md` (`co-van` = Fable cố vấn quyết định khó).

## 6. Quy ước luôn đúng
Trả lời tiếng Việt có dấu; icon Lucide + nhãn ngắn, không câu hướng dẫn kiểu AI; Admin chỉ xét desktop; `index.html` git lưu LF nhưng trên đĩa có thể là CRLF (autocrlf=true, sau checkout/apply) — giữ nguyên kiểu xuống dòng đang có của từng tệp khi sửa, sửa nhỏ nhất bằng neo; dữ liệu test giả (`9000000xx`, `1028260000000xxx`, `100000001`); không commit `.env`, khoá, SKU thật; commit/push chỉ khi người dùng nói; xong việc phải nhắc commit. Quyết định đã chốt nằm trong `RULES.md` (không vào git) — grep trước khi đề xuất lại.
