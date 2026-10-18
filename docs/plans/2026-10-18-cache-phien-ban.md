# Cache trên máy + kiểm phiên bản (2026-10-18)

## Thiết kế
- **Yêu cầu:** "Hướng lưu cache ở máy trước rồi đối chiếu phiên bản với supabase…", "kiểm tra xem hướng này có thể áp dụng cho modul nào nữa không để sửa 1 lần", và lo ngại lỗi 23/09/2026 (tem in số SKU này tên SKU khác do bộ nhớ trên máy).
- **Số đo thật (18/10/2026, REST bằng khoá publishable):** `sku_count_overview` 2.748 dòng, 150 KB nén, 1,0–1,9 s mỗi lần mở; `uid_temp_overview` rỗng, 0,5 s; danh mục `SKU_Name` 22.105 SKU = 23 trang × ~17 KB nén ≈ 390 KB, mỗi trang ~1,4 s (Tìm SKU tải 4 trang song song). Các màn khác (Cắt UID 15 KB, xả vải, cấp vải, lấy mẫu, hàng chờ in) đổi theo từng lần quét/in → phải luôn lấy số mới, KHÔNG cache.
- **Phát hiện khi rà (rủi ro đang có):** Tìm SKU đưa tên lên tem lấy thẳng từ danh mục cache IndexedDB `print-sku-find-sku` (hạn 12 giờ, `CATALOG_TTL`); máy chủ (`print_enqueue_unchecked`) chỉ chặn SKU ngừng, không kiểm tên → SKU đổi tên trên Inside trong 12 giờ đó sẽ in tên cũ.
- **Kết quả nhìn thấy được:**
  1. Kiểm kê, Hàng chưa lên kệ (cùng một bản lưu), UID tạm: mở màn hiện ngay bản trên máy, đồng thời hỏi Supabase một lần gọi có kèm mã lần đọc đang có; không đổi → máy chủ trả "không đổi" (vài chục byte); có lần đọc mới → trả đầy đủ như nay. Mỗi lần mở màn vẫn đúng 1 lần gọi.
  2. Tìm SKU: bỏ hạn 12 giờ; mở màn hỏi phiên bản danh mục (số SKU đang hoạt động + lần cập nhật mới nhất), chỉ tải SKU đổi từ lần trước; số SKU lệch (có SKU bị lưu trữ/xoá) thì tải lại toàn bộ như nay. Bản mới có ngay sau đồng bộ SKU.
  3. Chốt chặn tên trước khi in ở Tìm SKU: ngay trước khi gửi lệnh, tra lại tên đúng các SKU sắp in trên Supabase (gộp 1 lần gọi). **Người dùng chốt: tên trên Supabase luôn đúng → in theo tên database** (tên khác cache thì cập nhật vào danh sách và in luôn bằng tên database, báo dòng "Đã dùng tên mới từ danh mục cho …"). SKU không còn trên database (ngừng / lưu trữ) hoặc lỗi mạng → không in, dừng và báo.
  4. Mất mạng: vẫn xem bản trên máy, dòng trạng thái ghi rõ "Bản lưu trên máy lúc …"; không in (in vốn cần mạng).
