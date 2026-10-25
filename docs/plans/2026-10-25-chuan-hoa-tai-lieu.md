# Chuẩn hoá tài liệu và quy trình (2026-10-25)

## Thiết kế
- **Yêu cầu:** "dự án đang lớn dần tôi cần bạn thiết lập chuẩn hóa cách viết contex, project, rule, readme, và các hạng mục khác, để các phiên làm việc đều giống nhau về qui trình, cách viết code, xây giao diện luồn dữ liệu, database".
- **Kết quả nhìn thấy được:** mỗi chủ đề có một nguồn; phiên nào cũng đọc cùng tệp theo loại việc; tham chiếu `RULES.md` không lệch khi tệp dài thêm.
- **Đã chốt với người dùng (25/10/2026):**
  - Làm theo 5 đợt dưới đây; mỗi đợt một commit, không đổi hành vi app.
  - Mục lục quyết định đưa vào git (`docs/QUYET_DINH.md`) sau khi che email; nhật ký `RULES.md` vẫn chỉ trên máy.
  - Commit message tiếng Việt không dấu (như 56/60 commit gần nhất).
  - `commit_gate` chỉ cảnh báo trước; sau 2–3 đợt mới xét chuyển sang chặn.
- **Số đo (25/10/2026):**
  - Luật nằm rải ở 7 nơi: `AGENTS.md`, `docs/DOI_AGENT.md`, `docs/CONTEXT_MAP.md` ("Quy ước luôn đúng"), `docs/PROJECT_MAP.md` mục 6, mục lục `RULES.md`, bộ nhớ lead, các mục "Chuẩn …" của `README.md`.
  - `RULES.md` 549 nghìn ký tự; mục lục 224 tham chiếu "dòng N" + độ lệch (đổi 5 lần trong ngày 25/10).
  - `README.md` 115 nghìn ký tự, không có mục lục; Trợ lý in nằm dưới "## Tìm SKU bằng camera".
  - 4 tệp `docs/THIET_KE_*.md` sửa lần cuối 03–08/10, trước các đợt chuẩn hoá giao diện 17–23/10.
- **Rủi ro và cách chặn:** mất luật khi rút gọn → mỗi đợt liệt kê luật bị chuyển chỗ và nơi mới; tham chiếu `RULES.md` hỏng → script đổi mã kiểm 332/332 mã trỏ đúng; repo public → soát dữ liệu thật trước khi đưa mục lục vào git.

## Kế hoạch
Thứ tự: đợt 1 → 2 → 3 → 4 → 5 (đợt 3 và 4 có thể đổi chỗ).

### Đợt 1 — Chuẩn viết tài liệu, mã ổn định, AGENTS gọn · lead · [x]
- [x] `docs/chuan/TAI_LIEU.md`: bảng một nguồn, cách viết, mã tham chiếu, khuôn (nhật ký, mục lục, trạng thái, tệp chuẩn, hàng PROJECT_MAP, mục module README), bảng cập nhật cùng commit.
- [x] `RULES.md`: 224 tham chiếu "dòng N" → mã `N0965`; gắn mã đầu 332 dòng nhật ký được trỏ; ghi chú tra cứu đầu tệp; kiểm 332/332 mã grep ra đúng một dòng. Bản sao trước khi đổi: scratchpad `RULES.backup-2510-ids.md`.
- [x] `AGENTS.md` viết lại tiếng Việt (~1 trang): dự án, thứ tự đọc + bảng loại việc → đọc thêm, bốn luật cứng, luật kỹ thuật, kiểm chứng, bàn giao. Nội dung bỏ khỏi bản cũ đã có nơi khác: đội agent → `docs/DOI_AGENT.md`; cổng `window.PrintSku*`, `bridge_ready` → `docs/PROJECT_MAP.md` mục 2; kiến trúc → `docs/CONTEXT_MAP.md`; luật cập nhật PROJECT_MAP → `TAI_LIEU.md` mục 5.
- [x] Trỏ về một nguồn: `CLAUDE.md` → `AGENTS.md`; `docs/DOI_AGENT.md` "Bốn luật" và "Lead mới đọc …" → `AGENTS.md`; `docs/CONTEXT_MAP.md` mục 5 → `TAI_LIEU.md` mục 5, thêm hàng `docs/chuan/`.
- [x] Kiểm: `git diff --check`, dòng văn xuôi mới ≤ 400 ký tự, `commit_gate --cached`.
- Ngoài phạm vi: "Quy ước luôn đúng" trong CONTEXT_MAP mục 5 và PROJECT_MAP mục 6 (đợt 2); dòng thứ tự đọc ở CONTEXT_MAP (giữ, khớp `AGENTS.md`).

