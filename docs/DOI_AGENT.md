# Đội agent của Print_SKU — bản 2 (17/10/2026)

Bản 2 lấy kỷ luật của Superpowers (thiết kế trước, kế hoạch theo việc nhỏ, TDD, gỡ lỗi có hệ thống, review hai lớp, không báo xong khi chưa có bằng chứng) nhưng giữ khung riêng của dự án: commit thẳng `main` chỉ khi người dùng nói, Codex làm review độc lập, migration → deploy Edge → Reload Extension. Hồ sơ agent ở `.claude/agents/*.md`, gọi bằng Agent tool (`subagent_type` = tên tệp). Nếu plugin Superpowers được cài, **tệp này thắng khi hai bên khác nhau**.

## Năm luật không ngoại lệ

1. **Không viết mã cho việc Lớn khi chưa có thiết kế được người dùng chốt.**
2. **Không sửa logic khi chưa thấy test đỏ** đúng lý do (TDD: đỏ → xanh → dọn).
3. **Không sửa lỗi khi chưa có nguyên nhân gốc có bằng chứng** (xem Quy trình sửa lỗi).
4. **Không báo "xong" khi chưa trích kết quả lệnh thật.** Điều chưa kiểm được phải nói rõ là chưa kiểm.
5. **Không commit/push khi người dùng chưa nói**; xong việc thì nhắc commit kèm danh sách tệp.

## Ba hạng việc

Lead phân hạng ngay khi nhận yêu cầu và nói hạng trong câu cập nhật đầu tiên.

| Hạng | Dấu hiệu | Quy trình |
|---|---|---|
| **Nhỏ** | một khối, ≤ ~20 dòng, không đổi SQL/Edge/Extension/quyền (sửa nhãn, đổi một dòng ưu tiên, CSS nhỏ) | Lead làm thẳng → test liên quan + `git diff --check` → báo kết quả |
| **Vừa** | một luồng, 1–3 tệp, có thể đụng Extension hoặc Edge (ví dụ Rcvd date = LastModified) | Trinh sát → một người thực thi theo TDD → kiểm thử soát đặc tả + test → Codex nếu đụng SQL/Edge/Extension/in/quyền |
| **Lớn** | tính năng mới, nhiều tệp, có migration hoặc màn mới (ví dụ đồng bộ tự động, trợ lý in) | Đủ 6 bước bên dưới |

Sửa lỗi ở bất kỳ hạng nào đều đi qua **Quy trình sửa lỗi** trước.

## Vai trò

| Vai | Mô hình | Hồ sơ | Làm | Không làm |
|---|---|---|---|---|
| Lead | Fable 5.1 (dự phòng Opus 5.5) | phiên chính | phân hạng, thiết kế, kế hoạch, giao việc, gộp, lọc review, migration/deploy cùng người dùng, commit | giao việc chưa có chuỗi neo và test nghiệm thu |
| Trinh sát | Haiku | `trinh-sat` | đọc `docs/PROJECT_MAP.md` rồi grep xác minh: tệp, chuỗi neo, chỗ gọi, test, quyết định đã chốt; với lỗi: đường dữ liệu từ nguồn tới chỗ hiển thị | sửa tệp, đề xuất thiết kế |
| Thực thi logic | Opus | `thuc-thi-logic` | SQL, Edge, Extension, luồng in/quyền, hàm tính trong `index.html` — theo TDD | migration thật, deploy, commit, mở rộng phạm vi |
| Thực thi khuôn | Sonnet | `thuc-thi-khuon` | màn web theo khuôn, test Playwright, README | logic máy chủ, Extension |
| Kiểm thử | Haiku | `kiem-thu` | **soát đặc tả sau từng việc**, chạy test, cổng 7 mục trước commit | sửa mã nghiệp vụ |
| Review chất lượng | Codex CLI | kỹ năng `review-codex` | review mã và ảnh màn bằng mô hình khác họ, cuối mỗi đợt | sửa thẳng repo |
| Nghiệm thu | người dùng | | chốt thiết kế, chạy thật trên Inside/WMS/máy in, duyệt ảnh | |

## Quy trình việc Lớn (6 bước)

### 1. Thiết kế
- Trinh sát lấy bản đồ phần liên quan (đọc `docs/PROJECT_MAP.md` trước).
- Lead đo dữ liệu thật khi cần (Supabase SQL, DevTools trên tab Inside/WMS — không dùng `get_network_request` vì lộ token).
- **Một lượt câu hỏi** cho người dùng (AskUserQuestion, tối đa 4 câu, mỗi câu có phương án khuyến nghị đứng đầu). Không hỏi nhiều vòng; điều suy ra được từ mã hay dữ liệu thì không hỏi.
- Ghi `docs/plans/<yyyy-mm-dd>-<tên>.md` phần **Thiết kế** (mẫu ở `docs/plans/README.md`): mục tiêu nhìn thấy được, quyết định đã chốt (kể cả quyết định đổi so với `RULES.md`), hợp đồng dữ liệu, rủi ro, điều chưa kiểm được bằng máy. Ghi tóm tắt vào `RULES.md`.

