# Bắt khoá máy cho nhóm ghi ở xưởng (2026-10-17)

## Thiết kế
- **Yêu cầu:** rà quyền hàm Supabase cho thấy các hàm ghi ở xưởng ai biết địa chỉ web cũng gọi được; người dùng chọn "Bắt khoá máy cho nhóm ghi" (tra cứu vẫn mở).
- **Kết quả nhìn thấy được:** quét Cắt Group UID, lấy mẫu theo PO, cấp vải, xả vải chỉ chạy trên máy đã kích hoạt (như in tem). Máy chưa kích hoạt thấy thông báo "Máy chưa kích hoạt" kèm lối tới ô KÍCH HOẠT MÁY; không mất dữ liệu đang quét. Tra cứu Group UID, combo, kiểm kê, danh sách phiên/đợt vẫn mở.
- **Đã chốt với người dùng (17/10):** bắt khoá máy cho nhóm GHI; đọc giữ mở.
- **Số đo thật (17/10, Supabase MCP chỉ đọc):** 15 máy `print_devices` đang bật, phần lớn điện thoại xưởng, đều có `last_seen_at` trong 1–5 ngày; khoá chung `legacy-public` đã tắt từ 12/10, khoá chung `print-web-main` (tạo 08/09, token không có trong repo) vẫn bật — cần hỏi người dùng còn ai dùng; 80 lượt cắt Group UID trong 7 ngày. `print_access_allowed(token)` = khoá chung bật hoặc máy bật có token_hash khớp.
- **Hiện trạng lỗ hổng:** 10 hàm `cut_group_uid_*` nhận `p_access_token` nhưng không kiểm (từ `cut_group_uid_v1.sql`); `cut_sample_scan/confirm`, `fabric_issue_scan`, `xa_vai_start/end` không có tham số khoá; publishable key công khai trong `index.html`.
- **Nhóm ghi bị siết:** `cut_group_uid_scan`, `cut_group_uid_mark_adj`, `cut_group_uid_mark_queued`, `cut_group_uid_mark_result`, `cut_group_uid_adj_from_wms`, `cut_group_uid_adj_resolve`, `cut_group_uid_remove` (nếu còn cấp quyền), `cut_sample_scan`, `cut_sample_confirm`, `fabric_issue_scan`, `xa_vai_start`, `xa_vai_end`.
- **Giữ mở (đọc):** `cut_group_uid_list/search/reconcile`, `cut_sample_get/list`, `fabric_issue_get/list`, `xa_vai_list_open/search`, `group_uid_lookup`, `group_uid_moves_*` đọc, `sku_combo_*`, `sku_count_overview`.
- **Triển khai hai pha để không khoá máy xưởng giữa ca:**
  1. *Pha ghi nhận* (`floor_access_settings.mode = 'log'`): hàm kiểm khoá; khoá sai/thiếu vẫn cho chạy nhưng ghi một dòng vào `floor_access_denials` (hàm, thời điểm, có/không có token, KHÔNG lưu token). Web gửi khoá máy cho mọi lệnh ghi và hiện cảnh báo vàng "Máy chưa kích hoạt" khi phản hồi có `accessWarning`.
  2. *Pha bắt buộc* (`mode = 'enforce'`): sau 1–3 ngày không còn dòng ghi nhận lạ (hoặc người dùng nói chuyển), Admin đổi một dòng cấu hình; khoá sai → `{ok:false,error:{code:'ACCESS_DENIED'}}`, web hiện thông báo đỏ và nút tới KÍCH HOẠT MÁY.
