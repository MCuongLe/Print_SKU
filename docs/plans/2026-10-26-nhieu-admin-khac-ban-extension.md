# Nhiều Admin đồng bộ với các bản Extension khác nhau (2026-10-26)

Trạng thái: ĐỀ XUẤT, chưa chốt, chưa build. Chưa qua review Codex / co-van. Nguồn: kiểm mã Extension 0.10.9, Edge `sku-sync` + `group-uid-sync`, migration `sync_auto_v1/v2`, số đo Supabase chỉ đọc 26/10/2026.

## Thiết kế
- **Yêu cầu:** "Lập kế hoạch xử lý tình huống khi nhiều admin đồng bộ với các Extension khác nhau."
- **Kết quả nhìn thấy được:**
  - Màn Đồng bộ SKU và Đồng bộ Group UID có bảng "Máy đồng bộ": tên máy, bản Extension, lần cuối, loại; máy thấp hơn mức tối thiểu hoặc chưa khai báo bản hiện đỏ.
  - Máy bản cũ không ghi được dữ liệu: lượt tự động và lượt tay đều bị từ chối trước khi đọc Inside / WMS, kèm câu nói rõ cần bản nào.
  - Icon "!" và thẻ đỏ ở Options của Extension báo ngay khi bản thấp hơn mức tối thiểu, không chờ 70 phút "ngừng".
- **Hiện trạng (bằng chứng):**
  - Extension không gửi số bản cho server: `edge()` trong `auto-sync.js` chỉ gửi `{ action, ...payload }`; `getManifest().version` chỉ dùng cho PING và icon.
  - Không bảng nào có cột bản: `sku_sync_runs`, `group_uid_sync_runs`, `sync_auto_leases`, `sync_auto_settings` (đo `information_schema` 26/10/2026).
  - Chặn bản cũ chỉ có một chỗ: web Group UID Đối chiếu, hằng `MIN_EXT="0.10.4"` — literal phiên bản duy nhất trong `index.html` (grep 26/10/2026). Đồng bộ SKU tay chỉ PING xem Extension có sống không; các màn đọc WMS khác chỉ hiện bản, không so mức tối thiểu.
  - Khoá thuê chống chạy chồng giữa các máy, không phân biệt bản. Lượt tay không thuê khoá; SKU `apply` kiểm `staleReason`, Group UID kiểm `ACTIVE_RUN`.
  - Extension nạp tay từ thư mục repo (Reload), không tự cập nhật: lệch bản là trạng thái bình thường, tới khi từng Admin pull rồi Reload.
- **Số đo thật** (26/10/2026 ~10:59 giờ VN, Supabase MCP chỉ đọc, cửa sổ 7 ngày):
  - SKU tự động hoàn tất: máy A 44 lượt (43 gia tăng + 1 toàn bộ; 20/10 → 26/10 10:56); máy B 7 lượt (24/10, cuối 12:27) kèm 9 lượt 19/10 dưới tên viết hoa khác. Từ 24/10 12:27 chỉ máy A còn chạy.
  - Group UID tự động: máy A 74 hoàn tất, 2 lỗi (24/10 12:24); máy B 1 hoàn tất (24/10) + 1 lỗi (24/10 12:26) kèm 9 lượt 19/10 tên viết hoa.
  - Lượt tay: 7 lượt SKU hoàn tất, 18 lượt Group UID hoàn tất — cột `device` rỗng, không biết bản Extension nào.
  - Khoá thuê đang trống; mốc kết thúc gần nhất 26/10 10:56 (SKU, Group UID, ADJ), Rủi ro lưu trữ 10:27.
  - Không biết máy B đang ở bản nào (không có dữ liệu). Hai tên máy viết khác nhau (hoa / thường) chưa biết cùng máy hay không.