- **Nguyên tắc xung đột cache ↔ database:** Supabase luôn đúng; cache chỉ để hiện nhanh, KHÔNG bao giờ ghi ngược lên Supabase; lệch phiên bản → thay cache (phần đổi hoặc toàn bộ); cache hỏng / khác `schemaVersion` → bỏ, tải lại; tên trên tem luôn là tên vừa xác nhận từ database (tinh thần luật 23/09).
- **Đã chốt với người dùng (AskUserQuestion 18/10/2026):** (1) phạm vi 3 nơi + chốt chặn tên; (2) tên lệch lúc in → **in theo tên trên database** (không dừng hỏi lại — khác khuyến nghị); (3) In tem SKU / Group UID / Chuyển đổi đơn vị tra tên từ cache → để đợt sau.
- **Quyết định lead (theo luật có sẵn):** giữ nguyên `sku_count_overview()` / `uid_temp_overview()` cho trang cũ còn trong bộ nhớ trình duyệt (không drop, không đổi chữ ký — thêm tham số mặc định sẽ sinh hai hàm cùng gọi được bằng `{}` → PostgREST báo mơ hồ); hàm mới tên riêng. Web mới gặp lỗi "không có hàm" (chạy trước migration) thì lùi về hàm cũ.
- **Hợp đồng dữ liệu (migration `supabase/snapshot_cache_v1.sql`, chỉ thêm):**
  - `sku_count_snapshot(p_known_run_id uuid)` → `{ok, data:{unchanged:true, runId}}` hoặc `{ok, data:{unchanged:false, run, rows}}` (đúng khuôn `sku_count_overview`); anon.
  - `uid_temp_snapshot(p_known_run_id uuid)` → cùng khuôn với `uid_temp_overview` (+ `unchanged`); anon.
  - `sku_catalog_changes(p_since timestamptz)` → `{ok, data:{version:{activeCount, maxUpdatedAt}, upserts:[{sku, product_name, status}] (SKU đang hoạt động có updated_at > p_since, tối đa 2.000), removed:[sku] (SKU ngừng có inactive_since > p_since), tooMany:boolean}}`; `p_since` null hoặc quá 2.000 dòng đổi → `tooMany:true`, web tải toàn bộ như nay. SECURITY DEFINER + `search_path=''` (cần thấy dòng ngừng mà policy anon ẩn), chỉ trả mã SKU cho dòng ngừng; anon.
  - SKU bị lưu trữ (xoá khỏi `SKU_Name`, `sku_missing_archive_v1`) không lộ ra qua delta → web so `activeCount` với số dòng sau khi áp delta, lệch thì tải lại toàn bộ.
- **Rủi ro và cách chặn:** (a) đua giữa cache và lần đọc WMS (đã gặp ở UID tạm) → dùng lại mẫu `loadGen`; (b) tên in sai → chốt chặn 3; (c) IndexedDB bị chặn (chế độ riêng tư) → chạy như không có cache; (d) đồng hồ máy lệch → phiên bản lấy từ máy chủ (`maxUpdatedAt`, `runId`), không dùng giờ máy.
- **Chưa kiểm được bằng máy:** điện thoại thật ở kho sóng yếu; đồng bộ SKU thật rồi mở Tìm SKU thấy SKU mới ngay; Admin đọc WMS thật ở Kiểm kê / UID tạm.

## Kế hoạch
Đội: **lead (Opus 5.5 / Fable)** làm web trên cây chính; **`thuc-thi-logic` (Opus)** làm migration SONG SONG trong worktree (khác tệp, đúng trường hợp bản 3 cho phép giao agent). Không giao Sonnet: phần web đều nằm trong `index.html` — một người sửa tại một thời điểm.

Thứ tự: Việc 1 ∥ Việc 2 → Việc 3 → Việc 4 → Việc 5.

### Việc 1 — Migration `snapshot_cache_v1` · thuc-thi-logic (Opus, worktree, cổng 8001) · [x] (giữ sku_archive trong removed; rủi ro ghi nhiều mẻ → tải toàn bộ 12 giờ + chốt chặn tên)
- Bản giao việc 7 dòng (DOI_AGENT): tệp mới `supabase/snapshot_cache_v1.sql` + `tests/snapshot_cache_sql.cjs`; mẫu cần chép khuôn: `supabase/sku_count_v1.sql` (`sku_count_overview`), `supabase/uid_temp_snapshot_v1.sql` (`uid_temp_overview`, khuôn bắt lỗi kiểu), `supabase/sku_inactive_v1.sql` (policy `sku_name_read_active`, cột `inactive_since`).
- Test đỏ trước: `tests/snapshot_cache_sql.cjs` khẳng định ba hàm SECURITY DEFINER + `search_path=''`, `stable`, chỉ đọc, cấp anon; không drop/không đổi chữ ký hàm cũ; `sku_catalog_changes` giới hạn 2.000, chỉ trả mã SKU cho dòng ngừng.
- Lệnh: `node tests/snapshot_cache_sql.cjs`; `python scripts/apply_supabase_sql.py supabase/snapshot_cache_v1.sql --dry-run`. KHÔNG chạy migration thật.
- Lead kiểm thêm bằng SELECT chỉ đọc trên Supabase (biểu thức, hiệu năng `max(updated_at)` trên 22 nghìn dòng).