### 2. Kế hoạch
- Cùng tệp, phần **Kế hoạch**: chia thành việc nhỏ, mỗi việc **một người thực thi, một nhóm tệp không trùng, kiểm được độc lập**, thường 5–30 phút. Mỗi việc ghi: tệp → chuỗi neo nguyên văn; test sẽ đỏ trước (tên + điều khẳng định); lệnh chạy; kết quả mong đợi; ô trạng thái `[ ]`.
- Việc cùng sửa `index.html` hoặc phụ thuộc nhau → tuần tự; còn lại → song song trong worktree riêng.

### 3. Thực thi theo việc
- **Mỗi việc một subagent mới** (`thuc-thi-logic` hoặc `thuc-thi-khuon`), bản giao việc = đúng mục việc trong kế hoạch + phần thiết kế liên quan. Không giao "cả tính năng" cho một agent.
- Người thực thi làm TDD: viết/sửa test → chạy thấy **FAIL đúng lý do** → sửa mã → **PASS** → chạy bộ chuẩn liên quan. Báo cáo phải trích cả dòng đỏ lẫn dòng xanh.
- Worktree: agent dùng cổng máy chủ riêng (không phải 8000, mỗi agent một cổng: 8001, 8002, …) và `BASE=`; bàn giao `git diff > scratchpad/<việc>.patch`; lead gộp (`git apply --ignore-whitespace` nếu lệch CRLF), xoá worktree. Việc sửa nhỏ sau review có thể giao làm thẳng trên cây chính (ghi rõ trong bản giao việc).
- `RULES.md` không vào git nên **không có trong worktree**: người thực thi đọc bằng đường dẫn tuyệt đối `C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md` và KHÔNG ghi vào đó; mọi ghi chép `RULES.md` do lead làm. Tệp kế hoạch chưa commit cũng đọc bằng đường dẫn tuyệt đối của cây chính.

### 4. Soát đặc tả sau từng việc
- `kiem-thu` so diff của việc với mục kế hoạch: **ĐÚNG ĐẶC TẢ** hoặc **LỆCH** (thiếu gì, thừa gì, chạm ngoài phạm vi). Kiểm luôn có bằng chứng đỏ → xanh.
- Lệch → trả lại đúng người thực thi đó (SendMessage), không chuyển việc tiếp theo. Lead đánh `[x]` vào kế hoạch khi việc qua.

### 5. Review chất lượng cuối đợt
- Bắt buộc khi đụng SQL, Edge, Extension, luồng in/quyền hoặc có màn mới: `python scripts/codex_review.py --working-tree --brief docs/plans/<tệp>.md` (màn mới thêm `--images`).
- Lead lọc từng phát hiện thành ba nhóm: **sửa** (giao lại theo bước 3–4, hoặc lead tự sửa nếu nhỏ, vẫn TDD), **làm sau**, **bỏ qua có lý do** (trái quyết định đã chốt). Lead tự quyết; **chỉ hỏi người dùng khi bản sửa đổi một quyết định đã chốt hoặc đổi hành vi người dùng thấy**. Ghi kết quả lọc vào `RULES.md`. Tối đa hai vòng Codex; vòng hai chỉ hỏi về các sửa của vòng một và phần chưa review.

### 6. Xác minh, bàn giao, lên
- Cả bộ `python scripts/run_tests.py` + cổng trước commit: lead tự chạy hoặc giao `kiem-thu` (lead chịu trách nhiệm kết quả). Test chập chờn do tải máy thì chạy lẻ lại và ghi rõ.
- Lead cập nhật `docs/PROJECT_MAP.md` nếu đổi module/lệnh/Edge/migration, `README.md`, `RULES.md`.
- Báo người dùng: hành vi đổi, kết quả test (trích số liệu), review đã xử lý, điều chưa kiểm, danh sách tệp chờ, **nhắc commit**.
- **Push `main` = deploy web ngay (GitHub Pages).** Web gọi hàm/cột/Edge mới thì thứ tự là: commit (chưa push) → migration → deploy Edge → **push** → Reload Extension + tải lại tab. Chỉ push trước migration khi web mới vẫn chạy được với database cũ (đã kiểm). Thay đổi chỉ có SQL/Edge thì commit + push trước, migration sau.
- Sau khi lên: lead kiểm thật (Supabase MCP chỉ đọc hoặc SQL/DevTools) và ghi số đo vào `RULES.md`.

## Quy trình sửa lỗi (mọi hạng)

