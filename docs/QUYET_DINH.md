# Quyết định đang hiệu lực

> 1. Agent mới: đọc hết tệp này một lần trước khi làm; đây là quyết định hiện hành theo chủ đề và module, bản cũ đã bị thay đã được bỏ khỏi đây. Chuẩn kỹ thuật dùng chung ở `docs/chuan/`.
> 2. Cuối mỗi dòng: (ngày chốt · mã nhật ký); `[?]` = không ghi ngày. Mã `[N0965]` / `[N<yyyymmdd>-<hhmm>]` tra trong nhật ký `RULES.md` — chỉ có trên máy người dùng, không vào git (nguyên văn yêu cầu, số đo, căn cứ).
> 3. Có quyết định mới: ghi nhật ký `RULES.md` (mã mới) VÀ sửa / thay dòng ở đây trong cùng commit; không để hai bản cùng hiệu lực. Khuôn: `docs/chuan/TAI_LIEU.md`.
> 4. Tách từ mục lục đầu `RULES.md` ngày 25/10/2026; repo public nên không ghi email, khoá, SKU / UID / PO thật.

---

## 1. Quy trình làm việc & đội agent
- Hiểu dự án nhanh: thứ tự đọc AGENTS → `docs/CONTEXT_MAP.md` (6 nguồn + sơ đồ + repomix) → PROJECT_MAP → tệp này; `scripts/index_outline.py` cho dòng khối index.html (mọi style/script có id); grep index.html giới hạn độ dài dòng; quyết định mới ghi CẢ nhật ký lẫn mục lục. (23/10 · N1184)

### Đội agent và review
- Đội agent bản 3: lead (Opus) tự làm phần lớn việc, kể cả giao diện; `trinh-sat`, `thuc-thi-logic`, `kiem-thu` chỉ dùng khi việc chạy song song thật; vai trò chi tiết ở `docs/DOI_AGENT.md`. (18/10 · N1013, N1039)
- Bốn luật cứng: có bằng chứng mới báo "xong"; tìm nguyên nhân gốc trước khi sửa lỗi; chỉ commit khi người dùng bảo; migration trước push. Test đỏ trước chỉ áp cho sửa lỗi/đổi logic; tệp kế hoạch `docs/plans/` chỉ cho migration nhiều bước. (18/10 · N1013; AGENTS.md)
- Review: một vòng Codex mỗi đợt cho SQL/Edge/Extension/luồng in/quyền VÀ giao diện (ảnh chụp), chạy song song `/review-claude` (A/B/C + Haiku lọc ≥ 80); tối đa 3 vòng rồi đổi hướng, vòng sau chỉ diff vừa sửa (`--since last`), gom lỗi theo loại. (18/10 · N1016, N1037)
- `co-van` (Fable, chỉ đọc) là bước cố định mỗi vòng review: gộp phát hiện thô Codex + Claude, mở mã xác nhận, xếp Nên sửa / Làm sau / Bỏ qua; còn được gọi ở 4 điểm kẹt (chọn hướng chạm dữ liệu/in/quyền/migration, review chạm 3 vòng, Codex ↔ review-claude mâu thuẫn, 2 giả thuyết chưa ra gốc). Lead vẫn quyết. (18/10, 22/10 · N1044, N1132)
- Thay đổi rất nhỏ được bỏ `/review-claude` nhưng phải báo người dùng; sửa chỉ ở test đã chứng minh bằng đột biến thì không cần vòng 3. (22/10 · N1107, N1170)
- Lead tự quyết sửa phát hiện review; chỉ hỏi người dùng khi đổi quyết định đã chốt hoặc đổi hành vi. Lỗi logic đã xác nhận → viết test đỏ rồi sửa. (17–18/10 · N1001, N1038)
- Năm luật chống sót việc: ô tích từng gạch kèm bằng chứng; rà kế hoạch 3 mốc; phát sinh commit riêng; lệch kế hoạch báo ngay; chia việc cố định. Đánh giá thành viên mỗi đợt, xem lại mỗi 3 đợt. (18/10 · N1046, N1075)
- `kiem-thu` (Sonnet): chạy cả bộ test nền, phân loại LỖI THẬT / TEST LỆCH / CHẬP CHỜN, chạy commit_gate, không sửa mã. Sonnet B/C trong `/review-claude` được giữ (đánh giá đợt 3 ngày 20/10: Tốt). (18–20/10 · N1041, N1081, N1098, N1099)
- Codex CLI: `codex exec --sandbox read-only -C . -o <out.md> - < <prompt.md>`, prompt nêu quyết định đã chốt. (16/10 · N0872)
- Bản giao việc cho agent phải ghi cổng server riêng + `BASE` (cây chính giữ cổng 8000). (16–17/10 · N0890, N1001)
- Người dùng vắng và nói "theo khuyến nghị, xong commit push" → làm theo khuyến nghị rồi commit + push; ghi quyết định vào RULES. (02/10, 08/10, 11/10 · N0085, N0042, N0562)

### Git khi nhiều phiên cùng sửa
- Đọc lại `index.html` trước mỗi lần ghi; commit = HEAD + phần mình (script phát lại neo theo chuỗi), stage bằng `git hash-object -w --path` / `GIT_INDEX_FILE` tạm, KHÔNG `git add index.html` cả tệp; sau commit so `git show HEAD:index.html`; nhắn phiên kia. (10–23/10 · N0032, N0037, N0625, N0714, N0777, N1170)
- Commit bằng `git commit -- <đường dẫn>`, không xâu commit + push trong một lệnh; không `reset --soft` khi phiên khác có thể vừa commit; commit lẫn phần phiên khác mà nội dung đúng thì KHÔNG viết lại lịch sử/force-push. (11–21/10 · N0032, N0858, N1107, N1108)
- Hook: `git commit` chạy `commit_gate.py --cached` (KHÔNG ĐẠT → chặn); chặn Write đè `index.html` và sửa `.env*`; `/commit-push` chỉ người dùng gọi. (18/10 · N1023, N1024)
- Mỗi commit đổi module/Edge/migration phải cập nhật `docs/PROJECT_MAP.md` cùng commit. (17/10 · N0965, N0966)
- `docs/CONTEXT_MAP.md` cập nhật cùng commit khi thêm / bỏ Edge, Extension, agent hay hệ thống ngoài, khi có luồng nghiệp vụ mới đi qua từ 2 module trở lên, hoặc khi đổi cách gói repomix / công cụ tìm khối (luật ghi ở mục 5 của chính tệp đó). (25/10 · N1209)
- Bước 1 "Hiểu và quyết": mã mới đọc phản hồi RPC / Edge / WMS / Inside nào thì lấy một mẫu phản hồi thật (chỉ đọc) của đúng lời gọi đó trước khi viết test — tên khoá, kiểu, định dạng mã; test giả dựng đúng theo mẫu, giá trị thay bằng dữ liệu giả chuẩn; mẫu thật không vào repo. Ghi ở `docs/DOI_AGENT.md` bước 1. (25/10 · N1210)
- Bước 1 "Hiểu và quyết" thêm 6 luật (DOI_AGENT bước 1): đọc CONTEXT_MAP → PROJECT_MAP → mục lục RULES theo module; yêu cầu thiết kế / đánh giá / kiểm tra → giao đúng sản phẩm đó; sửa hàm SQL / Edge đang chạy → so bản trên Supabase với repo trước; màn mới sinh dữ liệu mặc định lưu Supabase; mỗi phương án hỏi kèm hệ quả một câu (+ con số lợi ích khi nhắm giảm dữ liệu / tăng tốc), đổi chốt ghi rõ; tin nhắn thiết kế mở bằng "Giả định đã kiểm" + "Ngoài phạm vi". Không thêm: kiểm phiên song song ở bước 1, trinh sát / tệp kế hoạch bắt buộc. (25/10 · N1212)
- Tài liệu theo `docs/chuan/TAI_LIEU.md`: mỗi chủ đề một nguồn (nơi khác chỉ trỏ), dòng văn xuôi ≤ 400 ký tự, trỏ nhật ký bằng mã ổn định `[N0965]` / `[N<yyyymmdd>-<hhmm>]` thay "dòng N + độ lệch". `AGENTS.md` viết tiếng Việt, giữ bốn luật cứng (DOI_AGENT trỏ về). (25/10 · N20261025-2108)
- Chuẩn hoá tài liệu 5 đợt (`docs/plans/2026-10-25-chuan-hoa-tai-lieu.md`): mục lục quyết định đã vào git (tệp này, 25/10, che email); commit message tiếng Việt không dấu; `commit_gate` chỉ cảnh báo trước, sau 2–3 đợt mới xét chặn. (25/10 · N20261025-2108)
- Đợt 5 (25/10): `commit_gate` thêm cảnh báo 8–11 (tài liệu > 400 ký tự, SQL `SECURITY DEFINER`, mã nhật ký, thông điệp có dấu) — chưa chặn; `scripts/live_status.py` (chỉ đọc) sinh phần máy kiểm được của "Trạng thái lên thật"; `codex_review.py` nạp `docs/chuan` theo loại tệp; `run_tests.py` chạy cả test Python. (25/10 · N20261025-2144)
- Chuẩn kỹ thuật ở `docs/chuan/` (GIAO_DIEN, MA_WEB, DU_LIEU, KIEM_THU_GIT): chỉ gom luật đã có quyết định, mỗi luật ghi "Giữ bởi" (test / commit_gate) + nguồn mã nhật ký; quy ước chỉ thấy trong mã ghi mục "chưa chốt". `AGENTS.md` bảng loại việc trỏ sang đây; CONTEXT_MAP / PROJECT_MAP "Quy ước luôn đúng" và DOI_AGENT "Quy tắc chung" thành dòng trỏ. (25/10 · N20261025-2118)

