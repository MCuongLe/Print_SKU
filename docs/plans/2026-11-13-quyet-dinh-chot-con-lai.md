# Quyết định đã chốt còn lại sau rà soát luật (2026-11-13)

## Thiết kế
- **Yêu cầu:** rà soát luật 13/11/2026 còn 5 mục chờ chốt trong repo này; người dùng đã chốt rồi nói "Tạm gác các phần này ghi vào kế hoạch tôi cần tắt máy".
- **Trạng thái (14/11 07:46, N20261114-0746):** mục 3, 4, 5, 6 XONG; mục 1 XONG 14/11 08:06 (N20261114-0806). Đã làm trước đó cùng ngày: sửa luật lệch mã (`edacda2`), hook cổng commit bắt PowerShell (`d24c5e7`); nhật ký `[N20261113-1828]`.
- **Phần của dự án tách riêng** (mục 2, 7, 8, 9, 10, 11, 12a, 12b): kế hoạch nằm ở thư mục dự án đó (đường dẫn trong bộ nhớ Claude), không ghi ở đây.
- **Loại việc:** tài liệu, hồ sơ agent, runner test; không đổi cấu hình hook hay settings.

## Kế hoạch

### Mục 1 — tệp kiến thức WMS/Inside · người dùng chọn "Bản … làm gốc (Recommended)" · [x]
- Lệch kế hoạch (14/11): kiểm lại, bản gốc vẫn chưa có 2 dòng dò 13/11 dưới (`batch_codes`, `bin-locations` grep 0) → không thay bản local, không sửa `docs/QUYET_DINH.md` / bộ nhớ; chờ chép 2 dòng sang bản gốc (phiên của thư mục dự án tách riêng) rồi làm tiếp.
- Bản gốc là `docs\KIEN_THUC_WMS_INSIDE.md` ở thư mục dự án tách riêng; `docs/local/KIEN_THUC_WMS_INSIDE.md` (gitignore) chỉ còn một dòng trỏ sang đó.
- [x] Trước khi thay: bản local có mục mà bản gốc KHÔNG có thì chép sang bản gốc hoặc báo người dùng. Đo 13/11 18:3x (so từng dòng): bản local có 2 dòng bản gốc chưa có, đều ở mục "5. Group UID và lịch sử":
  - Tra theo Lot / cuộn (dò 13/11/2026): `group-uid-infos?batch_codes=` / `roll_codes=` lọc đúng; `batch_code`, `keywords` bị bỏ qua; `processing_source_code=<PO>`; đọc toàn bộ theo trang.
  - Danh mục vị trí (dò 13/11/2026): `v1/wms/accessories/bin-locations?warehouse_id=<id>&size=500&page=` (bắt buộc `warehouse_id`, đọc tới trang rỗng).
  - Các dòng mẫu in phiếu IT và khối lượng trong app ftr đã có ở bản gốc (mục 3c-1) hoặc tệp kiến thức ftr, dạng viết khác.
- [x] `docs/QUYET_DINH.md` dòng "nơi duy nhất" của tệp kiến thức: sửa thành "bản gốc nằm ở thư mục dự án tách riêng, xem bộ nhớ" (không ghi tên dự án đó vào tệp git).
- [x] Bộ nhớ `feedback_wms_inside_knowledge_local_only.md` + dòng `MEMORY.md`: ghi đường dẫn gốc mới.

### Mục 3 — lead Sonnet · người dùng chọn "Bậc 0 + dữ liệu giả (Recommended)" · [x]
- Sonnet làm bậc 0 và sửa test chỉ thay dữ liệu giả (bậc 1 hẹp: chạy đúng test đó + `commit_gate`), tự commit + push; việc logic / dữ liệu / in / quyền / migration thì dừng, báo người dùng mở phiên Fable / Opus.
- [x] `docs/chuan/KIEM_THU_GIT.md` dòng "Phiên Sonnet chỉ làm bậc 0".
- [x] `docs/DOI_AGENT.md`: hàng `co-van` ("lead (Opus hoặc Sonnet)"), bảng "Chọn model và phiên", gạch "Phiên Sonnet gặp việc thuộc hàng dưới".
- [x] `AGENTS.md` luật 3 nếu cần; `docs/QUYET_DINH.md` dòng "Chọn model theo loại việc".
- [x] `.claude/agents/co-van.md` mô tả: bỏ "hoặc Sonnet" (còn "Lead Opus"; lead Fable tự làm cả hai việc).

