# Chuẩn kiểm thử và git (05/11/2026)

Áp cho: test trong `tests/`, commit, push. Đọc khi: viết / sửa test, chạy cả bộ, commit khi nhiều phiên cùng sửa.
Gom từ `docs/QUYET_DINH.md` chủ đề 1, `docs/DOI_AGENT.md`, `docs/CONTEXT_MAP.md` mục 6; riêng mục "Dọn sau khi chạy test" và "Kiểm commit chỉ chứa một phần cây làm việc" là luật mới 04/11/2026. Luật nền (bốn luật cứng, kiểm chứng, bàn giao): `AGENTS.md`. Lệnh chạy: `docs/PROJECT_MAP.md` mục 5.

## Viết test

- Test đỏ trước bắt buộc khi sửa lỗi và khi đổi logic (SQL, Edge, Extension, hàm tính, luồng in / quyền); giao diện được viết test cùng lúc với mã nhưng test phải khẳng định hành vi mới. Nguồn: `docs/DOI_AGENT.md` bước 2; (18/10 · N1013, N1038)
- Sửa lỗi: test tái hiện lỗi phải đỏ trên bản chưa sửa rồi mới sửa. Nguồn: `docs/DOI_AGENT.md` "Quy trình sửa lỗi"
- Mock / test giả dựng theo một mẫu phản hồi thật (chỉ đọc) của đúng lời gọi: tên khoá, kiểu, định dạng mã; giá trị thay bằng dữ liệu giả; mẫu thật không vào repo. Nguồn: `docs/DOI_AGENT.md` bước 1; (25/10 · N1210)
- Dữ liệu giả chuẩn: SKU `9000000xx`, Group UID `1028260000000xxx` (fixture cũ `9999991000000001` giữ nguyên), số phiếu / PO `100000001`; không SKU / UID / PO thật. Giữ bởi: `commit_gate` (dữ liệu thật). Nguồn: (17/10 · N0920, N1001); `docs/DOI_AGENT.md` trước 25/10
- Test trình duyệt đọc `BASE` (mặc định `http://127.0.0.1:8000/`), Playwright nạp qua `PLAYWRIGHT_MODULE`. Nguồn: (10–23/10 · N0068, N0883, N1175)
- Test Python đặt tên `tests/test_<tên>.py` (unittest, không gọi mạng); `run_tests.py` chạy cùng cả bộ. Nguồn: (25/10 · N20261025-2144)

## Chạy test

- Phạm vi test do lead **Fable / Opus** quyết theo bốn bậc, ghi dòng `Phạm vi test:` (bậc · test đã chạy với dòng PASS nguyên văn · lý do không chạy phần còn lại) trong báo cáo và nhật ký; runner (`--changed --list`) chỉ gợi ý. Nguồn: (05/11 · N20261105-0915); `docs/plans/2026-11-05-quy-trinh-test-theo-pham-vi.md`
  - Phiên Sonnet chỉ làm bậc 0; agent được giao việc chạy đúng danh sách test trong bản giao, được thêm không được bớt.
  - Bậc 0 — tài liệu, kế hoạch, `RULES.md`, bộ nhớ, chú thích: chỉ `commit_gate --cached` (~10 s).
  - Bậc 1 — một màn / module (khối `index.html` của một màn; SQL chỉ **thêm** hàm / bảng; test của màn; Edge action chỉ màn đó gọi): test đỏ → xanh chỗ sửa; `run_tests.py --only <màn>`; SQL tĩnh nếu có `.sql`; đổi markup / CSS thì thêm `design_tokens_ratchet` + `icon_standard` + `ui_standard` (~40 s song song). Mục tiêu ≤ 3 phút.
  - Bậc 2 — dùng chung / lan toả: bậc 1 + test của **mọi nơi gọi** (grep id khối / tên hàm, liệt kê trong dòng Phạm vi test) + cả bộ chuẩn giao diện khi `index.html` đổi. Mục tiêu ≤ 8 phút.
    - Thuộc bậc 2: khối `PrintSkuQueue`, `WhDialog`, `scan-field`, `PrintSkuAdminAuth` / `Access`, `PrintSkuNotice`, `PrintSkuScanUI`, `PrintSkuFloorAccess`, `app-nav`, token CSS; SQL `create or replace` hàm **đang chạy**, trigger; Edge dùng chung; Extension; agent; `commit_gate.py`.
  - Bậc 3 — cả bộ: (a) người dùng bảo; (b) không liệt kê được nơi gọi (khối không id, hoặc > 8 test); (c) đổi hạ tầng test (`scripts/run_tests.py`, `tests/page_settle.cjs`, `tests/xlsx_read.cjs`, mock dùng chung, cách nạp Playwright); (d) lưới an toàn: sau khi push một đợt bậc 2, chạy **nền, không chặn báo xong**, hỏng thì sửa commit riêng. (a)(b)(c) chạy trước push.
  - Đợt đụng nhiều bậc lấy bậc cao nhất; nghi ngờ lấy bậc cao hơn. CSS đổi `display` / vị trí của thẻ tab xếp bậc 2 (lỗi `1a6defe` 04/11). Sau mỗi vòng review chỉ chạy lại test chạm chỗ vừa sửa.
  - Lệnh: `node tests/<tên>`, `run_tests.py --only <tên màn / module>` (một chuỗi con) hoặc `run_tests.py --changed` (xem dưới). Nguồn: `docs/DOI_AGENT.md` bước 2, 4; `docs/plans/2026-11-04-tang-toc-bo-test.md`