### Kỹ thuật vá `index.html`
- Ghi bằng Python (hook chặn `cp`/Write); không heredoc cho Python có `\`; không để `\u0000` chưa thoát; giữ đúng kiểu dòng CRLF/LF (kiểm `/(?<!\r)\n/`); tìm bằng `str.find` (regex trên 2 MB có thể treo); script vá luôn `assert` mốc; script đổi CSS chỉ sửa bên trong `{…}`. (16–23/10 · N0003, N0042, N0760, N0771, N1104, N1129, N1148)

### Test và dữ liệu
- Cả bộ: `python scripts/run_tests.py` (chạy nền, thử lại test hỏng 1 lần) + `python scripts/commit_gate.py` trước khi báo; test trình duyệt đọc `BASE`, Playwright qua `PLAYWRIGHT_MODULE`. (10–23/10 · N0068, N0883, N1175)
- Test chập chờn đã biết (không do tính năng): `print_devices_browser`, `sku_catalog_race_browser`, `group_uid_mockup`, `find_sku_mobile`. (12–23/10 · N0591, N0937, N1028, N1166)
- Dữ liệu giả bắt buộc trong test/repo: SKU `9000000xx`, UID `1028260000000xxx`, `100000001`; không đưa SKU/UID thật vào repo. (17/10 · N0920, N1001)

### Công cụ
- Supabase MCP chỉ để ĐỌC (project `ikzhitdqkoatlmkrxuuh`); migration/deploy/ghi qua `scripts/apply_supabase_sql.py` / `deploy_*.py` do người dùng chạy, hoặc khi người dùng cho phép rõ từng lần. Token `print-sku-schema` hẹp quyền (không đọc Log Explorer). (10/10, 17/10 · N0028, N0982, N0983, N1054)
- Dò WMS chỉ bằng GET qua Chrome DevTools MCP; không dùng export "By PO" (tạo job = ghi). (12/10 · N0003, N0004)
- Plugin: `frontend-design` được dùng nhưng chuẩn dự án thắng; không cài wiki (reef), code-review Anthropic, playwright; sơ đồ bằng Mermaid. (17/10 · N0965, N0981, N1000)

## 2. Giao diện chung

### Nguyên tắc
- Icon-first (Lucide) + nhãn ngắn; KHÔNG câu hướng dẫn kiểu AI (giữ thông báo trạng thái/lỗi/xác nhận); kết quả đo (%, số) chữ to; placeholder chỉ là danh từ. (02/10, 10/10, 11/10 · N0081, N0029, N0499)
- Module mới ưu tiên pop-up: ô số liệu mở `.as-dialog`, bấm dòng mở chi tiết. (08/10, 15/10 · N0042, N0006)
- Admin (`#admin/*`) chỉ đánh giá/sửa trên web desktop; mọi màn nghiệp vụ khác phải dùng được trên điện thoại (≥ 375 px). (08/10 · N0052, N0106–N0130)
- Không có màn đăng nhập trước màn thao tác; header luôn thấy tên module; nút Back luôn ở đầu header, về `#home`. ([?], 02/10 · N0106–N0130, N0083)
- Bundle React (IN TEM SKU, Cấu hình Admin) không có source: chỉ chỉnh bằng CSS đè + cổng nhỏ (`PrintSkuScanner`, `PrintSkuWorker`); màn JS thuần được sửa markup tự do. (26/09, 15/10 · N0380, N0087, N0789)

### Token, chữ, màu, tương phản
- Màu thương hiệu `--wms-brand` #005F41; trạng thái `--wms-success` #0f6e49 / `--wms-warning` #8a5a00 / `--wms-danger` #b42318; token chữ/viền/focus `--wms-text-2`, `--wms-on-brand`, `--wms-control-border`, `--wms-border-accent`, `--wms-focus-ring`; `tests/design_tokens_ratchet.cjs` chặn tăng mã cứng. (23/10 · N1163, N1168)
- Một font hệ thống `--wms-font` (thay Arial); cỡ 12·13·14·16·18·22·28, đậm 400·600·700; chữ hoa chỉ ở tiêu đề nhóm trang chủ, `.ins-row--head`, `.loc-code`; khối `#type-standard` chỉ `@media screen`. Tem in vẫn Arial. (10/10 · N0460, N0463)
- Giao diện sáng; `:root{color-scheme:dark}` cũ còn nên hộp thoại ép `color-scheme: light` (`:is(dialog, #admin-auth, #cut-barcode-modal)`). (26/09, 15/10 · N0379, N0796)
- Tương phản chữ ≥ 4,5:1 (chữ lớn ≥ 3), icon ≥ 3:1; không dùng opacity làm mờ ô/dòng (trừ ô tick tắt .4); kiểm bằng `tests/a11y_axe_browser.cjs`. (11–23/10 · N0522, N1163, N1172)

### Kích thước, vùng chạm, icon
- `#ui-standard` (`--ui-*`): thẻ bo 22/14, ô nhập + nút chính cao 52/48, nút icon cạnh ô 52/48 (trong ô 44), điều khiển gọn 44 chữ 14/600; mọi vùng bấm ≥ 44 (`--target-min`, `::after` khi cần); chữ ≥ 12 px; ô nhập 16 px trên điện thoại. (11/10–23/10 · N0514, N0806, N1137, N1172, N0085)
- Icon chỉ cỡ 16/20/24/32 (`#icon-standard`); nút −/+ và `.act-icon` dùng mask `::before` (không thay bằng SVG); chức năng lặp lại ở nhiều màn phải cùng icon. (26/09, 11/10 · N0398, N0499, N0710)
- Ô tick một kiểu (`#tick-standard`): vuông 22 px (≤ 800 px: 24), tick #005F41, viền #6f8f83; ô tick không bọc label có vùng chạm 44 bằng `::after`. (22–23/10 · N1126, N1172)

### Trang chủ, điều hướng, thanh trên
- Trang chủ `#barcode-home`: 4 nhóm có ảnh nền (`#group-banners`), không câu mô tả; máy tính 2 cột; ≤ 620 px 3 cột, ô lẻ cuối thành thẻ ngang; ô QUẢN TRỊ ở nhóm cuối. (07/10, 11/10, 15/10 · N0074, N0475, N0534, N0540, N0562, N0774)
- Thanh trái chung ≥ 1024 px (`#app-nav-theme`): thu gọn = ẩn hẳn, nút thu gọn ở thanh trên, bấm khoảng trống thu thanh; ở `#admin/*` chỉ ← Trang chủ + 5 mục Quản trị + Đăng xuất; điện thoại giữ menu ☰. (11–12/10 · N0549, N0556, N0559, N0586)
- Thanh trên: `.uid-topbar` (≤ 760 px Back chỉ icon 44); máy tính cao 80, chữ 12/18; Header B Admin bỏ KPI + mốc giờ; hero thành thanh lệnh gọn. (07/10, 11–12/10, 17/10 · N0075, N0564, N0597, N1003)
- Nút đọc nguồn: "Đọc WMS" ("Đọc Inside" ở Đồng bộ SKU), phạm vi lớn "Toàn bộ", lớp `.src-read`, gộp vào dải mốc giờ (`#strip-read`); nút ghi "Cập nhật" + huy hiệu `data-count`; vạch load 3 px dưới nút đang chạy. (17–18/10 · N1003, N1007, N1018)
- Nút chỉ icon: `#uh-full`, Phiếu IT `.skit-open` (tròn 40); "Chọn" thẻ TÌM SKU điện thoại là nút tròn 44 px, nền xanh nhạt + tick 18 px; chú thích tĩnh dưới thẻ số liệu → `title`, nhưng giữ chú thích ở dải mốc giờ. (18/10, 22/10, 24/10 · N1006, N1010, N1125, N1202)