### Đợt 2 — Bốn tệp chuẩn kỹ thuật · lead · [x]
- [x] `docs/chuan/GIAO_DIEN.md`: gom luật giao diện từ mục lục `RULES.md` chủ đề 2, các mục "Chuẩn …" của README, `docs/THIET_KE_*.md`; mỗi luật trỏ test giữ (17 test, đều có trong `tests/`); 3 tệp `THIET_KE_*` giao diện đánh dấu lịch sử; README 4 mục "Chuẩn …" thêm dòng trỏ.
- [x] `docs/chuan/MA_WEB.md`: khuôn khối `index.html`, cổng `window.PrintSku*`, tên sự kiện `print-sku-*`, khoá localStorage, script phát lại, xử lý lỗi và nhánh "chưa rõ".
- [x] `docs/chuan/DU_LIEU.md`: đặt tên hàm, quyền, khuôn trả `{ok, error}` + bảng mã lỗi, JSON camelCase, tệp migration, mặc định lưu Supabase, timeout, cron dọn dữ liệu, khuôn hợp đồng luồng.
- [x] `docs/chuan/KIEM_THU_GIT.md`: test, mock theo mẫu thật, cổng + `BASE`, dữ liệu giả; khuôn commit (tiếng Việt không dấu), index tạm khi nhiều phiên.
- [x] Bỏ "Quy ước luôn đúng" ở CONTEXT_MAP / PROJECT_MAP → trỏ về tệp chuẩn; bảng loại việc trong `AGENTS.md` trỏ sang tệp chuẩn; `docs/DOI_AGENT.md` "Quy tắc chung không đổi" thành dòng trỏ (mọi gạch cũ đã có chỗ mới).
- [x] Kiểm: 172 mã nguồn trong 4 tệp chuẩn grep ra đúng một dòng `RULES.md` (gắn thêm mã N1211); 22 tên test có thật; dòng văn xuôi ≤ 400 ký tự; `diff --check`; `commit_gate --cached`.
- Chỉ gom luật đang có, không đặt luật mới; mỗi luật ghi nguồn (ngày · mã nhật ký).

### Đợt 3 — Mục lục quyết định vào git · lead · [x]
- [x] Soát mục lục: che email hệ thống, không SKU / UID / PO thật — quét email / số ≥ 7 chữ số / URL / khoá / đường dẫn máy / IP: chỉ email hệ thống `api-clinic@…` (đã che); project ref và tên máy đã có sẵn trong git.
- [x] Tách sang `docs/QUYET_DINH.md`; `RULES.md` giữ nhật ký + một dòng trỏ; cập nhật `AGENTS.md`, `CLAUDE.md`, `TAI_LIEU.md`, review-claude (reviewer B), bộ nhớ.
- [x] Mã `N…` trong `QUYET_DINH.md` vẫn tra trong `RULES.md` trên máy — 340/340 mã có thẻ; mọi dòng thân mục lục cũ có mặt (trừ 3 dòng sửa có chủ đích: thứ tự đọc, "đã vào git", che email).
- [x] 17 tệp dẫn "mục lục đầu RULES.md" đổi sang `docs/QUYET_DINH.md` (AGENTS, DOI_AGENT, CONTEXT_MAP + sơ đồ svg, PROJECT_MAP, TAI_LIEU, 4 tệp chuẩn, hồ sơ co-van / trinh-sat, skill review-claude / review-codex, repomix, plans README); `scripts/codex_review.py` trích `docs/QUYET_DINH.md` trước rồi nhật ký `RULES.md` (thử: từ khoá "Packing List" ra 6 dòng, "Combo" 40 dòng; `py_compile` OK).

