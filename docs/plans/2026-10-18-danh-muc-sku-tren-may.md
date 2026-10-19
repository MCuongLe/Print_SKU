# Danh mục SKU trên máy + luật tên in từ database (2026-10-18)

## Thiết kế
- **Yêu cầu:** "làm mục cache SKU để cải thiện tốc độ" (mục "Đợt sau" của `docs/plans/2026-10-18-cache-phien-ban.md`).
- **Đã chốt với người dùng (AskUserQuestion 18/10/2026):**
  1. 4 màn tra tên từ danh mục trên máy: In tem SKU (gõ mã + gợi ý khi gõ), ô quét In tem SKU, Chuyển đổi đơn vị, Gán WMS theo PO. Mã không có trên máy → hỏi máy chủ như cũ. Lấy mẫu, Phiếu IT giữ nguyên (đã gộp 1 lời gọi).
  2. Luật tên ở máy chủ (`print_enqueue_unchecked`): SKU có trong database (đang hoạt động) → luôn thay `productName` bằng tên database; không có → giữ tên web gửi; SKU ngừng → chặn như cũ. Áp mọi đường in (In tem SKU, Tìm SKU, Trợ lý in, Phiếu IT, In lại Admin). Máy chủ trả danh sách tên đã thay → màn báo "Tên đã cập nhật". **Tìm SKU vẫn chặn SKU không có trong danh mục** (chỉ in khi SKU có trong database).
  3. Áp cả tem **Group UID**.
  4. Nạp nền khi mở một trong 4 màn, không chặn gõ; chưa nạp xong → hỏi máy chủ; máy đã có bản từ Tìm SKU → dùng ngay; kiểm phiên bản + chỉ nạp phần đổi (`sku_catalog_changes`), tránh nạp nhiều lần.
- **Số đo thật (18/10/2026):** tra một mã 0,6–1,4 s; gợi ý khi gõ 0,5–1,6 s (tối đa 2 lời gọi); danh mục 22.105 SKU ≈ 390 KB nén; `sku_catalog_changes` 13 ms (phiên bản), 178 ms (phần đổi 7 ngày).
- **Khảo sát mã:** In tem SKU (bundle React, dòng `Ho="SKU_Name"`): `uv(r)` tra đúng 1 mã (`sku=eq.`, cache RAM `tl`), `sv(r)` gợi ý (`like e*` 8 dòng, rồi `product_name ilike *e*`), `yl=r=>({sku,ten})`. Ô quét `print-sku-scan-ui` (`sku=eq.`), `unit-converter-app` (`sku=eq.`), `uid-po-script` (`sku=eq.`). Mọi lệnh in (kể cả bundle React qua lệnh `pr_them`) đi qua `enqueue` trong khối `PrintSkuQueue` → một cổng chung. `print_enqueue_unchecked` bản đang chạy = `supabase/sku_inactive_v1.sql` (kiểm `pg_get_functiondef`); người gọi: `print_enqueue`, `print_admin_reprint`. Payload SKU: `{items:[{sku, productName, …}]}` hoặc `{sku, productName, …}`; agent đọc `productName` (Group UID: `productName ?? materialName`).
- **Kết quả nhìn thấy được:** gõ / quét mã ở 4 màn hiện tên ngay (< 1 ms khi đã có danh mục); gợi ý khi gõ tức thì; tem in luôn mang tên database; khi máy chủ thay tên, màn hiện "Tên đã cập nhật: <SKU>".
- **Rủi ro và cách chặn:** (a) danh mục trên máy cũ → tên hiển thị cũ, nhưng tên in luôn đúng (máy chủ thay); (b) SKU mới chưa có trên máy → hỏi máy chủ; (c) sửa bundle React đã nén → neo chuỗi nguyên văn, chỉ chèn đầu `uv`/`sv`, test cũ của In tem SKU phải xanh; (d) đổi tên ở máy chủ làm lệnh trùng nonce → nhánh `duplicate` trả `renamed: []`; (e) Group UID lấy tên từ database có thể khác tên WMS theo lô — người dùng đã chốt áp.
- **Chưa kiểm được bằng máy:** in thật trên máy in (tem mang tên database), điện thoại thật ở kho.

## Kế hoạch
Đội: lead (Opus) làm web trên cây chính; `thuc-thi-logic` (Opus) làm migration song song trong worktree (khác tệp). Thứ tự: Việc 1 ∥ (Việc 2 → 3 → 4) → Việc 5 → Việc 6.