- `--changed [REF]` chọn test theo `git diff` so với REF (mặc định `HEAD`, kèm tệp chưa theo dõi); `--list` chỉ in danh sách, không chạy. `--list` ra cả bộ (tệp không map được) thì dùng `--only` theo màn đã sửa. Giữ bởi: `tests/test_run_tests.py`. Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Chọn test nhắc tên tệp đổi (runner quét chuỗi tên tệp trong mã test), test nhắc id khối `index.html` có dòng đổi, và luôn bộ chuẩn giao diện khi `index.html` đổi.
  - Có tệp đổi không map được (kể cả khối `index.html` không test nào nhắc) thì chạy cả bộ; `docs/`, `*.md`, `.claude/`, `workstation-agent/` (bộ test riêng `node --test`) không ép chạy gì.
- Cả bộ `python scripts/run_tests.py` = bậc 3 (điều kiện ở trên; 05/11 · N20261105-0800, N20261105-0915); chạy nền; script tự chạy lại test hỏng một lần, tuần tự, và in mục CHẬP CHỜN — chép mục đó vào báo cáo. Nguồn: `docs/DOI_AGENT.md` bước 4; (10–23/10 · N0068, N0883, N1175)
  - Mặc định 4 tiến trình song song (`--jobs N`, tối đa theo số lõi; `--jobs 1` = tuần tự từng tệp như bản cũ); mỗi test một tiến trình riêng, kết quả in theo thứ tự hoàn thành, test dài chạy trước theo số đo lần trước. Giữ bởi: `tests/test_run_tests.py`. Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Số đo 04/11/2026 (140 test, máy 12 lõi, thời gian in ở cuối `run_tests.py`): tuần tự 1482 s; `--jobs 4` 761–878 s (3 lần), 506 s sau khi cắt thời gian chết ở 5 test chậm nhất. Khi chạy 4 tiến trình CPU đã ~80–90%, nên thêm tiến trình không nhanh hơn.
  - Lượt chạy 04/11/2026 tối (`--jobs 4`): cả bộ 144 test 527 s; 141 test trên cây tạm 375 s (tổng thời gian từng test 1332 s, ×3,6 so với một tiến trình).
  - Sau mỗi lần chạy in 15 test chậm nhất và ghi `outputs/test-times.json` (`gitignore`; lần chạy một phần chỉ cập nhật test đã chạy). Đo trước khi tối ưu một test.