### Hộp thoại, tấm, bảng, xuất
- Xác nhận dùng `WhDialog` (không `confirm()`): tiêu đề ngắn + `facts` + tối đa 5 mã rồi "+n", không câu "Bấm OK…"; warning/danger con trỏ ở Huỷ. (08/10 · N0429)
- Tấm `.uid-sheet` ≥ 801 px hiện giữa màn (`#sheet-center`), điện thoại trượt từ đáy. (16/10 · N0820)
- Bảng thành thẻ trên điện thoại (`#wms-table-labels`); 801–1199 px dùng nhãn tab ngắn `.tab-s` (`#mid-width`). (02/10, 16/10 · N0083, N0828)
- Xuất bảng = Excel `.xlsx` (`AdminSyncUI.xlsxBlob` / `PrintSkuZip.buildZip`, không thư viện, ô chữ `inlineStr` giữ mã 16 số); nút Xuất là icon Download 44 có aria-label. (26/09, 12/10 · N0370, N0016)

- Báo lỗi / Thử lại / khung chờ / trạng thái rỗng dùng chung `window.PrintSkuNotice` (`notice-standard`, Đợt 6): chữ kỹ thuật tự đổi thành lời dễ hiểu khi phần tử có `data-tone="error"`; câu lỗi dạng "<phần không tải được>: <nguyên nhân>"; Thử lại CHỈ cho lần tải/đọc (không cho quét/ghi); vạch chờ sau 350 ms; thẻ `.ss-metric` chỉ tô màu khi có số (`data-zero`). (23–24/10 · N1187, N1194 · ĐÃ LÊN ff17171)

### Quét, bàn phím, camera
- Khung quét chuẩn `.scan-field` cho mọi ô quét (trừ TÌM SKU): bàn phím ảo ẩn mặc định, nút bàn phím trong khay nhớ theo máy; các ô sau `#f-sku` theo `__kbH`. (03/10, 14/10, 18/10 · N0078, N0650, N1013)
- Máy quét Honeywell phải đặt Wedge Method = Keyboard; không dùng `readonly`/`virtualkeyboardpolicy="manual"` (máy quét gõ qua IME); giữ focus ô quét chỉ ở tab quét; không tự submit (Enter/nút mới lưu). (19/09, 25–26/09, 05/10 · N0190, N0329, N0331, N0076)
- Âm báo quét chung `PrintSkuScanCue.play(tone)` (ok/warn/error/blocked/qc/store); tắt âm vẫn rung. (23/10 · N1168)
- Lớp camera chung `PrintSkuScanUI` (`open`; `openGroupUid` chỉ nhận UID 16 số), vòng đời `#wms-camera-lifecycle`, lỗi có Thử lại trong cùng lớp; ZXing trong bundle đã vá Code128. (01/10, 07/10, 11/10 · N0412, N0417, N0063, N0507)

### Màn cụ thể
- TÌM SKU: % to, chi tiết trong `#fsk-more`, camera toàn màn (Back qua `pushState`), ô tìm trước camera; mobile giữ thanh ba bước dưới header khi cuộn; lúc AI đọc ảnh hiện lớp phủ chibi toàn màn (`assets/ai-thinking-chibi-simple.png`), không dòng trạng thái nhìn thấy, bỏ vạch quét trên preview; đóng theo request thật, tôn trọng giảm chuyển động. (30/09, 10/10, 24–25/10 · N0406, N0408, N0029, N1202, N1204, N1205)
- CHUYỂN ĐỔI ĐƠN VỊ: `#uc-thread-core` cạnh `#uc-thread-cones`, quy cách cuộn trong `dialog.uc-sheet`, Tex ra màn chính. (10/10, 21/10 · N0023, N0028, N1049)
- Không đặt `min-height:100vh` cho `.cut-screen` (Chrome Android cắt thanh đáy). (10/10 · N0030)
- Email người cập nhật: người chưa đăng nhập Admin thấy phần trước @, Admin thấy đầy đủ (Lịch sử Group UID, Đối chiếu ADJ, UID tạm; web gửi `PrintSkuAdminAccess.viewerToken()`). Thay chốt 10/10 "hiện đầy đủ". `sku_count_overview.lastApprovedBy` giữ nguyên (chốt 12/10). (23/10 · N1185)

## 3. In tem, hàng đợi in, agent máy trạm

### Quyền in và kích hoạt máy
- Hướng C: mỗi máy kích hoạt bằng mã 30 phút → khoá riêng `pd_…`; `print_enqueue` kiểm khoá rồi gọi `print_enqueue_unchecked`; khoá chung `legacy-public` và `print-web-main` đã tắt → máy chưa kích hoạt bị ACCESS_DENIED. (10/10, 12/10, 17/10 · N0037, N0031, N0992)
- Mã kích hoạt hiện cho mọi Admin (`code_plain`); > 30 lần sai/phút → RATE_LIMITED; Thiết bị in là tab trong Lệnh in (`#pdm-panel`; `#admin/thiet-bi` chuyển hướng). (10–12/10 · N0037, N0031, N0036)

### Hàng đợi và Lệnh in
- `print_jobs` KHÔNG phải lịch sử: cron `print_jobs_purge()` 03:00 VN xoá lệnh xong > 3 ngày (tìm lại được 3–6 ngày); số đo tốc độ in ghi RULES ngay khi đo. (03/10, 08/10 · N0072, N0421, N0425)
- Lệnh in Admin (`#admin/lenh-in`): in lại SKU y hệt lệnh gốc, UID chọn toàn bộ/một phần; payload in lại do máy chủ dựng (`print_admin_reprint`). (08/10, 11/10 · N0421, N0424, N0036)
- Nút In: idle/working/failed/disabled, vạch load tới khi lệnh XONG (`PrintSkuQueue.jobStatus`), lỗi → "Thử lại" dùng lại nonce. (03/10 · N0079)
- Mọi lệnh qua `PrintSkuQueue.enqueue` và lệnh In lại Admin dùng lớp phủ chibi chung trong lúc máy chủ nhận lệnh; tick chỉ nghĩa là đã vào hàng đợi, hiện 700 ms rồi đóng; lỗi đóng ngay để màn gốc báo lỗi. Không áp cho `window.print()` dự phòng vì không biết kết quả hộp in của trình duyệt. (25/10 · N1206)
- Trạng thái máy in: hỏi `print_queue_status` 15 s (không hỏi khi tab ẩn), ngưỡng 45 s theo `last_seen_at`, chữ "Mất kết nối máy in". (08/10, 14/10 · N0047, N0710)
- Giới hạn: 100 SKU/lệnh (In tem SKU, Phiếu IT, Trợ lý in), 500 tem/lệnh; `group_uid` ≤ 100 UID/lệnh, tự chia. (19/10, [?] · N1106, N0216)

### Tem SKU
- Tên in: SKU có trong database → luôn tên database (`print_name_from_db_v1`, trả `renamed`); không có → tên web gửi (người dùng tự gõ vẫn in được); ô tên đặt lại mỗi khi SKU đổi, `tem-sotay` chỉ gợi ý, không vào tem. (23/09, 18/10 · N0200, N0202, N1034, N1105)
- Mẫu gộp v3 (`sku:v3`, agent 0.10.2): tem không PO giống hệt v1; có PO/ngày nhận vẽ khung + số lượng nếu có; chỉ lệnh cần khả năng mới đi v3, còn lại v1/v2. (23/10 · N1158, N1160)
- In lại tem có PO: quét SKU ở IN TEM SKU → `sku_po_lookup` (≤ 20 PO, bảng `sku_po_receipts` ghi bằng trigger trên `print_jobs` sku v2); nhiều PO → pop-up chọn (1 PO chọn sẵn), ngày nhận = lần in gần nhất; cùng SKU khác PO trong danh sách → chặn; quyền = máy đã kích hoạt. (23/10 · N1154, N1159, N1160)
- Tem Phụ liệu (KIỂM TRA ĐẦU VÀO `#ins-tem`): SKU Normal, 1 tem/SKU, khung PO + ngày nhận (= Rcvd date), ô số lượng từng dòng (trống thì không in); gửi lại cùng nonce. (22–23/10 · N0734, N1158)
- Danh sách IN TEM SKU: chọn chỉ để xoá nhiều, In tem in cả danh sách; Phiếu IT chỉ Admin, số lượng đúng theo phiếu (`qtyText` giữ thô), số bản mặc định 1. (11/10, 15/10 · N0569, N0789, N0852)