### Việc 1 — Migration `print_name_from_db_v1` · thuc-thi-logic · [x]
- Tệp: `supabase/print_name_from_db_v1.sql` (mới), `tests/print_name_from_db_sql.cjs` (mới). Khuôn: thân `print_enqueue_unchecked` trong `supabase/sku_inactive_v1.sql` (= bản đang chạy).
- [x] `p_type in ('sku','group_uid')`: thay `productName` từng dòng (`items[]` hoặc dạng đơn) bằng `SKU_Name.product_name` khi SKU có và `status='1'`, tên database rỗng thì giữ tên web; giữ nguyên chặn SKU ngừng cho `sku`
- [x] Trả `data.renamed = [{sku, productName}]` (chỉ dòng thật sự đổi); lệnh trùng nonce → `renamed: []`
- [x] Không đổi chữ ký, quyền (`revoke … from public, anon, authenticated`), không drop
- [x] Test đỏ trước `tests/print_name_from_db_sql.cjs` (tĩnh, như `tests/snapshot_cache_sql.cjs`) + `--dry-run` của `scripts/apply_supabase_sql.py`

### Việc 2 — Khối dùng chung `window.PrintSkuCatalog` · lead · [x]
- [x] Khối mới `<script id="sku-catalog-script">` (đặt sau khối `PrintSkuQueue`): IndexedDB `print-sku-find-sku` khoá `catalog` (dùng chung bản Tìm SKU), `ensure()` (nạp nền, một lần), `check()` (hỏi phiên bản mỗi lần vào màn, đọc lại IndexedDB trước để nhận bản tab khác vừa cập nhật — bỏ ngưỡng 60 s, xem Lệch kế hoạch), `get(sku)` (đồng bộ: bản ghi | null | undefined = chưa nạp), `search(q, limit)` (giống máy chủ: mã bắt đầu bằng q, rồi tên chứa q khi q ≥ 3 ký tự), `patchNames(list)`, `onChange(cb)`
- [x] Tìm SKU dùng khối này để nạp / đồng bộ (bỏ mã trùng lặp `fetchCatalog`/`syncCatalogOnce`), giữ chỉ mục `NDS_ENGINE` riêng
- [x] Test đỏ trước `tests/sku_catalog_browser.cjs`: nạp một lần, `get`/`search` đúng, lần mở sau chỉ hỏi phiên bản, chưa có hàm mới → chạy như cũ; `find_sku_print_guard_browser`, `snapshot_cache_edge_browser`, `find_sku_*` vẫn xanh

### Việc 3 — 4 màn tra tên từ danh mục trên máy · lead · [x]
- [x] In tem SKU (bundle React): đầu `async function uv(r){` và `async function sv(r){` dùng `PrintSkuCatalog` khi đã nạp; trượt → máy chủ
- [x] Ô quét `print-sku-scan-ui` (`sku=eq.`)
- [x] `unit-converter-app` (`sku=eq.`)
- [x] `uid-po-script` (`sku=eq.`)
- [x] Mở mỗi màn → `PrintSkuCatalog.ensure()` + `check()` nền
- [x] Test: mã có trên máy → không gọi `SKU_Name?…eq`; mã không có → gọi máy chủ; chưa nạp xong → gọi máy chủ (thêm vào test có sẵn của từng màn)

### Việc 4 — Cổng in: tên đã thay · lead · [x]
- [x] `enqueue` trong khối `PrintSkuQueue`: `data.renamed` có dòng → `PrintSkuCatalog.patchNames` + sự kiện `print-sku-names-updated` + một thông báo chung ngắn "Tên đã cập nhật: <SKU>"
- [x] Tìm SKU: giữ chặn SKU không có trong danh mục (`verifyNames`), nhãn "Tên đã cập nhật" lấy thêm từ `renamed` của máy chủ
- [x] Test: mock `print_enqueue` trả `renamed` → thông báo + danh mục trên máy đổi tên

### Việc 5 — Review · lead + Codex + `/review-claude` · [x]
- [x] Codex mã + `/review-claude` song song (lần đầu dùng thật), tối đa 3 vòng, `--since last`
- [x] Codex ảnh 1 vòng (gợi ý khi gõ, thông báo tên đã cập nhật; 390 + 1280)
- [x] Lọc 3 nhóm, ghi `RULES.md`