### Đợt 4 — README theo khuôn · lead · [x]
- [x] Đầu tệp: giới thiệu, mục lục (21 liên kết, đều khớp tiêu đề), chạy / test / lên bản (migration, Edge + Secrets, Extension, thứ tự lên), bảng tài liệu.
- [x] Module theo thứ tự thanh biên, khuôn mục module của `TAI_LIEU.md` (17 mục + 3 phần của TÌM GROUP UID); đoạn ≤ 600 ký tự, dòng ≤ 400; 70 tên test đều có thật; không email. README 934 → 358 dòng (115 → 28 nghìn ký tự).
- [x] Lịch sử thiết kế: bỏ khỏi README; bản cũ đầy đủ ở git `41160e7:README.md`; số đo / quyết định đã có trong nhật ký `RULES.md` (đối chiếu mẫu 20 mục), chi tiết hành vi chỉ có ở README cũ (đọc Packing List: SUB TOTAL, Định mức cấp phát) đưa lại vào mục Cấp vải; `GIAO_DIEN.md` bỏ mục lệch README 64 px.

### Đợt 5 — Cảnh báo tự động · lead · [x]
- [x] `commit_gate` cảnh báo (không chặn) mục 8–11: dòng tài liệu > 400 ký tự; `SECURITY DEFINER` thiếu revoke / `search_path`; mã `N…` không có thẻ; thông điệp có dấu (`--message-file`, `--commit`). "Đổi khối / Edge / migration mà không sửa PROJECT_MAP" đã có sẵn ở mục 7. Test `tests/test_commit_gate.py` (11, đỏ trước); thử trên commit 41160e7, 96c1257, 3775801 báo đúng.
- [x] `scripts/live_status.py` (chỉ đọc) sinh mục "Trạng thái lên thật" — test `tests/test_live_status.py` (9, đỏ trước); chạy thật 25/10 21:41: 86/87 tệp migration đủ, thiếu `sku_name_touch_v1.sql` (khớp lần kiểm tay).
- [x] Prompt Codex và `/review-claude` (`--prepare-only`) nạp tệp chuẩn theo loại thay đổi — test `tests/test_codex_review.py` (3, đỏ trước); thử `--prepare-only` ra đúng `KIEM_THU_GIT.md`.

## Phát sinh
- 25/10 Đợt 2: mục lục `RULES.md` còn 10 tham chiếu không mã và 2 dòng cũ (TÌM SKU hiệu ứng quét đã bỏ, Extension 0.10.7) → sửa ngay (chỉ trên máy, không vào commit).

- 25/10 Đợt 3: soát git thấy email nhân viên thật có sẵn trong `README.md`, `index.html`, `tests/group_uid_moves_browser.cjs` (ngoài mục lục) → không sửa trong đợt này, đề xuất phiên riêng.
- 25/10 Đợt 3: `docs/QUYET_DINH.md` còn 6 dòng > 400 ký tự (chép nguyên từ mục lục) → tách ở lần sửa nội dung kế tiếp; đợt 5 `commit_gate` sẽ cảnh báo.

- 25/10 Đợt 4: README cũ có email nhân viên thật (dòng Đợt tạo) → bỏ trong bản viết lại; đã nhắn phiên che email không sửa README.md để tránh xung đột.

- 25/10 Đợt 5: `scripts/run_tests.py` chạy thêm `tests/test_*.py` (unittest) để test mới vào cả bộ — làm ngay trong đợt (6/6 tệp Python đạt).
- 25/10 Đợt 5: `live_status.py` lần đầu báo nhầm index `sku_archive_sku_idx` (db_hygiene_v1 đổi thành khoá chính trong khối do $$) → thêm luật `add constraint … using index` + test.

## Lệch kế hoạch
- 25/10 Đợt 1: thứ tự lên bản trong `docs/DOI_AGENT.md` ghi "push → Reload Extension", còn `docs/CONTEXT_MAP.md` và `AGENTS.md` cũ ghi Reload Extension trước push. `AGENTS.md` mới theo CONTEXT_MAP; DOI_AGENT nay trỏ về AGENTS. · báo người dùng 25/10.

## Nhật ký
- 25/10 Đợt 1 xong (tài liệu thuần, không Codex theo `docs/DOI_AGENT.md`); commit + push `8ef8c69`.
- 25/10 Đợt 2 xong; commit + push `1670369`.
- 25/10 Đợt 3 xong; commit + push `41160e7`.
- 25/10 Đợt 4 xong; commit + push `a0ea302`.
- 25/10 Đợt 5 xong; chưa commit. `RULES.md` (chỉ trên máy): 10 tham chiếu cũ kiểu "nhật ký cuối tệp" / "đợt B" đổi thành mã; sửa 2 dòng mục lục đã cũ (TÌM SKU nay lớp phủ chibi; Extension hiện hành 0.10.8).