### Các kiểu hỏng khi lệch bản
| # | Kiểu hỏng | Căn cứ | Hiện chặn bởi | Khoảng hở |
|---|---|---|---|---|
| A | Bản cũ đọc lỗi, không ghi | 0.10.8 gặp nhãn "Pending": SKU tự động dừng 24/10 → 26/10 (N20261026-0837) | D7: lượt lỗi, không ghi; nhả khoá không đặt mốc nên không chặn máy khác | Không ai biết do bản cũ; cảnh báo chỉ nói "ngừng" |
| B | Bản cũ đọc sai mà vẫn ghi | < 0.10.7 bỏ SKU sửa giữa lượt toàn bộ → Edge coi "rời nhóm" → tự lưu trữ (G1); < 0.10.8 nhãn lạ → "0" (D7) và `data_until` theo đồng hồ máy (D8) | Ngưỡng Vừa (sku: thiếu 20, sửa 500, thêm 500) chỉ bắt số lớn | Sai nhỏ lọt; không chặn theo bản |
| C | Mốc gia tăng bị nhiễm | `lastSnapshotAt` (SKU) và `range_from` (Group UID) lấy từ lượt hoàn tất gần nhất của MỌI máy | Lượt toàn bộ mỗi đêm vá lại | Phần bản cũ bỏ sót tồn tại tới 1 ngày; lượt đêm do bản cũ làm thì không vá |
| D | Đổi hợp đồng Edge / RPC khi còn máy cũ | "Reload mọi máy" là bước tay (AGENTS luật 4), không có kiểm đã Reload | Thứ tự lên + chặn `MIN_EXT` ở một nút web | Không biết máy nào chưa Reload |
| E | Lượt tay trên web bằng Extension cũ | Mỗi Admin dùng Extension của máy mình | `MIN_EXT` chỉ ở Group UID Đối chiếu | SKU, ADJ, Rủi ro lưu trữ tay không kiểm bản |
| F | Chạy chồng giữa các máy | Khoá thuê 15 phút + cooldown; `staleReason`; `ACTIVE_RUN` | Đủ | Ngoài phạm vi kế hoạch này |

- **Đã chốt với người dùng:** chưa có. Mặc định đề xuất ở mục "Cần chốt".
- **Hợp đồng dữ liệu:**
  - Mọi lệnh Edge `sku-sync` / `group-uid-sync` nhận thêm `extVersion` (chuỗi `d.d.d`, ≤ 20 ký tự; thiếu = chưa khai báo). Extension gửi trong `edge()`; web gửi cùng giá trị đã PING.
  - `sync_auto_settings.min_extension` jsonb `{ "sku": "x.y.z", "group_uid": …, "cut_adj": …, "storage_risk": … }`; rỗng / thiếu khoá = không chặn loại đó.
  - Cổng: `lease` (cả 4 loại), `preview` (SKU), `prepare` (Group UID). Bản thiếu hoặc thấp hơn mức tối thiểu → HTTP 409 `EXTENSION_OUTDATED`, câu "Extension v{x | chưa khai báo} quá cũ, cần ≥ {min}; Reload Extension rồi tải lại tab". Lượt tay trên web: "… tải lại trang".
  - Ghi nhận: bảng mới `sync_auto_devices` (khoá `holder`: tên máy + mã máy; `device`, `ext_version`, `first_seen_at`, `last_seen_at`, `last_kind`) cập nhật ở `lease` và `preview` / `prepare`; cột mới `ext_version` ở hai bảng lượt. Lỗi ghi nhận không làm hỏng lượt.
  - `auto-config` trả thêm `minExtension` và `devices` (tối đa 20 dòng, 14 ngày gần nhất). So sánh bản theo từng đoạn số (`0.10.10` > `0.10.9`), không so chuỗi.
- **Rủi ro và cách chặn:**
  - Edge có cổng nhưng `min_extension` rỗng thì không chặn gì: deploy Edge trước, Extension sau, không gây ngừng (test: min rỗng → luôn qua).
  - Nâng min quá sớm làm đồng bộ ngừng ở máy chưa lên: chỉ nâng khi bảng máy cho thấy mọi máy thấy trong 7 ngày đã khai báo bản ≥ min; hạ lại bằng một lệnh SQL.
  - Bản đầu tiên khai báo là 0.10.10, nên lần nâng min đầu tiên ép mọi máy Reload thêm một lần (0.10.9 không khai báo được).
  - So bản sai ở một trong ba nơi (Edge Deno, Extension, web): dùng chung bảng ca test, có ca `0.10.10` vs `0.10.9`.
  - Tab web cũ (cache) không gửi `extVersion` nên bị coi chưa khai báo: câu lỗi riêng "tải lại trang".
  - Tên máy trùng: khoá theo `holder` (có mã máy), bảng hiện kèm 4 ký tự mã.
  - `index.html` sửa nhỏ, nhiều phiên cùng sửa: commit chỉ phần của mình.