- **Hợp đồng dữ liệu:**
  - Hàm mới/sửa nhận `p_access_token text` (cut_* đã có; sample/fabric/xa_vai thêm tham số đầu `p_access_token text default null`, drop bản cũ để PostgREST không lẫn).
  - Kiểm bằng hàm chung `public.floor_access_check(p_access_token text, p_fn text) returns text` → `'ok' | 'warn' | 'deny'` (đọc mode, gọi `print_access_allowed`, ghi denial khi không ok).
  - Phản hồi: `ok` → như cũ; `warn` → như cũ + `accessWarning: true`; `deny` → `{ok:false,error:{code:'ACCESS_DENIED',message:'Máy chưa kích hoạt; vào ô KÍCH HOẠT MÁY.'}}`.
  - Web luôn gửi `p_access_token: window.PrintSkuQueue.accessToken()` (trả "public" khi chưa kích hoạt → không khớp → warn/deny).
- **Rủi ro và cách chặn:** web cũ đang mở trong tab xưởng gọi hàm sample/fabric/xa_vai theo chữ ký cũ → sau migration sẽ 404 vì bản cũ bị drop. Chặn: giữ bản cũ (không token) ở pha ghi nhận, bản cũ gọi `floor_access_check(null, …)` (ghi nhận, vẫn cho chạy); drop bản cũ khi chuyển pha bắt buộc. Thứ tự lên: migration → push web → (1–3 ngày) → đổi mode + migration drop bản cũ.
- **Chưa kiểm được bằng máy:** điện thoại xưởng thật sau khi tải lại trang; máy quét Bluetooth; số máy chưa kích hoạt thật sự (sẽ thấy qua `floor_access_denials`).

## Bản đồ từ trinh sát (17/10)
- Helper `rpc` của khối Cắt (neo `body:JSON.stringify({p_access_token:q.accessToken(),...args})`) đã gửi khoá cho mọi `cut_group_uid_*`, dùng chung cho Cắt tự do, tick ADJ và tab Đối chiếu ADJ (`window.PrintSkuCutUi={rpc,tell,esc,fmt,computeCutQty`).
- Lấy mẫu (`#cut-sample-script`, neo `const rpc = async (name, args) => { const { res, body } = await post(name, args); if (missing(body)) throw new Error('Chưa có dữ liệu Lấy mẫu trên Supabase')`), Cấp vải (`#cap-vai-script`, neo `const rpc=async(name,args)=>{const{res,body}=await post(name,args);if(missing(body))throw new Error('Chưa có dữ liệu Cấp vải trên Supabase')`), Xả vải (script không id, neo `body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});const data=await r.json().catch(()=>null);if(!r.ok||!data)`) có helper riêng, KHÔNG gửi khoá.
- Thông báo máy chưa kích hoạt dùng lại: sự kiện `print-sku-access-denied` (người nghe trong `print-device-script`, chống lặp 60 s, mở hộp Kích hoạt máy) và `window.PrintSkuDevice.open(reason)`.
- SQL mới nhất: scan `sku_inactive_v1.sql`; mark_adj `cut_group_uid_v5_adj_export.sql`; mark_queued `cut_group_uid_v4_allow_reprint.sql`; mark_result `cut_group_uid_v9_mark_result_missing_job.sql`; adj_from_wms `cut_group_uid_v6_wms_reconcile.sql`; adj_resolve `cut_group_uid_v8_adj_resolved.sql`; `cut_group_uid_remove` đã revoke anon/authenticated (bỏ khỏi nhóm siết); cut_sample_scan/confirm `cut_sample_v1.sql`; fabric_issue_scan `fabric_issue_v2_no_double_issue.sql`; xa_vai_start `xa_vai_log_v2_single_slot.sql`; xa_vai_end `xa_vai_log_v1.sql`. Lỗi trả `{ok:false,error:{code,message}}`, không raise.
- Test: không test nào khẳng định `p_access_token` cho nhóm này; Cấp vải và Xả vải chưa có test RPC.

## Kế hoạch
Thứ tự: Việc 1 → (Việc 2 ‖ Việc 3) → Việc 4.