### Tem Group UID
- Agent 0.10.0: bỏ LOT/ROLL ở đáy (`fitLotRoll`), thay khối Số lô / Số cuộn / RFID + ô SỐ PO | NGÀY NHẬN (`fitTextBlock`); PO tự lấy từ Gán WMS, luồng khác nhập tay, không bắt buộc. (21/10 · N1110, N1114, N1115)
- PO/RFID chỉ cắt hai đầu, mẫu `0-9A-Za-z._/ -` ≤ 20; ngày năm 2000–2099; khoá ô khi gửi, nonce theo nội dung, xoá ô sau khi gửi; Lot/Roll > 20 ký tự cảnh báo `lotRollTooLong`. (21/10 · N1111, N1113)
- CẮT GROUP UID dùng cùng luồng tem: ô Số PO + Ngày nhận ở tab 3 (`PrintSkuQueue.poDate`), PO nhập tay. (21/10 · N1116)
- `PrintSkuQueue.labelRoll(lot, roll)` chỉ cắt Roll khi bắt đầu bằng Lot + dấu ngăn cách (chỉ đổi chữ in). (08/10 · N0053)
- Tay kéo ⋮⋮ đổi thứ tự chỉ có ở IN TEM GROUP UID. (12/10 · N0582)

### Tem vị trí
- MÃ VỊ TRÍ: không còn bảng vị trí (`warehouse_location_v3_no_table`); hàng đợi localStorage `location-queue-v1` ≤ 500, tự chia ≤ 100 vị trí / ≤ 500 tem; nhập Excel template WMS; tem QR 40 × 60 mm; không có xem trước. (02–03/10 · N0070, N0072, N0087)

### Agent máy trạm
- Mã nguồn `workstation-agent/`, cài `C:\PrintSKUAgent` bằng `install-agent.ps1` (giữ `config\.env`), không đụng `C:\AuditFactory`; mẫu tem giữ Arial. ([?], 11/10 · N0170, N0495, N0463)
- Phát hành mẫu tem mới: cài agent trên may-kho-01 TRƯỚC khi push web (agent cũ bỏ im lặng trường mới), in thử thật trước khi push. (21/10, 23/10 · N1111, N1158)
- Lệnh cần `sku:v3` không chặn lúc gửi; agent mất kết nối thì lệnh chờ như mọi lệnh. (23/10 · N1162)

- Admin huỷ lệnh in đang chờ (`queued`) bằng nút "Huỷ lệnh" ở popup Lệnh in (RPC `print_job_cancel`, `backend_hygiene_v1`); lệnh Group UID trả UID về failed; không tự huỷ theo giờ. Lệnh hết lease sau khi đã gửi byte (sending/spooling, hoặc từng gửi theo `print_events`) giữ `agent_id` — chỉ agent đó nhận lại; queued còn `agent_id` > 30 phút → failed SENT_UNCONFIRMED (cron ngày). (23/10 · N1185, N1186)
## 4. SKU & danh mục

### Đồng bộ từ Inside
- Nguồn `SKU_Name` = Inside qua Extension + Edge `sku-sync`: gia tăng theo Modified và "Đối chiếu toàn bộ" (`mode=full`, cần `snapshot.full`); giảm ≥ 20% → 409 SAFETY_LIMIT; nhóm `missing` chỉ báo. (14/10 · N0657)
- Đối chiếu toàn bộ mỗi ngày, không lọc Active ở nguồn; `#ss-strip-full` cảnh báo > 36 giờ. (14/10 · N0667)
- Bỏ qua SKU MỚI đang ngừng (`skippedInactive`) ở mọi chế độ; SKU đã có chuyển ngừng vẫn cập nhật. (14/10 · N0665)
- SKU rời 7 nhóm đồng bộ → tự lưu trữ `sku_archive` (`left_sync_scope`, RPC `sku_archive_missing`, chạy sau lượt completed, tự động held khi > 20 mã); chấp nhận race hiếm với đồng bộ Group UID. (17/10 · N0942, N0945)
- Combo đọc gia tăng theo Modified (`comboScope=changed`); định dạng/thứ tự sai → tự đọc toàn bộ Combo; deploy Edge trước Extension, không handshake. (16/10 · N0863, N0874)
- Script cũ (`refresh_skus.py`, `sync_sku_to_supabase.py`) chỉ chạy khi được yêu cầu; không ghi rỗng đè, tên lấy từ thẻ `<a>`, cầu dao đổi tên > max(25, 20%). (18/09 · N0233, N0247, N0273–N0276)

### SKU ngừng và lưu trữ
- `sku_inactive_v1`: cột `inactive_since`; anon chỉ thấy `status='1'`; `print_enqueue_unchecked` chặn `SKU_INACTIVE` (tem UID/vị trí không chặn); `sku_inactive_archive` 180 ngày, cron thứ Hai 03:45; giữ SKU ngừng còn được combo Active tham chiếu. (11/10, 14/10 · N0034, N0718)
- Cắt UID với SKU ngừng: thẻ `#cut-last` báo "SKU đã ngừng hoạt động". (11/10 · N0034)

### Combo → Normal
- Mọi luồng đưa SKU vào in/tra (IN TEM SKU, Group UID, TÌM SKU, Cắt UID, Lịch sử UID) gặp Combo phải hỏi Normal qua `SkuComboPicker.chooseNormal`; chọn chỉ đổi mã + tên; `sku_combo_links` không mở trực tiếp cho client. (30/09, 06/10, 12/10 · N0405, N0067, N0014)
- `sku_combo_lookup` vẫn trả Combo có thành phần Inactive (hiện ACTIVE/INACTIVE). (11/10 · N0034)
- TÌM SKU luôn gợi ý Normal (`toNormals()`); thẻ đỏ khi `comboPct ≥ 70` và `!(normalPct ≥ 50)`; không sửa NDS_ENGINE. (10/10 · N0020)
- Combo vải kg → Normal g hệ số 1000; Combo nhiều thành phần không tự gán. (14/10 · N0757)

### Danh mục trên máy
- Supabase luôn đúng; IndexedDB (`print-sku-cache`, `print-sku-find-sku`) chỉ để hiện nhanh, không ghi ngược; vào màn hỏi phiên bản một lần, tải toàn bộ mỗi 12 giờ; mất mạng báo "Bản lưu trên máy lúc …". (18/10 · N1033, N1035)
- `window.PrintSkuCatalog` dùng chung Tìm SKU / In tem SKU / ô quét / Chuyển đổi đơn vị / Gán tự động; ghi IndexedDB đọc–so–ghi một giao dịch; vá tên khi in chỉ trong RAM; dựa `updated_at` do sku-sync đóng dấu. (18–19/10 · N1085, N1105)

### Chuyển đổi đơn vị
- Chỉ: trừ lõi `số cuộn × gram lõi`; cân cuộn nguyên thắng Tex, lệch > 5% = NG. Vải: không trừ lõi, g/m = gsm × khổ_cm/100; `mm/gr = 1000 ÷ g/m`. (08/10 · N0057)
- Quy cách cuộn lấy từ Combo (`sku_combo_by_normal`, chỉ 1 thành phần, 500–100.000 m); không quy cách nhưng có Tex → không cờ impossible/nearly_full, ẩn "Tương đương cuộn nguyên". (10/10, 21/10 · N0028, N1049)

### Index
- `SKU_Name` có GIN `sku_name_ten_trgm` và đúng 1 unique trên `sku` (`ON CONFLICT(sku)` hợp lệ). (08/10 · N0047)