- **Chưa kiểm được bằng máy:** Reload thật trên từng máy Admin; hành vi bản cũ (≤ 0.10.9) khi gặp 409 `EXTENSION_OUTDATED` ở `lease` (suy ra từ mã `edge()` ném lỗi mang câu của Edge, chưa thử với Extension thật); máy B đang ở bản nào.
- **Đã cân nhắc, không chọn:** Extension tự cập nhật (Web Store hoặc `update_url`) — cần ký gói và chỗ lưu, trái luật "không thêm bước build". Chỉ để một máy chạy tự động, máy khác tắt — làm được ngay bằng công tắc có sẵn nhưng không cứu lượt tay và không báo máy lệch.

## Kế hoạch
Thứ tự chạy: Việc 0 làm ngay, song song mọi việc → Việc 1 → Việc 2 → Việc 3 và Việc 4 song song (cùng hợp đồng Việc 2) → Việc 5 → Việc 6.

### Việc 0 — Biết máy đang ở bản nào, không cần code · người dùng · [ ]
- [ ] Mở Options Extension trên máy B (và máy Admin khác nếu có): ghi bản (`vX.Y.Z`) và tên máy.
- [ ] Trả lời hai câu: hai tên máy viết khác nhau có cùng máy không; máy B còn dùng để đồng bộ không.
- Nếu máy B còn bản ≤ 0.10.8: Reload bản 0.10.9 rồi tải lại tab Inside (đây cũng là việc đang chờ từ commit `166b6ff`).

### Việc 1 — Migration `supabase/sync_auto_v3.sql` · thuc-thi-logic · [x] (viết xong, chưa chạy lên Supabase)
- Tệp và neo: tệp mới; chép khuôn `supabase/sync_auto_v2.sql` (begin/commit, `notify pgrst`).
- [x] Bảng `sync_auto_devices` (RLS bật, không policy, `revoke all … from public, anon, authenticated`, `grant` cho `service_role`). Bằng chứng: `supabase/sync_auto_v3.sql` dòng 23–34; `node tests/sync_auto_v3_sql.cjs` PASS.
- [ ] `alter table … add column if not exists`: `ext_version text` (≤ 20) ở `sku_sync_runs` và `group_uid_sync_runs`; `min_extension jsonb not null default '{}'` ở `sync_auto_settings`. Không drop, không đổi chữ ký hàm. Bằng chứng: dòng 36–43; `apply_supabase_sql.py --dry-run` 17 câu lệnh, không cảnh báo DROP / DELETE.
- [x] Test đỏ trước: `tests/sync_auto_v3_sql.cjs` (khuôn `tests/sync_auto_v2_sql.cjs`) khẳng định bảng, cột, RLS, revoke, không có `drop`. Bằng chứng: đỏ trên khung rỗng (`AssertionError: có bảng sync_auto_devices`), xanh sau khi viết: 11/11 đột biến bị bắt (lead chạy lại 26/10 11:24).
- Ngoài phạm vi: sửa `sync_auto_lease` / `sync_auto_release`.

### Việc 2 — Edge `sku-sync` và `group-uid-sync` · thuc-thi-logic · [x] (viết xong, chưa deploy)
- Tệp và neo: `supabase/functions/sku-sync/index.ts` → `async function lease(`, `async function preview(`, `async function autoConfig(`; `supabase/functions/group-uid-sync/index.ts` → `group_uid_sync_prepare`, lease.
- [x] Hàm so bản theo đoạn số + `extVersionOf(body)` (cùng bảng ca test với Extension và web). Bằng chứng: khối chép giống hệt ở hai tệp giữa `// >>> cổng bản Extension` và `// <<< cổng bản Extension`; test so từng ký tự trong `tests/sku_sync_function.mjs`; bảng ca nằm giữa `// >>> bảng ca so bản Extension` và `// <<<` ở hai tệp test.
- [x] Cổng `EXTENSION_OUTDATED` ở `lease`, `preview`, `prepare`; không chặn khi `min_extension[kind]` trống. Bằng chứng: test "mức rỗng hoặc thiếu cột" và "bảng ca chung" ở cả hai tệp.
- [ ] Ghi `sync_auto_devices` và `ext_version` của lượt (lượt Group UID: PATCH sau khi `prepare` trả `runId`, không đổi chữ ký RPC); lỗi ghi chỉ bỏ qua. Bằng chứng: test "ghi nhận máy" và "ext_version của lượt"; `insertRun` ghi lại không có cột khi database báo thiếu `ext_version`.
- [x] `auto-config` trả `minExtension` và `devices`. Bằng chứng: test "auto-config" ở hai tệp (≤ 20 máy, 14 ngày, chỉ 4 ký tự mã máy, `set min_extension` bị từ chối).
- [ ] Test đỏ trước: `tests/sku_sync_function.mjs`, `tests/group_uid_sync_function.mjs` — min rỗng → qua; thấp hơn / thiếu → 409; bằng → qua; `0.10.10` ≥ `0.10.9`; `auto-config` có hai trường mới. Bằng chứng: đỏ trước (sku 7 test đỏ / 57, group_uid 6 / 22), xanh sau; lead chạy lại 26/10 11:24: `sku_sync_function` 57/57, `group_uid_sync_function` 22/22, `sync_auto_v2_sql` 8/8 đột biến.
- Ngoài phạm vi: chặn RPC Admin ghi trực tiếp từ web (ADJ, Rủi ro lưu trữ, UID tạm, Kiểm kê thủ công); chỉ lượt tự động của hai loại đó đi qua `lease` nên được chặn.