### Việc 6 — Xác minh + lên · lead · [x]
- [x] `kiem-thu` (Sonnet): cả bộ test + chẩn đoán + `commit_gate` + đối chiếu ô tích với diff
- [x] README (In tem SKU, Tìm SKU, mục In), `docs/PROJECT_MAP.md` (khối `sku-catalog-script`, migration)
- [x] Commit (chưa push) → người dùng chạy `python scripts/apply_supabase_sql.py supabase/print_name_from_db_v1.sql` → lead kiểm chỉ đọc (`pg_get_functiondef`) → push
- [x] Bảng "Đánh giá thành viên" trong `RULES.md` (đợt 2)

## Phát sinh
- 18/10 (người dùng hỏi, TẠM GÁC — làm sau khi đợt này xong): trigger `sku_name_touch` trên `SKU_Name` đặt `updated_at = clock_timestamp()` khi thêm dòng / tên hay trạng thái thực sự đổi (ghi y nguyên giữ mốc cũ) → đóng lỗ ghi nhiều mẻ cùng mốc của sku-sync (14/10 có lượt 612 dòng = 2 mẻ), một đồng hồ database, giả định "mọi đường đổi tên đều bump updated_at" thành đảm bảo. Migration riêng `sku_name_touch_v1.sql`, commit riêng. Đã kiểm: ngoài cache không chỗ nào đọc `SKU_Name.updated_at`; trigger hiện có duy nhất `sku_name_inactive_since`.
- 18/10 `find_sku_mobile_browser` chập chờn CÓ TỪ TRƯỚC: ô số tem mất tiêu điểm, "2" rơi vào ô số lượng ("297.500.002 mm"); bản trước đợt này hỏng 2/5, bản mới 5/5 đạt → để sau đợt.
- 18/10 lỗi quy trình: `codex_review.py --prepare-only` lưu ảnh chụp và dời mốc last-snapshot → Codex `--since last` cùng vòng thấy diff rỗng. Đã sửa ngay (prepare-only không lưu ảnh chụp, SKILL review-claude ghi lại), commit riêng với tệp đội agent.
- 18/10 (lead thấy khi viết test): đi thẳng từ ô quét In tem SKU sang `#unit-converter` bằng địa chỉ thì Enter ở ô mã không tra (màn vẫn hiện, bản cũ cũng vậy về hiển thị) → để sau đợt, chưa rõ nguyên nhân; test dùng đường của người dùng (ô trên trang chủ).

## Lệch kế hoạch
- Việc 5 vòng 2: chỉ Codex + reviewer A (Opus) — bỏ B/C vì phần sửa vòng 1 toàn logic, tiết kiệm token. · báo người dùng 18/10
- Việc 2: bỏ ngưỡng "không hỏi lại trong 60 s" — mỗi lần VÀO một trong 4 màn (hoặc chuyển giữa chúng) hỏi phiên bản một lần (vài trăm byte), như Kiểm kê; vừa tải toàn bộ thì không hỏi lại. Lý do: ngưỡng làm màn vào lại không thấy SKU mới, trái test "vào lại màn: kiểm phiên bản". · báo người dùng 18/10
- Việc 1: so tên sau btrim + NFC (tên chỉ khác khoảng trắng / dạng Unicode không bị báo "đã cập nhật"); `print_admin_reprint` không chuyển tiếp `renamed` (tem in lại vẫn mang tên database, màn In lại không báo) — chấp nhận. · báo người dùng 18/10