### Việc 2 — Bộ cache chung + 3 màn bản lưu · lead (cây chính) · [x] (cache chỉ vẽ lần đầu khi màn chưa có dữ liệu)
- Khối mới `<script id="snapshot-cache-script">` (đặt trước `<script id="inventory-audit-script">`): `window.PrintSkuSnapshotCache.{get,put,drop}` trên IndexedDB `print-sku-cache` (store `kv`), khoá kèm `schemaVersion`; lỗi IndexedDB → trả null, không ném.
- Neo: `const data=await anonRpc("sku_count_overview"),run=data?.run||null;` (Kiểm kê, `inventory-audit-script`); `try{apply(await anonRpc("sku_count_overview"))}` (Hàng chưa lên kệ, `storage-risk-script`); `rpcCall("uid_temp_overview")` (`storage-risk-temp-script`). Mỗi màn: hiện cache ngay (nhãn "Bản lưu trên máy lúc …" đến khi máy chủ xác nhận) → gọi `*_snapshot(p_known_run_id)` → `unchanged` giữ, khác thì áp + lưu cache; lỗi mạng giữ cache + nhãn; lỗi PGRST202 → gọi hàm cũ.
- Test (viết cùng mã, logic có test đỏ trước): mới `tests/snapshot_cache_browser.cjs` (lần 2 mở màn không tải lại rows; phiên bản đổi → tải; mất mạng → nhãn + dữ liệu cache; IndexedDB hỏng → vẫn chạy; hàm mới chưa có → lùi hàm cũ); sửa mock trong `inventory_audit_browser`, `storage_risk_browser`, `storage_risk_temp_browser`.

### Việc 3 — Tìm SKU: danh mục theo phiên bản + chốt chặn tên trước khi in · lead · [x]
- Neo: `const CATALOG_TTL = 12 * 3600 * 1000;`, `const loadCatalog = async force => {`, `indexedDB.open("print-sku-find-sku", 1)` (giữ kho cũ, thêm `version` vào bản ghi `catalog`), `const printSelected = async () => {`, `const payload = { items: items.map(item => ({ sku: item.sku, productName: item.pn` (khối TÌM SKU, script bắt đầu bằng chú thích `// TÌM SKU (30/09/2026), ba bước như CẮT GROUP UID / XẢ VẢI:`).
- Danh mục: mở màn → `sku_catalog_changes(p_since = maxUpdatedAt trong cache)` → áp upserts/removed → so `activeCount` → lệch hoặc `tooMany` thì tải toàn bộ (giữ hàm `fetchCatalog` hiện có) → dựng lại chỉ mục chỉ khi có đổi.
- Chốt chặn: trong `printSelected` trước `PrintSkuQueue.enqueue`, gọi `SKU_Name?select=sku,product_name&sku=in.(…)` (mẫu đã có trong tệp); payload luôn dùng tên database; tên khác cache → cập nhật `item.pn` + cache, in tiếp, báo "Đã dùng tên mới từ danh mục cho …"; SKU không còn trên database → không in cả lượt, đánh dấu dòng, báo; lỗi mạng → không in.
- Test đỏ trước: test mới `tests/find_sku_print_guard_browser.cjs`: cache có tên cũ, Supabase tên mới → `print_enqueue` nhận tên mới, danh sách hiện tên mới, có dòng báo; SKU không còn → không gọi `print_enqueue`; lỗi mạng khi tra → không in; tên trùng → in ngay. `find_sku_core`, `find_sku_engine`, `find_sku_combo_normal_browser` vẫn PASS.