### Việc 1 — SQL pha ghi nhận · thuc-thi-logic · [x]
- Tệp: `supabase/floor_access_v1.sql` (mới).
- Nội dung: bảng `floor_access_settings` (singleton, `mode` 'log'|'enforce' mặc định 'log'), `floor_access_denials` (id, fn, has_token, at; giữ 30 ngày — thêm vào hàm dọn hiện có hoặc hàm riêng + cron), hàm `floor_access_check`; tạo lại 7 hàm `cut_group_uid_*` ghi với dòng kiểm đầu thân hàm; thêm bản có `p_access_token` cho `cut_sample_scan/confirm`, `fabric_issue_scan`, `xa_vai_start/end` (giữ bản cũ, bản cũ gọi check với null). Thân hàm lấy từ tệp migration mới nhất của từng hàm (trinh sát chỉ ra), chỉ thêm khối kiểm và trường `accessWarning`.
- Test đỏ trước: `tests/floor_access_sql.cjs` (mới) — chạy được bằng Postgres? KHÔNG có Postgres cục bộ → kiểm bằng dry-run + rà tay; ghi rõ trong báo cáo. Bổ sung kiểm cấu trúc: grep mỗi hàm ghi đều gọi `floor_access_check`.
- Lệnh: `python scripts/apply_supabase_sql.py supabase/floor_access_v1.sql --dry-run`.
- Ngoài phạm vi: hàm đọc, print_*, Edge.

### Việc 2 — Web gửi khoá + cảnh báo · thuc-thi-khuon · [x]
- Tệp: `index.html` các khối gọi RPC ghi (neo do trinh sát cung cấp) + test của từng màn.
- Test đỏ trước: mỗi test màn (cut_group_uid_browser, cut_sample_browser, cap_vai/fabric, xa_vai) khẳng định body RPC ghi có `p_access_token`; mock trả `accessWarning:true` → hiện cảnh báo vàng có nút KÍCH HOẠT MÁY; mock `ACCESS_DENIED` → thông báo đỏ, không xoá ô đang quét.
- Lệnh: các test trên + 4 bộ chuẩn.
- Ngoài phạm vi: khối in tem, React bundle.

### Việc 3 — Màn Admin xem ghi nhận · gộp: RPC trong Việc 1, giao diện trong Việc 2 · [ ]
- RPC Admin (Việc 1): `floor_access_summary()` → `{mode, days:[{fn, count, lastAt}] 7 ngày}` và `floor_access_set_mode(p_mode)`; cả hai kiểm `print_admin_allowed()`, chỉ cấp authenticated.
- Giao diện (Việc 2): trong tab Thiết bị của màn Lệnh in Admin (`print-devices-tab-script`), một thẻ "Khoá máy xưởng": chế độ hiện tại, số lần máy chưa kích hoạt 7 ngày theo hàm, công tắc Ghi nhận / Bắt buộc.

### Việc 4 — Pha bắt buộc · lead · [ ]
- Sau 1–3 ngày: đọc `floor_access_denials`, báo người dùng; người dùng bật Bắt buộc; migration `floor_access_v2_drop_legacy.sql` xoá bản hàm cũ không token.