- Lưu trữ SKU (rời nhóm / ngừng lâu) giữ SKU còn UID Available/New/Processing/**Blocked** hoặc là SKU thành phần (`group_uid_products`) của UID còn sống. Trạng thái SKU Inside lạ/rỗng → lượt đồng bộ lỗi (Extension 0.10.8, cố ý). (23/10 · N1185)
## 5. Group UID

### Đồng bộ WMS
- Đồng bộ qua Extension + Edge `group-uid-sync`: gia tăng từ `last_successful_incremental_at − 30 phút`, Toàn bộ để đối chiếu; staging theo `run_id`, luôn xem trước rồi mới ghi; không tự xoá UID `missing`. (08/10 · N0059)
- Preview chỉ báo 'updated' khi trường nghiệp vụ đổi; apply chỉ ghi dòng khác (`gu_touch`, v6/v7 join details + `for update`). (10/10, 16/10 · N0039, N0867, N0873)
- Đọc WMS hết vào bộ nhớ rồi mới ingest (`readWmsSnapshot`): gộp theo mã giữ bản mới hơn (`newerRecord`), đối chiếu theo id bản ghi (một mã có thể 2 bản ghi), tổng lệch → đọc lại đầu danh sách (≤ 5 vòng); chốt "dừng để tránh thiếu dữ liệu" ở Edge/DB giữ nguyên. (16/10, 22/10 · N0004, N0740, N0746)
- WMS bỏ qua `to_updated_at` khi thiếu `from_updated_at`; không lọc `company-ids`/ngày tạo/người tạo (lọc ở trình duyệt). (14/10, 16/10 · N0004, N0700)
- `#gu-strip-full` cảnh báo khi "Đối chiếu toàn bộ" quá 24 giờ (gia tăng không thấy đổi qty). (12/10 · N0604)
- Trường đồng bộ thêm: `qc_status` (chỉ chuỗi trạng thái, không người/giờ), `group_rfid_mapping`, PO (chỉ nguồn PURCHASE_ORDER). (16/10, 20–21/10 · N0908, N1071, N1117)
- Lượt Toàn bộ đầu sau khi thêm trường (vd. PO) bị held nếu tự động; chạy tay thì không held. (21/10 · N1118)
- Dọn UID Canceled > 180 ngày: `group_uid_canceled_purge` cron thứ Hai 03:15 VN; preview/apply bỏ qua dòng Canceled quá hạn. (16/10 · N0841)

### RFID
- 1 RFID = 1 UID, mã tem 1 chữ + 11 số; nguồn thiếu khoá/null/rỗng → xoá, sai dạng/Extension cũ → giữ; web hỏi `group_uid_by_rfid`, chỉ nhận đúng 1 UID (ưu tiên không Canceled), trùng → cảnh báo; quét RFID chỉ ở LỰA UID BLOCKED. (20/10 · N1071–N1073)

### Tra cứu và IN TEM GROUP UID
- `group_uid_lookup` ≤ 100 mã, chỉ trả trường phục vụ tem, tên chỉ từ `SKU_Name` (không bịa); mỗi UID 1 tem; lỗi mạng báo "không tra được". (22/09 · N0151–N0157)
- Ba tab gán: theo tick (Lot/Roll ≤ 20, bỏ trống được), Gán tự động (nguyên bản cũ), Gán WMS (Packing List PO, `#uid-tab-po`, ẩn ≤ 800 px). ([?], 15/10 · N0210–N0215, N0769)
- Gán WMS: mỗi dòng Approved = 1 cuộn (kể cả qty = 1), chỉ đếm cuộn chưa có `group_uid_code` (WMS bỏ khoá = chưa có UID); xoá được cả dòng cuối. (14–21/10 · N0758, N0748, N0752, N0772)
- Lấy từ WMS (UID New kho 1177/1339) chỉ Admin (cổng giao diện); lọc "Đợt tạo" = phút tạo + người tạo. (14/10 · N0700, N0705, N0706)

### Lịch sử Group UID
- `#uidhist-screen`: ai cũng xem; "Đọc WMS" chỉ Admin (gia tăng `range_to − 30 phút`, lần đầu 365 ngày), một luồng mọi công ty (`p_company_id=0`); `F0-VR-00-00-00-00` = "Trả NCC"; kết quả trong `#uh-dialog`. (10/10 · N0438, N0439, N0441, N0467)
- Popup thay đổi Đồng bộ: bấm mã UID mở `#gu-uid-dialog` (có dòng "Trước:"). (14/10 · N0008)

### Phần còn giữ
- Màn nạp Excel trên web đã xoá; backend `group_uid_v4/v5`, RPC `group_uid_import_*` và script CLI trong git vẫn giữ. (07/10, 18/10 · N0061, N0162, N1021)

## 6. Xưởng

### Cắt Group UID
- `cut_group_uids` khoá `group_uid_code`, chụp SKU/Lot/Roll/Tên lúc cắt; UID không tồn tại hoặc thiếu SKU/tên → chặn; đã cắt → chặn; in lại được trừ dòng `queued`. (23/09, 26/09 · N0319, N0336)
- Xoá chỉ Admin (`cut_group_uid_admin_delete`, chép `cut_group_uid_deletions`, chặn cả lô nếu có `queued`); đường xoá anon khoá hẳn. (25/09, 08/10 · N0340, N0050)
- 4 tab Quét / Tra cứu / Tem chờ in / Đối chiếu; "Tem chờ in" là giỏ trên trình duyệt (`stagedItems`); tab 1 công tắc **Cắt tự do | Theo PO** dùng chung `#cut-code`; Quản lý phiên = hộp thoại Admin; UID ngoài phiên báo đỏ. (26/09, 16/10 · N0331, N0332, N0003)
- Lấy mẫu Theo PO: nhóm SKU Normal + Lot; mỗi lot cắt + QC ≥ ceil(30%), mỗi bên ≥ 1 khi lot ≥ 2 cây; cắt:QC = 20:10; cắt cây nhỏ nhất, QC cây lớn nhất; lot 1 cây = 1 cây cắt, không báo thiếu QC; máy chủ ép `SAMPLE_BELOW_MIN`. (16/10, 21/10 · N0003, N1060)
- Phiên lấy mẫu lưu Supabase (tạo/xoá = Admin, quét = công khai qua hàm); app không ghi WMS; UID đẩy sang Cắt UID không tự vào "Tem chờ in". (16/10 · N0003)
- Số lượng cắt: đơn vị = trường cuối tên SKU; `g` → GSM × khổ (m), `mm` → 1000 (mỗi UID 1 m); dòng tổng chỉ hiện khi lọc theo SKU. (28/09 · N0093, N0095)
- Tra cứu: chứa SKU ≤ 5.000 dòng; lọc ngày cắt (không tự điền); lọc PO khớp đúng (tab 2 + 4); Excel: SKU/UID/Lot/Roll/Tên + cột PO. (23/09, 30/09, 21/10 · N0327, N0407, N0091, N1117)
- Bấm UID mở popup barcode (`encodeCode128` chép nguyên từ agent) có tick "Đã xuất ADJ". (28/09, 02/10 · N0099, N0342)

### Xả vải
- `#xa-vai` (`xa_vai_log`): mỗi UID xả 1 lần; toàn hệ thống chỉ 1 UID đang xả (advisory lock); quét = bắt đầu ngay; "Đã xả xong" lọc theo `ended_at` khoảng ngày (mặc định hôm nay); tự làm mới 15 s. (26/09 · N0350, N0355, N0357, N0367, N0400)

### TÌM GROUP UID: Cấp vải + UID blocked
- Một ô trang chủ, công tắc Cấp vải | UID blocked (độc lập, nhớ phần dùng gần nhất); 2 ô cũ hidden, đường dẫn cũ giữ. (21/10 · N1057)
- Cấp vải: ghép UID `Available` theo SKU + Lot + Roll của Packing List (không đoán khi nhiều UID khớp); nhập/xoá/đóng đợt = Admin, quét + xem = mọi người; mỗi file = 1 đợt. (12/10 · N0010, N0011)
- Cấp vải chặn cấp trùng giữa các đợt (`ISSUED_ELSEWHERE`); nhiều máy quét (mã "Máy XXXX", chấp nhận trễ ≤ 20 s); popup kết quả không modal để giữ con trỏ máy quét. (12/10 · N0010, N0011)
- Trả NCC (`#tra-ncc`, phần 3 TÌM GROUP UID): bố cục như UID blocked (dải tiến độ · tab Còn thiếu thẻ vị trí | Đã quét bảng | Danh sách); danh sách tạm Navy/Black do Admin nạp Excel, máy đã kích hoạt quét đánh dấu; kết quả quét = pop-up không modal như Cấp vải (Đúng tự đóng 1,6 s). v2: bảng chia theo vị trí HIỆN TẠI (nguồn mới hơn giữa Đối chiếu và `group_uid_details`, thiếu thì Excel) → `F0-VR-00-00-00-00` (đích) → "Đã rời kho" (status Canceled/Closed/Transferred hoặc WMS không còn vị trí; không tính Về F0-VR); hai mốc riêng Đã quét + Về F0-VR; nút Đối chiếu = Admin đọc WMS trực tiếp qua Extension ≥ 0.10.6 bằng `GroupUidSnapshotCore` (bản chép nguyên văn trong index.html), lệch → báo đỏ không lưu. Danh sách tạm — người dùng báo thì dọn. (24/10 · N1198, N1200, N1201)
- UID blocked: nguồn = dữ liệu đồng bộ WMS 2 kho (`uid_block_import_wms`); lượt quét lưu `uid_block_scans` chung nhiều máy, quét trùng báo "ĐÃ SCAN"; tự cập nhật 30 phút; hết Blocked giữ 7 ngày; mất mạng → hàng chờ localStorage, đồng bộ 20 s. (20–21/10 · N1051, N1062, N1067)

### Khoá máy nhóm ghi
- `floor_access_v1`: cắt / lấy mẫu / cấp vải / xả vải / quét UID blocked chỉ máy đã kích hoạt (`print_device_by_token`, không nhận khoá chung), đọc vẫn mở; bắt buộc ngay, fail-closed. (17/10 · N0992, N0993)

## 7. Kiểm tra

### Kiểm kê SKU
- `#inventory-audit` (ô trang chủ; `#admin/kiem-ke` chuyển hướng bằng script đầu `<head>`): ai cũng xem bản chụp Supabase (`sku_count_*`, giữ 3 lượt), chỉ Admin đồng bộ. (12/10 · N0013, N0454)
- Tồn từ `stock-locations/bins/count/v3` (In-BIN > 0), kiểm kê chỉ `APPROVED`; 2 pháp nhân MTG / GARMENT, thiếu kho → cảnh báo một phần; nhóm Chưa kiểm / Trong 30 ngày / Quá 30 ngày. (10/10 · N0447–N0456)

### Hàng chưa lên kệ và UID tạm
- `#storage-risk-screen` = "Hàng chưa lên kệ": vị trí `F0-<vùng>-00-00-00-\d+`, mốc theo Modified date, mốc 7/30 ngày, dữ liệu `sku_count_overview`. (12/10 · N0012)
- Tab UID tạm: lọc reason ở app, nút `#srt-run` (không dùng `#sr-run`); kết quả lưu `uid_temp_*` (giữ 10 lượt), ai cũng xem, Admin đọc WMS. (16/10, 18/10 · N0901, N1025)

### Kiểm tra đầu vào
- `#inspection` (chỉ phụ liệu): SL kiểm theo AQL 0.4, xuất theo template nhúng (chỉ ghi giá trị ô); hiện SKU Normal, số lượng + đơn vị GIỮ theo PO; NCC = pháp nhân trên PO; Rcvd date = LastModified của PO. (06/10, 10/10, 17/10 · N0176, N0177, N0178, N0969, N0970)

### Đối chiếu ADJ
- ADJ = dòng `Action=Cut` của Group UID History, chỉ ghép Cut có giờ ≥ giờ quét app; chuẩn số lượng `computeCutQty`; có trạng thái Đã xử lý (tick cho UID lệch); "Tick giúp" chỉ dòng Quên tick; xem = anon, nạp = Admin. (05/10, 10/10 · N0344, N0345, N0346, N0021)
- Đọc từ WMS phân trang 500 tới hết (trang lặp → lỗi); `#cut-adj-upd` hiện giờ cập nhật + nguồn; nhóm `qc` "Cắt mẫu QC" (cắt > 1 lần + QC Passed/Failed) không tính là lỗi. (08/10, 16/10, 22/10 · N0043, N0915, N1151)

### Kiểm soát công trình
- `#site-control`: chỉ Admin bấm Đối chiếu; kết quả chỉ trong trình duyệt (không Supabase); đối chiếu tồn app xây dựng với kho WMS 1151, phạm vi = SKU của app; kỳ tính từ 02/07/2026. (15/10 · N0006)

## 8. Extension & đồng bộ tự động
- Thứ tự lên: migration → deploy Edge → Reload Extension (+ tải lại tab Inside/WMS); Extension cũ phải tương thích hoặc bị màn Admin chặn (vd. < 0.10.4). (17/10, 21/10 · N0919, N1001, N1117)
- Token WMS/Inside không rời tab; Extension giữ phiên Admin Supabase riêng (Options, `chrome.storage.local`, tự gia hạn), không có service_role; trang web giữ token trong `sessionStorage`. (17/10 · N0923; [?] N0134–N0144)
- `PrintSkuBridgeReady` PING ≤ 1,8 s trước mọi helper `extensionRequest`; Reload mà chưa F5 → báo tải lại trang; `tests/bridge_ready.cjs` đếm số helper (8 tính tới 15/10). (10/10, 15/10 · N0179, N0789)
- Tự động: gia tăng 30 phút, toàn bộ 1 lần/ngày trong khung 07:30–11:00 (`sync_auto_settings`); vượt ngưỡng "Vừa" → `held` (Admin chạy tay); lease 15 phút + cooldown. (17/10 · N0923–N0939, N0985)
- Thêm Đối chiếu ADJ và Rủi ro lưu trữ tự động mỗi 2 giờ 07:00–19:30 VN (`sync_auto_v2`, giãn cách = nhịp − 10 phút). (22/10 · N1140)
- Cảnh báo khi tự động ngừng > 70 phút (dấu "!" icon, thẻ đỏ Options, ô Tự động đỏ, mốc giờ đỏ); ngừng buổi tối = máy tắt sau giờ làm, không phải lỗi. (22–23/10 · N1140, N1178)
- Lượt Rủi ro lưu trữ chỉ "bỏ qua" khi mọi bước lỗi là phiên/thiếu tab và chưa lưu gì; nút Cập nhật cho lượt held luôn "chạy lại"; "Failed to fetch" → báo WMS ngắt kết nối, tải lại tab WMS. (16–22/10 · N1146, N0942, N0944, N0905)
- Extension hiện hành 0.10.8 (Đợt B, người dùng Reload 24/10); từ 0.10.7: ghim tab cả lượt, timeout edge/rpc 60 s. (22–24/10 · N1133, N1149, N1196)

## 9. Supabase, quyền, bảo mật, migration
- RLS bật mọi bảng; client chỉ qua RPC SECURITY DEFINER / Edge service_role; anon chỉ SELECT `SKU_Name` (`status='1'`); 37 bảng không policy và 35 hàm anon là CỐ Ý; Edge `verify_jwt false` đúng thiết kế. (08/10, 17/10 · N0047, N0983, N0984)
- Hàm Admin chỉ `authenticated` + kiểm `group_uid_admin_allowed()` / `print_admin_allowed()` / `user_roles`; tắt đăng ký tự do (thêm Admin qua Dashboard + `user_roles`); secret không vào `index.html`. ([?], 17/10 · N0134–N0144, N0989, N0999)
- Phiên Admin web gia hạn khi 401 HOẶC 403 và khi JWT còn < 1 phút; lỗi mạng giữ phiên. (16/10 · N0895)
- Migration: `scripts/apply_supabase_sql.py` (DROP/DELETE cấp cao nhất cần `--allow-destructive`); UPDATE dữ liệu đặt trong migration; đổi chữ ký hàm phải `drop` bản cũ (PostgREST không chọn overload); sau migration lead kiểm chỉ đọc rồi mới báo lên thật. (10–18/10 · N0034, N0036, N0993, N1030)
- Push `main` = deploy web: web cần hàm/Edge mới → commit chưa push → migration/deploy → push. (17/10 · N1001)
- Timeout phía client không chứng minh server chưa ghi: báo "chưa rõ" rồi tải lại. (19/09 · N0198)
- Dọn lịch sử: `sync_history_purge` 03:30 VN (changes 30 ngày, runs 180, held coi như completed), không đụng dữ liệu nghiệp vụ. (10/10, 17/10 · N0040, N0934)
- Bỏ module vẫn giữ ở server: CHECK `print_jobs.type`, nhánh `fabric_relaxation`, migration cũ. (11/10 · N0035)
- Màn / tab mới sinh dữ liệu (quét, đọc WMS, nạp tệp): mặc định lưu Supabase, ghi = máy đã kích hoạt hoặc Admin, xem = mọi người; chỉ hỏi người dùng khi muốn khác. (25/10 · N1212)

## 10. Trợ lý in & AI
- Trợ lý in: chỉ Admin, cần tab WMS; mô hình chỉ tách ý định, KHÔNG in thẳng, luôn thẻ xác nhận; bộ phân tích tất định chạy trước, Edge `print-assistant` cho câu tự do; Gemini mặc định, Anthropic ưu tiên nếu có khoá (khoá ở Secrets). (17/10 · N0950–N0961)
- Nonce theo thẻ; lỗi giữa lô (`error.jobIds`/`error.uncertain`) → giữ thẻ + danh sách đã chụp, khoá sửa, chỉ "In" gửi nốt phần còn lại. (17/10, 23/10 · N0953, N1178)
- `window.HasakiSkuIt` {readSlip, buildItems, enqueue} đóng băng, copies ≤ 200; ô Trợ lý in ẩn ≤ 800 px. (17/10 · N0951, N0953, N0956)
- `sku-vision`: gọi model so le (hedge 6 s), trừ 1 lượt/lần đọc; trần tổng 450/ngày, không giới hạn theo máy. (10/10, 21/10 · N0026, N1107)
- Trợ lý in → Packing List cấp vải (đợt 1, 24–25/10): danh sách Group UID (dán / gõ / đính kèm .xlsx·.csv·.txt; chỉ mã 16 số đầu `1028` — số phiếu IT tiền tố 1007) → RPC `fabric_issue_lookup_uids` (Admin) → thẻ xem trước → Tạo đợt (`fabric_issue_import` có sẵn, KHÔNG sửa; so UID sau khi tạo; `sourceName` = `Trợ lý in:<uuid>` để đối soát "chưa rõ" sau 20 giây) / Tải PL; ô Excel kiểu số ≥ 10^15 không dùng làm UID; hai luồng dùng chung cờ bận, lúc bận thẻ phiếu IT khoá ô sửa. (24–25/10 · N1207, N1208, N1215)

## 11. Đã bỏ hẳn / quyết định KHÔNG làm
- Module GOM HÀNG MẪU (`#sample`, bảng `sample_bags`) và TEM XẢ VẢI (`#fabric-relaxation`, cả trong agent); `#xa-vai` vẫn dùng. (11/10 · N0035, N0494)
- Màn nạp Excel Group UID trên web + thanh admin nổi; script xuất Group UID thủ công và 2 tài liệu lộ trình UI/UX 02/10. (07/10, 18/10 · N0061, N1021)
- Phần Combo của Rủi ro lưu trữ (giữ hàm `sku_combo_risk_dashboard`). (12/10 · N0012)
- Xem trước tem ở MÃ VỊ TRÍ. (03/10 · N0070)
- Tab 5 / màn `#cut-sample` lấy mẫu; UID ngoài phiên không tự rơi sang Cắt tự do. (16/10 · N0003)
- Xuất CSV (dùng .xlsx). (12/10 · N0016)
- Giao diện điện thoại của Admin; hướng B thanh trên Admin (nhãn "Quản trị viên"). (08/10 · N0048, N0052)
- Nhãn NGỪNG + nút "hiện cả SKU ngừng" ở màn in; loại Combo có thành phần Inactive khỏi `sku_combo_lookup`; chặn tem UID/vị trí khi SKU ngừng. (11/10 · N0034)
- Nạp bù SKU ngừng cũ (bỏ qua SKU mới đang ngừng). (14/10 · N0665, N0666)
- Index `SKU_Name.category_id`, `xa_vai_log(ended_at desc)`; index PO ở Group UID. (10/10, 21/10 · N0041, N1117)
- Tách source React / viết lại phần React (giữ `index.html` một tệp). (11/10 · N0529–N0531)
- IN TEM SKU: nút "Tin cũ" trong mẫu, tay kéo, in theo chọn. (11–12/10 · N0572, N0582)
- Từ Superpowers: brainstorming nhiều vòng, finishing-branch/PR, TDD ép cho thay đổi thuần trình bày. (17/10 · N0979)
- Agent `tai-hien`, `thuc-thi-khuon`. (18/10 · N1038, N1039)
- Quy đổi số lượng combo → normal ở Kiểm tra đầu vào. (17/10 · N0971)
- Ô Tự động "Quá hạn → vàng"; chấm trạng thái Extension ở Rủi ro lưu trữ. (18/10 · N1007, N1019)
- Excel làm nguồn UID blocked; nút "Phiên mới" ở UID blocked. (21/10 · N1065, N1067)
- Báo lỗi khi WMS thiếu khoá `group_uid_code` ở Packing List. (21/10 · N0752)
- Mã vạch PO trên tem SKU. (23/10 · N1154)
- Handshake Extension mới ↔ Edge cũ; lưu người/giờ QC Group UID. ([?], 16/10 · N0874, N0908)
- `readonly` / `virtualkeyboardpolicy="manual"` cho ô quét. (05/10 · N0076)
- Dùng `report-inventories`, export "By PO" của WMS, `apply --cleanup`. (10/10, 12/10, [?] · N0447, N0003, N0233)
- Đổi `qtyText` Phiếu IT (giữ thô). (16/10 · N0852)
- Viết lại lịch sử / force-push cho commit lẫn đã đúng nội dung (fd93c02, d48fc9e). (16/10, 21/10 · N0858, N1108)
- Câu giải thích quyền camera / gửi ảnh Gemini ở TÌM SKU. (02/10 · N0081)
- Review đã bỏ qua: "Phiếu IT > 500 dòng bị cắt" (sai), cột "Modified date" giữ tiếng Anh, nhãn `.ins-connector`. (22–23/10 · N1135, N1145, N1165)

## 12. Làm sau / tạm dừng / chờ người dùng chốt
- Trả NCC: "đối chiếu một phần" (đọc lệch vẫn lưu dòng, không nâng mốc) chỉ làm khi lỗi "WMS đổi dữ liệu" lặp thật; cột Đã quét ở 390 px vỡ dòng (có từ v1), nhãn số đã quét ở tiêu đề nhóm. (24/10 · N1200, N1201)

### Chờ người dùng chốt
- Mã kích hoạt máy in dùng được cho nhiều máy (max_uses): người dùng chốt ĐỂ SAU (23/10). Dọn lệnh SENT_UNCONFIRMED từ máy còn sống (không chờ cron ngày): làm ở đợt cài may-kho-02. Kiểm kê `readExact`: nếu sau Reload 0.10.8 báo "thay đổi trong lúc đọc" với cùng cặp số ở cả 3 lần → nới (lệch cố định). (23/10 · N1185)
- Trigger `sku_name_touch` (commit df52180, chưa có trên DB; nhiều nguồn ghi đồng thời). (18/10 · N1068)
- Lớp Edge "chỉ lưu trữ SKU thiếu 2 lượt toàn bộ liên tiếp": chỉ hỏi nếu còn lưu trữ nhầm. (22/10 · N1136)
- Tem Phụ liệu có số lượng mà PO + ngày trống: có vẽ khung không (R5). (23/10 · N1160)
- Ngoại lệ "SKU ngừng nhưng còn UID sống vẫn nạp" (3 SKU). (14/10 · N0665, N0666)
- Nút "Import từ file Excel" ở IN TEM GROUP UID còn dùng không. (10/10 · N0038)
- Hỏi chủ tích hợp tài khoản `api-clinic` (email hệ thống, đã che) về ~1.440 UID Canceled/ngày. (16/10 · N0004)
- Thư mục lạ `Print_SKU/` (bản sao repo) chờ quyết xoá. (18/10 · N1008, N1013)

### Nên sửa (đánh giá backend 23/10)
- BẮT BUỘC trước khi cài may-kho-02: P2 `print_agent_claim` trả lệnh sending/spooling hết lease cho agent khác. (23/10 · N1178)
- D2 Kiểm kê / Hàng chưa lên kệ so số dòng với `total`; Q2 default privileges schema public cấp anon; gói SQL nhỏ (giới hạn items `print_enqueue`, btrim, guard `data_until`, index `uid_block_scans.device_id`…); Edge sku-sync `order` khi đọc `sku_combo_links`. (23/10 · N1178)
- Extension 0.10.8: retry trừ apply, mã lỗi SESSION_EXPIRED/NETWORK, logout thu hồi refresh token, kiểm thứ tự Modified + trang lặp Combo, `data_until` theo giờ server; đợt 3 bỏ quyền `tabs`. (22–23/10 · N1134, N1142, N1178)
- Rà revoke `authenticated` cho từng hàm. (17/10 · N0984)

### Làm sau (đã ghi nhận)
- D1 lưu trữ SKU rời nhóm khi Extension bỏ dòng; nút Huỷ lệnh in Admin; lượt SKU held 17/10 (`error_message` rỗng). (23/10 · N1178)
- `print_queue_status` trả `availableCapabilities` theo heartbeat (nếu cần chặn lệnh `sku:v3`). (23/10 · N1162)
- In lại tem PO: R6 đóng/mở tấm In tem mất số lượng đã gõ, R9 `QUEUE_CONTRACT.md` + README gốc, nhãn "Số lượng" điện thoại. (23/10 · N1160)
- Tem Phụ liệu: `print_enqueue_unchecked` tra nonce trùng trước kiểm `SKU_INACTIVE`/`ACCESS_DENIED`; bảng KIỂM TRA ĐẦU VÀO 390 px bị cắt; liệt kê SKU Normal bị loại. (22/10 · N0737)
- Tem Group UID 0.10.0: `mapped.splice` theo vị trí khi trạng thái đổi giữa lúc gửi; web chưa gửi `rfid`; tự điền PO theo phiên Theo PO ở Cắt UID (cần đổi `cut_group_uid_list`). (21/10 · N1110, N1111, N1116)
- `GET_PO_GROUP_UID_PAGE` kiểm `rows.size !== total` như đồng bộ. (22/10 · N0744)
- Preview Group UID chưa so thành phần sản phẩm (`products` vào changed_fields). ([?] · N0874)
- Group UID gia tăng mù qty: hướng sâu (đọc lại từ lịch sử Cut/di chuyển) — hoãn. (12/10 · N0605)
- Lịch sử Group UID: lưu Create/Edit-Add/Edit-Remove, hộp chi tiết theo UID. (10/10, 14/10 · N0442, N0008)
- `vacuum (full, analyze)` `group_uid_sync_changes`; web hiện "chi tiết đã dọn" (`changes_purged_at`); index `SKU_Name.updated_at desc`. (10/10 · N0039, N0040, N0041)
- Cột `qty` Group UID không lưu đơn vị. (28/09 · N0102)
- ADJ kho `WH - SEMI PRODUCT - MTG` (Extension chỉ đọc `warehouse_ids=1177`). (08/10 · N0045)
- Cấp vải: thiếu hụt cần/Packing/WMS, xuất Excel kết quả quét, cảnh báo trạng thái WMS, lưu lượt quét sai. (12/10 · N0010, N0011)
- UID tạm bản 2: tick "đã xử lý" lưu Supabase, gộp theo mã ADJ. (16/10 · N0904)
- Trợ lý in: log lượt lỗi AI, giới hạn CORS origin, ý định in lại tem; duyệt lệnh bằng agent TẠM DỪNG; AI đọc PO từ ảnh tem = đợt sau. (17/10, 23/10 · N0950, N0954, N1154)
- `floor_access_v2` drop bản cũ không token (khi hết lượt gọi cũ). (17/10 · N0996)
- Web hiện riêng LEASE_LOST; báo cáo tuần UID sống mất SKU; ép kiểu thô ở `sku_count_save_chunk`. (17–18/10 · N0934, N0945, N1026)
- Giao diện còn nợ: thẻ Kiểm kê đỏ/vàng khi chưa có bản chụp, "Nhập Excel" cạnh Đọc WMS trông bị khoá, dải lọc Rủi ro lưu trữ / tab Kiểm kê ở 390 px; popup còn lại (chi tiết một dòng, chip "N cảnh báo", Cấu hình máy in). (08/10, 18/10 · N0042, N1004, N1009, N1019)
- Header còn nợ: pill máy in cho Cắt UID/TÌM SKU/Vị trí, Back cố định một vị trí, tab Cắt UID/Xả vải 375 px; Cấu hình React còn "Link cấp quyền cho máy khác"; mã chết `#fsk-cd`. (07/10, 10/10 · N0075, N0037, N0029)
- Quét camera liên tục (in hàng loạt) ở IN TEM GROUP UID / Cắt UID / Xả vải — chờ yêu cầu. (07/10 · N0063, N0065)
- Haiku lọc ngưỡng 80 quá chặt — xem lại ngưỡng. (18/10 · N1091, N1100)
- Kiểm tra đầu vào cho vải: build riêng sau; tách source React chỉ khi có source gốc hoặc người dùng duyệt. (17/10, 11/10 · N0970, N0532)

### Chưa kiểm thật (cần thiết bị/dữ liệu thật)
- Điện thoại/camera/máy quét Honeywell/RFID thật; in thật tem vị trí, tem v3 có số lượng. (nhiều ngày · N0030, N0063, N0070, N0465, N1073)
- Extension thật: dấu "!" trên icon, WMS 401 hay 403 khi hết token; Admin đọc WMS thật lần đầu (Kiểm kê, Kiểm soát công trình); Combo sắp Modified giảm dần (`comboRows` ≈ 5.800 = đọc toàn bộ). (15–23/10 · N0006, N0866, N1030, N1144)
- Nonce "Thử lại" ở IN TEM SKU / IN TEM GROUP UID (03/10 sinh nonce mới mỗi lần bấm) — chưa kiểm đã sửa. (03/10 · N0079)
- Giả định NCC Kiểm tra đầu vào: hậu tố ` - người liên hệ` luôn có. (10/10 · N0178)
- Test `inventory_audit` lỗi có sẵn — chưa kiểm đã sửa. (14/10 · N0686)

---

## Trạng thái lên thật (kiểm Supabase MCP chỉ đọc + git, 25/10/2026 tối)

Kiểm lại: `python scripts/live_status.py` (chỉ đọc). Chạy 25/10/2026 21:41: 86/87 tệp migration đủ đối tượng; thiếu đúng `sku_name_touch_v1.sql`; Edge, agent, cron như dưới.

Mục này thắng mọi ghi chú "CHƯA LÊN" trong nhật ký. Kiểm lại khi thêm migration / Edge / Extension / agent; ghi ngày kiểm ở tiêu đề.

**Web:** `main` = `origin/main` = `9373788` (25/10). GitHub Pages phục vụ bản này.

**ĐÃ LÊN — migration (có đối tượng trên DB)**
- `sku_missing_archive_v1` (SKU rời 7 nhóm tự lưu trữ).
- `group_uid_qc_status_v1` (trạng thái QC Group UID).
- `floor_access_v1` (khoá máy nhóm ghi xưởng, chế độ bắt buộc).
- `uid_block_v1` + `uid_block_wms_v1` + `uid_block_auto_v1` (UID blocked; cron `uid-block-refresh-wms` */30).
- `group_uid_rfid_v1` (RFID ↔ Group UID).
- `cut_group_uid_po_v1` (cột `cut_group_uids.po`).
- `snapshot_cache_v1` (`sku_count_snapshot`), `uid_temp_snapshot_v1` (`uid_temp_save`).
- `print_name_from_db_v1` (`print_enqueue_unchecked` trả `renamed`).
- `db_hygiene_v1` (17/10): 2 index `print_devices_activation_code_id_idx`, `wms_group_uid_cuts_import_id_idx` có trên DB (trước ghi "chưa kiểm").
- `sync_auto_v2` (23/10) + cửa sổ đối chiếu toàn bộ tự động 07:30–11:00.
- `fabric_issue` (Cấp vải) + `fabric_issue_lookup_v1` (25/10: `fabric_issue_lookup_uids`, anon không execute, không Admin → FORBIDDEN · N1214).
- Tem Phụ liệu v2: `print_sku_po_v1` (22/10).
- Tem SKU một mẫu v3 + in lại tem PO: `print_sku_v3_v1` + `sku_po_receipts_v1` (23/10).
- `backend_hygiene_v1` (Đợt B, 24/10 00:34: có `print_job_cancel`, index `uid_block_scans_device_idx` · N1194, N1195).
- `vendor_return_v1` + `vendor_return_v2` (Trả NCC, 24/10: bảng `vendor_return_lists`, index `vendor_return_lists_one_active`, hàm `vendor_return_reconcile` · N1198, N1200).