## Nhật ký
- 19/10 Người dùng chạy migration print_name_from_db_v1; push lần đầu chưa lên GitHub (ls-remote vẫn e5fb2d2) → lead push e5fb2d2..4d92abe theo lời "push". Trang thật (GitHub Pages): không lỗi, danh mục 22.105 SKU nạp 9 s (máy mới, 23 trang, 2 lần hỏi phiên bản). Chưa kiểm được migration bằng truy vấn (MCP Supabase mất kết nối) — người dùng xác nhận đã chạy.
- 18/10 Việc 6: kiem-thu (Sonnet) cả bộ 82/82 PASS (711 s, không chập chờn; đếm 82 tệp = 82 dòng), commit_gate 7 mục ĐẠT, hunk index.html đúng vùng, ô tích khớp diff. Người dùng: "khi test xong bạn commit giúp tôi" → commit, CHƯA push (chờ migration print_name_from_db_v1 sáng 19/10).
- 18/10 Review vòng 3 (cuối): Codex 2 nhóm trung bình (ghi IndexedDB đa tab không nguyên tử; patchNames hạ tên mới hơn vì phản hồi in không mang phiên bản). Đủ 3 vòng → gọi co-van (Fable, lần đầu, ~54k token): hướng B — (i) patchNames chỉ vá RAM, không ghi IndexedDB (Fable kiểm: sku-sync đóng dấu updated_at mọi dòng đổi product_name → check() kế tự lấy tên đúng); (ii) idbPutIfNewer đọc–so–ghi trong một giao dịch readwrite (nguyên tử liên tab). Không cần người dùng quyết (không đổi hành vi thấy được). Không chạy thêm vòng Codex. Test đỏ trước + đột biến (bỏ so newer trong giao dịch → đỏ); 2 test lệch (kỳ vọng ghi đĩa) cập nhật.
- 18/10 Review vòng 3: reviewer A [] (không lỗi). Codex ảnh 1 vòng (6 ảnh 390+1280): 4 góp ý — sửa 1 (thông báo đè thanh đáy "In tem" → bottom 96 px, test đỏ→xanh); bỏ 2 (đổi chữ "Tên tem đã đồng bộ": người dùng đã chốt "Tên đã cập nhật"); 3–4 (kiểu danh sách gợi ý In tem SKU) có từ trước → đợt sau.
- 18/10 Review vòng 2 (Codex + reviewer A): Codex 3 nhóm (ghi đè bản cũ, tải trượt trang không so activeCount, giới hạn 3 vòng dựng chỉ mục); A 1 nhóm (tab giữ bản cũ vá tên ghi lùi — so giờ ghi thay vì phiên bản dữ liệu). Sửa cả nhóm: khoá ghi nối tiếp trong tab (lock), so độ mới theo version.maxUpdatedAt rồi checkedAt (newer), patchNames đọc lại IndexedDB và vá lên bản mới hơn, doFull đối chiếu activeCount + tải lại một lần, Tìm SKU dựng bù (rebuildIfStale). Test đỏ trước: tải thiếu dòng (count 29/30) — PASS sau sửa; vá tên tab cũ — PASS. 8 test liên quan PASS.
- 18/10 Review vòng 1 (Codex + /review-claude lần đầu: A Opus, B Sonnet, C Sonnet, Haiku chấm): 9 nhóm sau gộp. [cả ba] G1 chỉ mục Tìm SKU bỏ lỡ phần đổi lúc đang dựng (60đ); [A,C] G2 bản IndexedDB cũ ghi lùi (50), G3 tải lại liên tục khi lỗi (50), G4 gợi ý không lùi máy chủ (55); [Codex,C] G6 tải toàn bộ không nhất quán (40); [C] G7 renamed khi web không gửi tên (30); [Codex] G9 test chập chờn (55); G5 cache `tl` (20, có từ trước → bỏ); G8 In lại Admin gọi print_enqueue('') (0 — kiểm pg_get_functiondef: bản đang chạy gọi unchecked → báo nhầm); B: ô tích kế hoạch (đã sửa). Không nhóm nào ≥ 80; lead đọc mã xác nhận và sửa G1, G2, G3, G4, G6, G7, G9. Test mới sku_catalog_race_browser (đột biến G1/G3/G4 đều đỏ), G7 đỏ→xanh trong print_name_from_db_sql; 2 test lệch (lần đầu nay hỏi [null, maxUpdatedAt]) cập nhật.
- 18/10 Việc 4: print_renamed_browser PASS (đỏ trước ở bước có renamed), find_sku_print_guard PASS (thêm B1b: máy chủ trả renamed), sku_queue, print_devices, sku_catalog*, PASS.
- 18/10 Việc 3: sku_catalog_screens_browser PASS (đỏ trước ở bước 1: In tem SKU lấy tên máy chủ); unit_converter (chập chờn đã biết: hỏng 1 lần trong lượt chạy chung, chạy riêng 2/2 PASS), group_uid_po, sku_queue, scanner_states, scan_field_standard, sku_it, sku_it_gateway, find_sku_print_guard, sku_catalog PASS.
- 18/10 Việc 1 (thuc-thi-logic, ~89k token, 6 phút): test tĩnh PASS, 11/11 đột biến đỏ, dry-run 5 câu lệnh; lead chạy thử phần SELECT trên dữ liệu thật (chỉ đọc): SKU thật được thay tên + renamed 1, SKU giả giữ tên web, Group UID chỉ có materialName được thêm productName.
- 18/10 Việc 2: sku_catalog_browser PASS; find_sku_print_guard, snapshot_cache_edge, find_sku_combo_normal, find_sku_mobile, snapshot_cache PASS.