### Việc 3 — Extension 0.10.10 · thuc-thi-logic · [x] (viết xong, chưa Reload thật)
- Tệp và neo: `extension/inside-po-connector/auto-sync.js` → `async function edge(` (một chỗ dựng body), `function decide(`, `function assessHealth(`; `manifest.json`, `README.md`.
- [x] `edge()` gửi `extVersion` từ `chrome.runtime.getManifest().version` (nhận qua `deps.version` để test). Bằng chứng: `tests/auto_sync_core.cjs` ca (a) — mọi lệnh Edge có `extVersion`.
- [ ] `decide` nhận `minExtension` từ `auto-config`: bản thấp hơn → không thuê khoá, không đọc, log "Cần Extension ≥ x"; `assessHealth` báo ngay (icon "!", thẻ đỏ Options). Bằng chứng: ca (b)–(d) và `tests/extension_options_browser.cjs` khối 5 (thẻ đỏ).
- [x] Mã `EXTENSION_OUTDATED` từ server cùng được xử lý như trên (máy lệch giữa lúc đọc cấu hình và lúc thuê). Bằng chứng: ca (e), (g), (h) — kể cả 409 ở lần GIA HẠN khoá (sau review vòng 1): lượt dừng ngay, Group UID huỷ lượt đã `prepare`.
- [x] Nâng version 0.10.10 đồng bộ manifest, README, test, và mọi fixture ghim bản (như lần 0.10.9: `commit_gate` mục 5). Bằng chứng: manifest, README (đoạn 0.10.10) và 11 tệp test / fixture; `commit_gate` 7 mục ĐẠT.
- [x] Test đỏ trước: `tests/auto_sync_core.cjs` (gửi `extVersion`; bản thấp → không gọi `lease`; 409 → cảnh báo), `tests/extension_options_browser.cjs` (thẻ đỏ). Bằng chứng: đỏ trước (ca a–f trên mã cũ), xanh sau; bộ đột biến 31/31 bị bắt.

### Việc 4 — Web Admin (`index.html`) · thuc-thi-logic · [x] (viết xong, chưa thử với Edge thật)
- Tệp và neo: khối Đồng bộ SKU (`style id="sku-sync-admin-style"`, `edge("preview",{snapshot,mode})`), khối Đồng bộ Group UID (`const MIN_EXT=`, `edge("prepare",{mode})`); tìm bằng `python scripts/index_outline.py sku-sync`.
- [ ] Lượt tay gửi `extVersion` (đã có từ PING; SKU hiện chưa giữ giá trị này) trong `preview` (SKU) và `prepare` (Group UID); thay hằng `MIN_EXT` bằng `minExtension.group_uid` của `auto-config` (hằng cũ làm dự phòng khi đọc cấu hình lỗi).
  - Bằng chứng: `tests/admin_web_sync_browser.cjs` mục 6 (SKU), `tests/group_uid_sync_admin_browser.cjs` (Group UID). Mức Group UID = số cao hơn giữa mức server và `MIN_EXT` (xem "Lệch kế hoạch").
- [x] Bảng "Máy đồng bộ" ở hai màn: cột tên máy + mã 4 ký tự, bản, lần cuối, loại; hàng đỏ khi thấp hơn min hoặc chưa khai báo. Chỉ nhãn ngắn và biểu tượng, không câu hướng dẫn; chỉ xét máy tính. Bằng chứng: pop-up đỏ / vàng / thường, mở bằng bàn phím, `a11y_axe_browser` 32 lượt 0 lỗi; ảnh 1280 gửi Codex một vòng.
- [x] Test đỏ trước: `tests/admin_web_sync_browser.cjs`, `tests/group_uid_sync_admin_browser.cjs` (bảng, hàng đỏ, `extVersion` có trong body preview / prepare). Bằng chứng: đỏ trước, xanh sau; đột biến 4/4 bị bắt; sau review thêm ca "nạp lại cấu hình sau lượt lỗi".
- Ngoài phạm vi: bản điện thoại của Admin.