### Việc 4 — Review · lead + Codex · [x] vòng 1: 6 nhóm, sửa 2–6, hoãn 1; vòng 2: 5 nhóm, sửa cả 5; vòng 3: 3 nhóm → đổi cách khoá cache (nối tiếp theo khoá, người dùng chọn), tai-hien 8/8 xanh + đột biến đỏ đúng mục (tests/snapshot_cache_edge_browser.cjs)
- Codex mã một vòng (`--working-tree --add …` cả tệp mới, `--round 1`), vòng 2–3 chỉ diff vừa sửa (luật 18/10); Codex ảnh một vòng: nhãn "Bản lưu trên máy" + thông báo chốt chặn (390 + 1280).
- Gom lỗi theo loại, sửa cả nhóm; ghi kết quả lọc vào `RULES.md`.

### Việc 5 — Xác minh + lên · lead · [ ]
- `python scripts/run_tests.py --no-server` (nền, không chạy cùng Codex), `python scripts/commit_gate.py`; README (Kiểm kê, Rủi ro lưu trữ, Tìm SKU), `docs/PROJECT_MAP.md` (khối `snapshot-cache-script`, migration mới), `RULES.md`.
- Commit, CHƯA push → người dùng chạy `python scripts/apply_supabase_sql.py supabase/snapshot_cache_v1.sql` → lead kiểm hàm/quyền bằng SELECT + gọi REST anon → push.

Ước lượng: Việc 1 ∥ 2 khoảng 40–60 phút, Việc 3 khoảng 40 phút, Codex + cả bộ test khoảng 30–40 phút.

## Lệch kế hoạch (người dùng duyệt 18/10/2026: "làm theo khuyến nghị")
- Giữ tải toàn bộ danh mục mỗi 12 giờ (kế hoạch ghi bỏ) — chặn rủi ro sku-sync ghi nhiều mẻ.
- Nhãn "Bản lưu trên máy lúc …" chỉ khi mất mạng (kế hoạch ghi cả lúc chờ máy chủ) — tránh nhấp nháy mỗi lần mở.
- Khoá cache theo khoá chạy nối tiếp (thay đếm thế hệ) sau Codex vòng 3.
- Bổ sung sau khi rà lại kế hoạch: dòng SKU không còn bị bỏ chọn + khoá + nhãn "SKU không còn"; tên database ghi vào danh mục trên máy; dòng đổi tên có nhãn "Tên đã cập nhật"; nhãn mất mạng thành dải cảnh báo cam (Codex ảnh 1 vòng: 5 góp ý, sửa 1–4, góp ý 5 = tab lọc 390 px bị cắt là lỗi có từ trước, để đợt sau).
- Đo `sku_catalog_changes` (EXPLAIN ANALYZE, chỉ đọc): phiên bản 13 ms (nguội 822 ms); phần đổi 7 ngày 178 ms → 558 upserts + 2.679 removed (đợt lưu trữ 17/10) > 2.000 → tooMany.

## Đợt sau (đã chốt hướng, chưa làm)

- **Luật tên khi in (người dùng 18/10/2026, áp cho đợt sau):** SKU **có** trong database → **luôn** in theo tên database; SKU **không có** trong danh mục → in theo tên web gửi lên (không chặn). Đợt này Tìm SKU vẫn chặn SKU không còn — đợt sau đổi theo luật này.
- Codex vòng 1 nhóm (1): kiểm tên ở máy chủ trong `print_enqueue_unchecked` (p_type='sku': dựng lại `productName` từ `SKU_Name` trong cùng giao dịch) — đóng cửa sổ giữa kiểm tên và gửi lệnh, áp một lần cho mọi màn in SKU (In tem SKU, Trợ lý in, Phiếu IT, Tìm SKU). Làm cùng đợt In tem SKU dùng danh mục trên máy.
- In tem SKU / Group UID / Chuyển đổi đơn vị tra tên từ danh mục trên máy (đo 18/10: hỏi máy chủ 0,6–1,4 giây mỗi mã).

## Nhật ký
- 18/10/2026 tối: rà module, đo số thật, phát hiện rủi ro tên cache ở Tìm SKU; lập kế hoạch, chờ người dùng chốt 3 mục ở phần Thiết kế.
- 18/10/2026: người dùng chốt 3 mục (điểm 2 khác khuyến nghị: in theo tên database). Bắt đầu Việc 1 (Opus, worktree) ∥ Việc 2 (lead).