- Một máy chỉ chạy một bộ một lúc: runner giữ tệp khoá `print_sku_run_tests.lock` trong thư mục `.git` chung của mọi worktree (đổi bằng biến `PRINT_SKU_TEST_LOCK`); phiên đến sau chờ tối đa `--lock-wait` giây (mặc định 1800) rồi thoát mã 3 kèm PID, cây, lệnh của phiên đang chạy. Giữ bởi: `tests/test_run_tests.py`. Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Khoá chết (tiến trình chủ không còn, hoặc 2 phút không cập nhật) tự bị phá. `--no-lock` bỏ qua khoá: chỉ dùng khi chạy vài test nhỏ (`--only`) và chấp nhận máy chậm hơn.
- Test phải chạy song song được: không ghi tệp / thư mục tạm cùng tên (dùng `mkdtempSync` / `tempfile`), không mở cổng cố định, không gắn cứng cổng 8000 (đọc `BASE`). Kiểm 04/11/2026: không test nào ghi tệp chung hay mở cổng. Giữ bởi: chưa có (đọc mã). Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Thời gian thật của trang (hẹn giờ, ngưỡng "cũ sau 3 giây") thì dời đồng hồ trang (`context.clock`, dời `Date.now`) thay vì `waitForTimeout`; chờ giao diện yên bằng `tests/page_settle.cjs`.
  - Một `waitForFunction` có điều kiện không bao giờ đúng bị `.catch(() => {})` nuốt sẽ ngủ trọn 30 s (đã gặp ở `sku_queue_browser`: 60 s mỗi lần chạy).
- Cây chính giữ cổng 8000; worktree của agent chạy cả bộ bằng `--port <cổng khác>` (runner mở máy chủ ở cổng đó và đặt `BASE`, `APP_URL`). Runner cảnh báo khi máy chủ ở cổng đang chạy phục vụ `index.html` khác cây này (worktree dùng nhầm cổng 8000 của cây chính). Nguồn: (16–17/10 · N0890, N1001; 25/10 · N1211); `docs/plans/2026-11-04-tang-toc-bo-test.md`
- `python scripts/run_tests.py --help` lỗi mã hoá trên console cp1252 (có sẵn từ trước); dùng `python -X utf8 scripts/run_tests.py --help`. Nguồn: (04/11 · N20261104-2123)
- Test chập chờn đã biết (không do tính năng): `print_devices_browser`, `sku_catalog_race_browser`, `group_uid_mockup`, `find_sku_mobile`, `sku_catalog_screens_browser` (đạt khi chạy riêng, hỏng khi nhiều trình duyệt chạy cùng lúc ở bước "mã không có trên máy → hỏi máy chủ"; chưa rõ nguyên nhân gốc). Nguồn: (12–23/10 · N0591, N0937, N1028, N1166); `docs/plans/2026-11-04-tang-toc-bo-test.md`
- Test hỏng: phân loại lỗi thật do thay đổi / test cũ lệch hành vi đã chốt / chập chờn; kiểm trên HEAD không có thay đổi trước khi kết luận "không do đợt này". Nguồn: `docs/DOI_AGENT.md` (`kiem-thu`); (25/10 · N1211)

## Dọn sau khi chạy test

- Runner tự dọn phần của nó: tắt máy chủ tĩnh nó mở (khối `finally`), giết cả cây tiến trình của test quá giờ hoặc bị huỷ (`kill_tree`), nhả khoá. Lượt chạy bình thường không phải dọn tay. Giữ bởi: chưa có (đọc mã `scripts/run_tests.py`). Nguồn: (04/11 · N20261104-2123)
- Máy chủ tĩnh bật tay (`python -m http.server <cổng>`, dùng với `--no-server`) thì tự tắt khi xong việc; trước khi kết thúc phiên liệt kê tiến trình có `http.server` trong dòng lệnh (`Get-CimInstance Win32_Process`) và tắt cái của mình. Nguồn: (04/11 · N20261104-2123: một `http.server 8000` bật tay từ 19:22 còn sống sau khi mọi phiên xong)
  - Máy chủ không rõ chủ, hoặc của phiên khác: hỏi người dùng trước khi tắt (phiên khác có thể đang dùng cổng 8000).
- Cây tạm / worktree dựng để kiểm: xoá khi xong. Có junction `node_modules` thì gỡ trước bằng `cmd /c rmdir <đường dẫn junction>` (hoặc kiểm `Get-ChildItem -Recurse -Force -Attributes ReparsePoint` ra 0 mục) rồi mới `Remove-Item -Recurse`; không xoá đệ quy cây còn junction vì có thể chạm `node_modules` thật. Nguồn: (04/11 · N20261104-2123)
- `outputs/` (gitignore) giữ log và báo cáo cũ (04/11: 84 MB), `tmp/` giữ ảnh chụp (4,8 MB): chưa có luật dọn, chỉ dọn khi người dùng bảo; luôn giữ `outputs/test-times.json` và các sao lưu ngoài git (vd. `outputs/sample_bags_backup_2026-10-11.csv`). Nguồn: (04/11 · N20261104-2123)