### Việc 5 — Tài liệu và quy trình · lead · [x]
- [x] `docs/chuan/DU_LIEU.md`: mỗi thay đổi Extension / Edge phân loại "tương thích ngược" | "sửa sai dữ liệu" | "phá hợp đồng"; hai loại sau phải nâng `min_extension` (sau khi bảng máy xanh). Bằng chứng: 3 dòng mới ở mục "Đồng bộ từ Inside / WMS" (phân loại thay đổi, cổng bản, khối chép giống hệt) + dòng nâng phiên bản sửa cho khớp.
- [x] `docs/QUYET_DINH.md` chủ đề 8: dòng luật cổng bản + mã nhật ký mới; sửa dòng "Extension cũ phải tương thích hoặc bị màn Admin chặn" cho khớp; dòng "Trạng thái lên thật".
  - Bằng chứng: 5 dòng luật cổng bản ở chủ đề 8, dòng "Thứ tự lên" và "Extension trong repo" sửa; chủ đề 12 (làm sau, chưa kiểm thật); mục "Trạng thái lên thật" kiểm lại 26/10 14:33 bằng `live_status.py` (thêm `sync_auto_v3` vào CHƯA LÊN, sửa dòng Extension 0.10.9 đã cũ).
- [x] `docs/PROJECT_MAP.md` mục 3 (action Edge, bảng, test mới), `extension/inside-po-connector/README.md`. Bằng chứng: `PROJECT_MAP.md` mục 2 (nút / pop-up Máy đồng bộ), mục 3 (manifest 0.10.10, `auto-sync.js`, nâng phiên bản), mục 4 (action Edge, bảng `sync_auto_devices`, chuỗi `sync_auto_v3`); README gốc (hai đoạn mới); README Extension đã có đoạn 0.10.10 từ Việc 3.
- [x] `scripts/live_status.py` in bảng máy (chỉ đọc) + `tests/test_live_status.py`. Bằng chứng: câu SELECT riêng `DEVICES_SQL` (lỗi → "chưa có bảng"), `ext_less`, `device_line`; `tests/test_live_status.py` 14/14 (`run_tests.py --only test_live_status` 1/1); chạy thật chỉ đọc 26/10 14:40 in "chưa có bảng `sync_auto_devices`" và `sync_auto_v3.sql` ở CHƯA LÊN.
- [x] `git diff --check`; mọi mã `N…` mới grep ra đúng một dòng trong `RULES.md`. Bằng chứng (14:37): `git diff --check` sạch; dòng thêm ≤ 400 ký tự; `commit_gate` 7 mục ĐẠT (1 cảnh báo: tệp chưa theo dõi); mã `N20261026-1102` có đúng một thẻ trong `RULES.md`.

### Việc 6 — Lên thật và nâng mức tối thiểu · người dùng + lead · [ ]
Thứ tự (AGENTS luật 4): commit (chưa push) → migration → deploy Edge → Reload 0.10.10 trên MỌI máy Admin + tải lại tab → push web.
- [ ] `python scripts/apply_supabase_sql.py supabase/sync_auto_v3.sql` (không có drop nên không cần cờ); lead kiểm chỉ đọc bảng và cột.
- [ ] `python scripts/deploy_sku_sync.py` và `python scripts/deploy_group_uid_sync.py`.
- [ ] Mỗi Admin Reload Extension, tải lại tab Inside / WMS; lead đọc `sync_auto_devices` xác nhận từng máy.
- [ ] Quan sát 3–7 ngày (đủ một lượt toàn bộ đêm mỗi máy). Khi mọi máy thấy trong 7 ngày khai báo ≥ 0.10.10: người dùng chạy `update public.sync_auto_settings set min_extension = '{"sku":"0.10.10","group_uid":"0.10.10","cut_adj":"0.10.10","storage_risk":"0.10.10"}'`.
- [ ] Ngay sau khi nâng min: một lượt toàn bộ SKU và Group UID bằng máy bản mới để vá mốc gia tăng (kiểu C); không cần mã.
- [ ] Rút lui: `update public.sync_auto_settings set min_extension = '{}'` — cổng mở lại ngay, không cần deploy.