1. **Tái hiện bằng bằng chứng**, không đoán: ảnh/câu người dùng → SQL trên Supabase, DevTools trên tab thật, log Edge, `print_events`. Ghi lại dữ liệu sai cụ thể (giá trị, thời điểm, mã lệnh).
2. **Truy ngược tới nguyên nhân gốc**: đi theo đường dữ liệu từ nguồn (Inside/WMS/RPC) tới chỗ hiển thị; so trường hợp đúng với trường hợp sai; mỗi lần kiểm **một** giả thuyết. Ví dụ đã làm: "Failed to fetch" → Supabase trả 403 cho token hết hạn chứ không phải 401; Rcvd date → `cells[5]` là cột Delivery, LastModified ở `cells[4]`.
3. **Test đỏ tái hiện lỗi** (Node/vm cho lõi, Playwright cho màn).
4. **Sửa một chỗ**, test xanh, chạy bộ liên quan. Sửa ba lần chưa xong → dừng, xem lại thiết kế và báo người dùng thay vì vá tiếp.
5. Ghi `RULES.md`: triệu chứng, nguyên nhân gốc, bằng chứng, cách sửa, điều chưa kiểm.

## Khi phiên bị gián đoạn

- Tệp kế hoạch trong `docs/plans/` là nguồn sự thật cho việc đang dở: ô `[x]`/`[ ]` cho biết việc nào xong. Lead mới (hết ngữ cảnh, đổi model, phiên mới) đọc theo thứ tự: `docs/PROJECT_MAP.md` → tệp kế hoạch mới nhất → mục cuối của `RULES.md` → `git status`.
- **Lead dự phòng**: Fable 5.1 hết hạn mức → Opus 5.5 làm lead trong cùng phiên (đổi model ở bộ chọn của app), giữ nguyên năm luật và quy trình. Sonnet và Haiku không làm lead. Hết ngữ cảnh khác hết hạn mức: phiên tự tóm tắt và tiếp tục với cùng model.

## Quy tắc chung không đổi

- Sửa nhỏ nhất trong `index.html`, không reformat; giữ CRLF/LF hiện trạng; đọc lại tệp ngay trước khi ghi; không ghi lại cả tệp từ bản đọc cũ.
- Tiếng Việt có dấu; icon Lucide trước nhãn ngắn; không câu hướng dẫn kiểu AI trong màn; Admin chỉ xét máy tính.
- Màn mới hoặc làm lại giao diện: người thực thi khuôn nạp kỹ năng `frontend-design` (plugin đã cài 17/10/2026) để lấy hướng bố cục, thứ bậc thị giác, khoảng trắng, trạng thái rỗng/đang chờ/kết quả. **Chuẩn dự án thắng khi khác nhau:** giữ màu chính #005F41 và bảng màu hiện có, một font hệ thống, thang chữ và cỡ icon mà `typography_browser`/`icon_standard_browser`/`ui_standard_browser`/`a11y_axe_browser` kiểm; không thêm font, CDN hay thư viện.
- Không phụ thuộc ngoài, không gọi mạng mới khi chưa được duyệt, không bí mật hay dữ liệu thật trong repo. Dữ liệu giả chuẩn: SKU `9000000xx`, Group UID `1028260000000xxx` (cũ còn dùng `9999991000000001`), số phiếu/PO `100000001`; fixture cũ đã có trong HEAD giữ nguyên.
- **Supabase MCP (plugin, 17/10/2026) chỉ dùng để ĐỌC** (schema, RLS, log Edge, advisors, SELECT) trên project `ikzhitdqkoatlmkrxuuh`. Migration, deploy, ghi dữ liệu, đổi cấu hình/khoá vẫn qua `scripts/apply_supabase_sql.py` / `deploy_*.py` do người dùng chạy, trừ khi người dùng cho phép rõ từng lần. Thiết lập Auth/bảo mật trong Dashboard do người dùng tự bấm.
- Việc đã chốt là không làm trong `RULES.md` thì người thực thi không được "sửa lại cho đúng".
- Nhiều phiên cùng sửa `index.html`: `git status` trước khi gộp; commit chỉ phần của đội.

## Chạy nhanh

- Cả bộ test: `python scripts/run_tests.py [--no-server] [--only <tên>]`; máy chủ tĩnh cổng 8000; `PLAYWRIGHT_MODULE=C:/Users/HASAKI/playwright-tools/node_modules/playwright`.
- Review Codex: `/review-codex`, hoặc `python scripts/codex_review.py --commit <sha> | --working-tree | --images <thư mục> --brief <md>`.
- Migration: `python scripts/apply_supabase_sql.py <tệp> [--dry-run] [--allow-destructive]`; deploy Edge: `python scripts/deploy_<tên>.py [--dry-run]`.
- Bản đồ dự án: `docs/PROJECT_MAP.md`; mẫu thiết kế/kế hoạch: `docs/plans/README.md`.