## Kiểm commit chỉ chứa một phần cây làm việc

- Nhiều phiên cùng sửa `index.html` và commit chỉ lấy hunk của mình: sau khi stage, kiểm `git show :<tệp>` không còn dấu của phần phiên kia, rồi chạy test của bậc đã chọn (05/11 · N20261105-0800, N20261105-0915). Nguồn: (04/11 · N20261104-2123)
  - Bậc 3 chạy trên đúng nội dung đã stage: `git checkout-index -a -f --prefix=<thư mục ngoài repo>/`, vào đó `python -X utf8 scripts/run_tests.py --port <cổng khác> --no-lock`.
  - Số test = số test đã nằm trong commit (test chưa theo dõi của phiên kia không có mặt); cổng khác 8000 để không đụng máy chủ cây chính.
  - Cây tạm không có `node_modules`: `a11y_axe_browser` và `cut_adj_reconcile_browser` báo "Chưa có axe-core" (không phải lỗi mã). Nối junction `node_modules` của cây chính, chạy lại hai test đó bằng `--only`, rồi gỡ junction (mục trên).
  - Cách tách hunk dùng được: `git diff -U3 <tệp>` ra bản vá, lọc hunk theo nội dung từng hunk (đọc, không đoán theo số thứ tự), `git apply --cached --check --recount <bản vá lọc>` rồi áp thật; cách khác `GIT_INDEX_FILE` ở `docs/QUYET_DINH.md` mục "Git khi nhiều phiên cùng sửa".

## Commit

- Test của bậc đã chọn đạt (dòng `Phạm vi test:`) + `commit_gate` đạt thì lead tự commit + push, không chờ người dùng bảo (05/11 · N20261105-0800, N20261105-0915); push vẫn theo mục cuối (migration trước push); commit theo đợt; yêu cầu phát sinh giữa đợt đi commit riêng (trừ khi người dùng bảo gộp). Nguồn: `AGENTS.md`; (18/10 · N1046, N1075)
- Thông điệp tiếng Việt không dấu, dòng đầu tóm tắt việc + phiên bản nếu có (vd. `Extension 0.10.7: …`). Nguồn: `docs/CONTEXT_MAP.md` mục 6; (25/10 · N20261025-2108)
- Trước commit: `python scripts/commit_gate.py --cached` phải in "Đủ điều kiện commit" (bí mật, dữ liệu thật, mojibake, `diff --check`, đổi CRLF cả tệp, phiên bản Extension, CDN / npm, cảnh báo bản đồ). Hook tự chạy cổng này với mọi `git commit`; `/commit-push` chỉ người dùng gọi. Nguồn: (18/10 · N1023, N1024); `docs/DOI_AGENT.md` bước 4
- `commit_gate` còn cảnh báo, chưa chặn: dòng tài liệu > 400 ký tự, hàm `SECURITY DEFINER` thiếu `search_path` / `revoke`, mã nhật ký không có thẻ, thông điệp có dấu (`--message-file <tệp>` hoặc `--commit <sha>`). Nguồn: (25/10 · N20261025-2144)
- Push `main` = web lên ngay; web cần hàm / Edge mới thì commit chưa push, chờ migration / deploy. Nguồn: `AGENTS.md` luật 4

## Nhiều phiên cùng sửa

- Commit chỉ phần của mình: dựng chỉ mục tạm (`GIT_INDEX_FILE`) = HEAD + script phát lại + tệp của đợt; không `git add index.html` cả tệp; sau commit so `git show HEAD:index.html` và đồng bộ chỉ mục thật (`git reset -q -- <tệp>`); nhắn phiên kia vùng mình đụng. Nguồn: (10–23/10 · N0032, N0037, N0625, N0714, N0777, N1170)
- Commit bằng `git commit -- <đường dẫn>` hoặc chỉ mục tạm; không xâu commit + push trong một lệnh; không `reset --soft` khi phiên khác có thể vừa commit. Nguồn: (11–21/10 · N0032, N0858, N1107, N1108)
- Lỡ commit lẫn phần phiên khác mà nội dung đúng: không viết lại lịch sử, không force-push. Nguồn: như trên.
- `git status` trước khi gộp; không stage tệp của phiên khác, tệp chưa theo dõi của phiên khác để nguyên. Nguồn: `docs/DOI_AGENT.md` trước 25/10; (10–23/10 · N0032, N0037)