## Cần chốt (khuyến nghị đặt đầu)
1. Hai bước (ghi nhận 3–7 ngày rồi mới chặn) hay chặn ngay khi lên? **Khuyến nghị: hai bước**, vì lần đầu chưa máy nào khai báo bản.
2. Lượt tay trên web cũng bị chặn? **Khuyến nghị: có**, cùng cổng `preview` / `prepare`, câu báo rõ "tải lại trang".
3. Mức tối thiểu đặt theo từng loại hay một số chung? **Khuyến nghị: bắt đầu một số chung 0.10.10**, về sau tách theo loại khi có bản sửa chỉ ảnh hưởng một loại.
4. Máy B và tên viết khác (Việc 0) cùng máy hay khác máy?

## Phát sinh
- 26/10/2026 11:24 Hiện bản Extension ở dòng lịch sử lượt (Admin thấy "Tự động · máy · v0.10.10"): `history` của hai Edge chưa chọn cột `ext_version`; chọn thêm cột này làm hỏng lịch sử nếu Edge lên trước migration (cần đường lùi khi thiếu cột). Việc 4 KHÔNG làm; để sau đợt, commit riêng nếu người dùng muốn.
- 26/10/2026 13:4x Sau review vòng 1: "holder trong `auto-config`" (máy bị chặn mọi loại vẫn được ghi nhận còn sống, tránh rơi khỏi bảng sau 14 ngày) và bốn góp ý chuỗi / nhãn của Codex ảnh ("Chưa báo bản", nhãn "Bị chặn", chữ "máy" cạnh số, dời chip mức) → để sau, người dùng quyết.

## Lệch kế hoạch
- `extVersionOf` kiểm chặt, không cắt khoảng trắng: `" 0.10.10"` coi là chưa khai báo. Việc 3 và Việc 4 phải gửi đúng chuỗi `x.y.z` (bản manifest). Đã báo người dùng 11:24.
- Lượt tay trên web không hiện trong bảng "Máy đồng bộ": bảng khoá theo `holder` (chỉ Extension tự động có). Lượt tay vẫn ghi `ext_version` ở dòng lượt. Đã báo người dùng 11:24.
- Đọc `sync_auto_settings` lỗi ở `lease` / `preview` / `prepare` trả 500 (chặn, không cho qua): trước đây ba thao tác này không đọc bảng cấu hình. Lead giữ theo hướng an toàn. Đã báo người dùng 11:24.
- Mức tối thiểu Group UID trên web = số cao hơn giữa `minExtension.group_uid` của server và hằng `MIN_EXT = 0.10.4` (sàn để có số PO), không phải "server thắng tuyệt đối" như kế hoạch. Đã báo người dùng 13:4x.
- `min_extension` có CHECK ngay trong migration (giá trị sai dạng và khoá lạ bị DB từ chối) — kế hoạch gốc để Edge bỏ qua lặng. Đã báo người dùng 13:4x.
- Gia hạn khoá nhận 409 `EXTENSION_OUTDATED` dừng lượt ngay (kế hoạch gốc coi như lỗi mạng ≤ 14 phút). Đã báo người dùng 13:4x.

## Nhật ký
- 26/10/2026 11:02 [N20261026-1102] Soạn kế hoạch (lead): số đo Supabase chỉ đọc, kiểm mã `auto-sync.js`, Edge `sku-sync`, `sync_auto_v1/v2`. Chưa review Codex / co-van; chưa sửa mã; chưa commit.
- 26/10/2026 11:24 Việc 1 + Việc 2: giao `thuc-thi-logic` (Opus, cây chính); lead duyệt diff hai Edge + migration, chạy lại test, không thấy lỗi. Chưa qua Codex / `/review-claude` (một vòng cuối đợt, sau Việc 3–4); chưa kiểm kiểu TypeScript (máy không có Deno); chưa commit / migration / deploy.
- 26/10/2026 13:4x Việc 3 + Việc 4: giao hai `thuc-thi-logic` song song (cây chính, tệp tách riêng). Review vòng 1 (Codex mã + ảnh, `/review-claude` A + BC, Fable `co-van`): 3 + 6 + 4 + 5 nhóm thô → sửa 4 nhóm (E1 Extension, E2 + S Edge / migration, W web SKU), bỏ qua / để sau phần còn lại. Sửa xong chưa review lại (người dùng chỉ yêu cầu một vòng).
- 26/10/2026 14:37 Việc 5 (lead, Sonnet): sửa 4 tài liệu + `live_status.py` + test; chưa commit; Việc 6 (lên thật) chờ người dùng.