### Mục 4 — review Claude · người dùng chọn "Tách lại B và C (Recommended)" · [x]
- Kết luận đợt thử gộp: token `BC` khoảng 290 nghìn so với B + C tách khoảng 285 nghìn mỗi vòng — không giảm (số do phiên rà soát 13/11 đưa, chép vào nhật ký khi làm).
- [x] `.claude/skills/review-claude/SKILL.md`: lấy lại bản ba agent A / B / C từ `git show 2eff3bf~1:.claude/skills/review-claude/SKILL.md` (commit `2eff3bf` là đợt gộp; từ đó tới nay tệp không đổi gì khác).
- [x] `.claude/agents/co-van.md`: đầu vào "Codex + Claude A/B/C" (như trước `2eff3bf`).
- [x] `docs/DOI_AGENT.md`: hàng "Review Claude" về bản "Opus + 2 Sonnet, 3 agent theo 3 góc" (`git show 2eff3bf~1:docs/DOI_AGENT.md`); mục "Thử gộp review B+C" thay bằng kết luận một dòng hoặc chuyển nhật ký.
- [x] `docs/QUYET_DINH.md`: dòng Review (A/B/C) và dòng "thử gộp B+C" → "đã tách lại 13/11".

### Mục 5 — bộ chuẩn giao diện · người dùng chọn "11 test ở GIAO_DIEN.md (Recommended)" · [x]
- Danh sách 11 test ở `docs/chuan/GIAO_DIEN.md` là gốc.
- [x] `scripts/run_tests.py` hằng `UI_STANDARD` đổi theo 11 test đó (kiểm từng tệp test tồn tại: 11/11 có; bỏ `app_nav_browser`, `mobile_home_browser` vốn không thuộc danh sách gốc). Đổi runner = hạ tầng test: chạy `run_tests.py --only <các test UI_STANDARD>` và test của runner (`tests/test_run_tests.py`).
- [x] `docs/PROJECT_MAP.md` mục 5 và `AGENTS.md` (bậc 1–2 kiểm chứng) trỏ về `docs/chuan/GIAO_DIEN.md`.

### Mục 6 — Supabase MCP · người dùng chọn "Không chặn" · [x]
- Giữ cấu hình không chặn ghi; "MCP chỉ đọc" là luật viết.
- [x] `AGENTS.md` dòng Supabase MCP và `docs/QUYET_DINH.md` dòng Công cụ: ghi rõ "chỉ đọc là luật viết, cấu hình không chặn (người dùng chốt 13/11)".
- [x] Bộ nhớ `feedback_supabase_mcp_read_only.md` sửa theo.

### Kết thúc
- [x] `git diff --check`, `commit_gate`; nhật ký `RULES.md` mã mới liệt kê 5 quyết định; commit + push (Mục 5 là bậc 3 điều kiện (c) — hạ tầng test).

## Nhật ký
- 14/11 07:46 (N20261114-0746): mục 3–6 làm xong; `test_run_tests` 1/1 PASS; 11 test bộ chuẩn `run_tests.py --only …` "11/11 PASS trong 93s"; mục 1 dừng. Lệch: không chạy cả bộ (bậc 3 điều kiện c) vì `UI_STANDARD` chỉ dùng cho `--changed`; cả bộ không đi qua hằng này, test của nó là `test_run_tests` + 11 test đã chạy.
- 14/11 08:06 (N20261114-0806): bản gốc đã có 2 dòng dò 13/11 (commit cục bộ 61aed6f của thư mục dự án tách riêng; so lại từng dòng: còn lệch chỉ là dòng đầu tệp và đoạn viết lại cùng nội dung — mẫu in phiếu IT ở mục 3c-1, khối lượng app ftr ở tệp kiến thức ftr; riêng số đếm mẫu 10 SKU của dòng khối lượng không chép).
  - Bản local thay bằng dòng trỏ, bản cũ giữ ở `docs/local/_cu/` (gitignore); `docs/QUYET_DINH.md` + bộ nhớ sửa theo.