**ĐÃ LÊN — Edge Function (bản đang chạy ↔ commit cuối của thư mục hàm)**
- `sku-sync` bản 12, deploy 24/10 07:26 — sau commit 7f0791a (23/10 23:07).
- `group-uid-sync` bản 11, deploy 21/10 17:57 — sau commit 498f65f (21/10 17:53).
- `print-assistant` bản 2, deploy 17/10 17:12 — sau commit e04504f (17/10 17:08).
- `sku-vision` bản 5, deploy 21/10 11:31 — trước commit dff8e35 (11:40) nhưng nội dung đang chạy đã có thay đổi của commit đó (bỏ giới hạn theo máy, `DEVICE_DAILY … || null`).

**ĐÃ LÊN — Extension / agent / cron**
- Extension 0.10.8: người dùng xác nhận Reload 24/10 (N1196). Lượt tự động cuối cùng ghi trong `sync_auto_leases`: 24/10 16:24 (group_uid, cut_adj), `storage_risk` xong 24/10 15:25.
- Agent `Máy kho 01` 0.10.2, khai `sku:v1/v2/v3`, `group_uid:v1`, `location:v1`, `location:name-optional`; máy in TSC PE200 READY; lần thấy cuối 24/10 16:30.
- Cron (giờ UTC, VN = +7): `print-jobs-purge` 03:00, `sync-history-purge` 03:30, `print-assistant-purge` 03:50, `floor-access-purge` 03:55 mỗi ngày; `group-uid-canceled-purge` 03:15 và `sku-inactive-archive` 03:45 sáng thứ Hai; `uid-block-refresh-wms` mỗi 30 phút.

**CHƯA LÊN**
- Trigger `sku_name_touch` (`sku_name_touch_v1.sql`, 20/10): không có hàm lẫn trigger trên DB (kiểm lại 25/10); danh mục SKU trên máy dựa `updated_at` do sku-sync đóng dấu; đang gác.
- `Máy kho 02`: đã tạo trong `print_agents` (khai `sku:v1`, `group_uid:v1`, `location:*`) nhưng chưa từng kết nối — chưa cài agent.

**Đã lên, CHƯA thử thật**
- Trợ lý in → Packing List cấp vải: dán / đính kèm UID bằng Admin → Tạo đợt / Tải PL; tệp Excel Group UID thật từ WMS (cột UID chữ hay số) (N1215).
- Tem SKU v3: tem có số lượng (đã in thật v1/v3 ngày 23/10).
- "Chạy ngay" Rủi ro lưu trữ trong giờ làm (G9) sau Reload 0.10.8 — `sync_auto_leases` không phân biệt lượt tay hay tự động (N1196).