## Nhật ký
- 2026-10-17 tối: rà quyền qua MCP, người dùng chọn bắt khoá cho nhóm ghi; thiết kế này; chờ trinh sát định vị chỗ gọi trong index.html.
- 2026-10-17 tối: trinh sát xong (bản đồ ở trên); khoá chung legacy-public đã tắt, print-web-main còn bật; giao Việc 1 (SQL + RPC Admin, Opus) và Việc 2 (web + thẻ Admin, Sonnet) song song trong worktree.
- 2026-10-17 tối: người dùng "tắt và bật chế độ bắt buộc" → BỎ pha ghi nhận: migration đặt mode='enforce' và tắt print-web-main (đo: 227/228 lệnh in 6 ngày qua có device_id, lệnh còn lại là in lại Admin). Lead thử UPDATE qua MCP bị bộ lọc auto mode chặn (Secret-Store Writes) → đưa vào migration để người dùng chạy. Lên ngoài giờ làm: migration → push web → sáng nhân viên tải lại trang.
- 2026-10-17 tối: Việc 1 gộp vào cây chính (supabase/floor_access_v1.sql 103 câu lệnh, tests/floor_access_sql.cjs PASS; TDD đỏ→xanh có trích). Thân cũ thành _<tên>_body, hàm công khai = check + body + gộp cờ. Bản mới 5 hàm KHÔNG default p_access_token (tránh trùng overload). Soát đặc tả (kiem-thu): (a)–(g) ĐẠT; lệch duy nhất: summary trả {ok,data:{mode,since,updatedAt,items[{fn,count,withToken,lastAt}]}} thay vì {mode,days} — CHẤP NHẬN (khuôn chung), đã báo người làm Việc 2. Lead kiểm DB thật: 11 hàm đều jsonb, owner postgres, chữ ký khớp. Còn khoá chung bật: chỉ print-web-main (sẽ tắt trong migration).
- 2026-10-17 tối: Codex vòng 1 SQL — 3 phát hiện, SỬA cả 3 (lead, TDD đỏ→xanh): (1 nghiêm trọng) floor_access_check dùng print_access_allowed nên khoá chung vượt cổng → đổi sang print_device_by_token (chỉ máy đã kích hoạt) + tắt rõ cả print-web-main lẫn legacy-public; (2) thiếu singleton → fail-open → đổi thành `when v_mode='log' then 'warn' else 'deny'`; (3) anon làm phình floor_access_denials → gộp theo (fn, has_token, bucket phút) + hits, PK, summary sum(hits). tests/floor_access_sql.cjs PASS, dry-run 102 câu lệnh.
- 2026-10-17 tối: Việc 2 + giao diện Việc 3 gộp (index.html, tests/floor_access_browser.cjs mới, 3 test đổi BASE theo env). Lưu ý: Cấp vải/Lấy mẫu xoá ô quét khi xếp hàng (hành vi cũ) nên ACCESS_DENIED không giữ giá trị ô; Cắt và Xả vải giữ. Lead tự soát phát hiện lỗi do chính mình đưa vào: upsert `as d` nhưng cộng `public.floor_access_denials.hits` (Postgres che tên gốc khi có alias → lỗi khi chạy) → sửa `d.hits + 1`, TDD đỏ→xanh.
- 2026-10-17 tối: soát đặc tả Việc 2: (a)–(f) ĐẠT, 6 test PASS. LỆCH nhỏ: Cấp vải/Lấy mẫu không giữ ô quét khi ACCESS_DENIED vì hàng đợi quét liên tục xoá ô ngay lúc nhận mã (hành vi cũ) → LEAD SỬA ĐẶC TẢ: chấp nhận; hộp Kích hoạt máy mở ngay nên người quét biết phải kích hoạt rồi quét lại, không mất dữ liệu đã ghi (lệnh bị chặn không ghi gì).
- 2026-10-17 tối: Codex vòng 2 (cuối): web + 3 sửa SQL không lỗi; 1 trung bình: dòng nóng khi bị gọi dồn → SỬA (lead, TDD): ghi một dòng/phút `on conflict do nothing`, bỏ cột hits, summary count(*) = số phút, cột Admin đổi "Số phút". PROJECT_MAP + README cập nhật. Đang chạy run_tests.py cả bộ.
- 2026-10-17 tối: run_tests.py 69/69 PASS (591 s). Quét dòng thêm mới: không khoá; UID trong khối test mới của cut_group_uid_browser đổi sang 1028260000000901/902; cut_sample_browser giữ UID fixture có sẵn từ HEAD (dạng 1028261016000xxx sinh bằng phép cộng). Chờ người dùng commit → chạy floor_access_v1 + db_hygiene_v1 buổi tối → push web → sáng tải lại trang. Việc 4 (drop bản cũ) để sau.
