# Chuẩn kiểm thử và git (25/10/2026)

Áp cho: test trong `tests/`, commit, push. Đọc khi: viết / sửa test, chạy cả bộ, commit khi nhiều phiên cùng sửa.
Gom từ `docs/QUYET_DINH.md` chủ đề 1, `docs/DOI_AGENT.md`, `docs/CONTEXT_MAP.md` mục 6; không có luật mới. Luật nền (bốn luật cứng, kiểm chứng, bàn giao): `AGENTS.md`. Lệnh chạy: `docs/PROJECT_MAP.md` mục 5.

## Viết test

- Test đỏ trước bắt buộc khi sửa lỗi và khi đổi logic (SQL, Edge, Extension, hàm tính, luồng in / quyền); giao diện được viết test cùng lúc với mã nhưng test phải khẳng định hành vi mới. Nguồn: `docs/DOI_AGENT.md` bước 2; (18/10 · N1013, N1038)
- Sửa lỗi: test tái hiện lỗi phải đỏ trên bản chưa sửa rồi mới sửa. Nguồn: `docs/DOI_AGENT.md` "Quy trình sửa lỗi"
- Mock / test giả dựng theo một mẫu phản hồi thật (chỉ đọc) của đúng lời gọi: tên khoá, kiểu, định dạng mã; giá trị thay bằng dữ liệu giả; mẫu thật không vào repo. Nguồn: `docs/DOI_AGENT.md` bước 1; (25/10 · N1210)
- Dữ liệu giả chuẩn: SKU `9000000xx`, Group UID `1028260000000xxx` (fixture cũ `9999991000000001` giữ nguyên), số phiếu / PO `100000001`; không SKU / UID / PO thật. Giữ bởi: `commit_gate` (dữ liệu thật). Nguồn: (17/10 · N0920, N1001); `docs/DOI_AGENT.md` trước 25/10
- Test trình duyệt đọc `BASE` (mặc định `http://127.0.0.1:8000/`), Playwright nạp qua `PLAYWRIGHT_MODULE`. Nguồn: (10–23/10 · N0068, N0883, N1175)
- Test Python đặt tên `tests/test_<tên>.py` (unittest, không gọi mạng); `run_tests.py` chạy cùng cả bộ. Nguồn: (25/10 · N20261025-2144)

## Chạy test

- Trong lúc làm chỉ chạy test liên quan: `node tests/<tên>`, `run_tests.py --only <tên>` hoặc `run_tests.py --changed` (xem dưới). Nguồn: `docs/DOI_AGENT.md` bước 2; `docs/plans/2026-11-04-tang-toc-bo-test.md`
- `--changed [REF]` chọn test theo `git diff` so với REF (mặc định `HEAD`, kèm tệp chưa theo dõi); `--list` chỉ in danh sách, không chạy. Không thay được cả bộ trước khi báo xong. Giữ bởi: `tests/test_run_tests.py`. Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Chọn test nhắc tên tệp đổi (runner quét chuỗi tên tệp trong mã test), test nhắc id khối `index.html` có dòng đổi, và luôn bộ chuẩn giao diện khi `index.html` đổi.
  - Có tệp đổi không map được (kể cả khối `index.html` không test nào nhắc) thì chạy cả bộ; `docs/`, `*.md`, `.claude/`, `workstation-agent/` (bộ test riêng `node --test`) không ép chạy gì.
- Trước khi báo xong: cả bộ `python scripts/run_tests.py` một lần, chạy nền; script tự chạy lại test hỏng một lần, tuần tự, và in mục CHẬP CHỜN — chép mục đó vào báo cáo. Nguồn: `docs/DOI_AGENT.md` bước 4; (10–23/10 · N0068, N0883, N1175)
  - Mặc định 4 tiến trình song song (`--jobs N`, tối đa theo số lõi; `--jobs 1` = tuần tự từng tệp như bản cũ); mỗi test một tiến trình riêng, kết quả in theo thứ tự hoàn thành, test dài chạy trước theo số đo lần trước. Giữ bởi: `tests/test_run_tests.py`. Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Số đo 04/11/2026 (140 test, máy 12 lõi, thời gian in ở cuối `run_tests.py`): tuần tự 1482 s; `--jobs 4` 761–878 s (3 lần), 506 s sau khi cắt thời gian chết ở 5 test chậm nhất. Khi chạy 4 tiến trình CPU đã ~80–90%, nên thêm tiến trình không nhanh hơn.
  - Sau mỗi lần chạy in 15 test chậm nhất và ghi `outputs/test-times.json` (`gitignore`; lần chạy một phần chỉ cập nhật test đã chạy). Đo trước khi tối ưu một test.
- Một máy chỉ chạy một bộ một lúc: runner giữ tệp khoá `print_sku_run_tests.lock` trong thư mục `.git` chung của mọi worktree (đổi bằng biến `PRINT_SKU_TEST_LOCK`); phiên đến sau chờ tối đa `--lock-wait` giây (mặc định 1800) rồi thoát mã 3 kèm PID, cây, lệnh của phiên đang chạy. Giữ bởi: `tests/test_run_tests.py`. Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Khoá chết (tiến trình chủ không còn, hoặc 2 phút không cập nhật) tự bị phá. `--no-lock` bỏ qua khoá: chỉ dùng khi chạy vài test nhỏ (`--only`) và chấp nhận máy chậm hơn.
- Test phải chạy song song được: không ghi tệp / thư mục tạm cùng tên (dùng `mkdtempSync` / `tempfile`), không mở cổng cố định, không gắn cứng cổng 8000 (đọc `BASE`). Kiểm 04/11/2026: không test nào ghi tệp chung hay mở cổng. Giữ bởi: chưa có (đọc mã). Nguồn: `docs/plans/2026-11-04-tang-toc-bo-test.md`
  - Thời gian thật của trang (hẹn giờ, ngưỡng "cũ sau 3 giây") thì dời đồng hồ trang (`context.clock`, dời `Date.now`) thay vì `waitForTimeout`; chờ giao diện yên bằng `tests/page_settle.cjs`.
  - Một `waitForFunction` có điều kiện không bao giờ đúng bị `.catch(() => {})` nuốt sẽ ngủ trọn 30 s (đã gặp ở `sku_queue_browser`: 60 s mỗi lần chạy).
- Cây chính giữ cổng 8000; worktree của agent chạy cả bộ bằng `--port <cổng khác>` (runner mở máy chủ ở cổng đó và đặt `BASE`, `APP_URL`). Runner cảnh báo khi máy chủ ở cổng đang chạy phục vụ `index.html` khác cây này (worktree dùng nhầm cổng 8000 của cây chính). Nguồn: (16–17/10 · N0890, N1001; 25/10 · N1211); `docs/plans/2026-11-04-tang-toc-bo-test.md`
- Test chập chờn đã biết (không do tính năng): `print_devices_browser`, `sku_catalog_race_browser`, `group_uid_mockup`, `find_sku_mobile`, `sku_catalog_screens_browser` (đạt khi chạy riêng, hỏng khi nhiều trình duyệt chạy cùng lúc ở bước "mã không có trên máy → hỏi máy chủ"; chưa rõ nguyên nhân gốc). Nguồn: (12–23/10 · N0591, N0937, N1028, N1166); `docs/plans/2026-11-04-tang-toc-bo-test.md`
- Test hỏng: phân loại lỗi thật do thay đổi / test cũ lệch hành vi đã chốt / chập chờn; kiểm trên HEAD không có thay đổi trước khi kết luận "không do đợt này". Nguồn: `docs/DOI_AGENT.md` (`kiem-thu`); (25/10 · N1211)

## Commit

- Chỉ commit / push khi người dùng nói; commit theo đợt; yêu cầu phát sinh giữa đợt đi commit riêng (trừ khi người dùng bảo gộp). Nguồn: `AGENTS.md`; (18/10 · N1046, N1075)
- Thông điệp tiếng Việt không dấu, dòng đầu tóm tắt việc + phiên bản nếu có (vd. `Extension 0.10.7: …`). Nguồn: `docs/CONTEXT_MAP.md` mục 6; (25/10 · N20261025-2108)
- Trước commit: `python scripts/commit_gate.py --cached` phải in "Đủ điều kiện commit" (bí mật, dữ liệu thật, mojibake, `diff --check`, đổi CRLF cả tệp, phiên bản Extension, CDN / npm, cảnh báo bản đồ). Hook tự chạy cổng này với mọi `git commit`; `/commit-push` chỉ người dùng gọi. Nguồn: (18/10 · N1023, N1024); `docs/DOI_AGENT.md` bước 4
- `commit_gate` còn cảnh báo, chưa chặn: dòng tài liệu > 400 ký tự, hàm `SECURITY DEFINER` thiếu `search_path` / `revoke`, mã nhật ký không có thẻ, thông điệp có dấu (`--message-file <tệp>` hoặc `--commit <sha>`). Nguồn: (25/10 · N20261025-2144)
- Push `main` = web lên ngay; web cần hàm / Edge mới thì commit chưa push, chờ migration / deploy. Nguồn: `AGENTS.md` luật 4

## Nhiều phiên cùng sửa

- Commit chỉ phần của mình: dựng chỉ mục tạm (`GIT_INDEX_FILE`) = HEAD + script phát lại + tệp của đợt; không `git add index.html` cả tệp; sau commit so `git show HEAD:index.html` và đồng bộ chỉ mục thật (`git reset -q -- <tệp>`); nhắn phiên kia vùng mình đụng. Nguồn: (10–23/10 · N0032, N0037, N0625, N0714, N0777, N1170)
- Commit bằng `git commit -- <đường dẫn>` hoặc chỉ mục tạm; không xâu commit + push trong một lệnh; không `reset --soft` khi phiên khác có thể vừa commit. Nguồn: (11–21/10 · N0032, N0858, N1107, N1108)
- Lỡ commit lẫn phần phiên khác mà nội dung đúng: không viết lại lịch sử, không force-push. Nguồn: như trên.
- `git status` trước khi gộp; không stage tệp của phiên khác, tệp chưa theo dõi của phiên khác để nguyên. Nguồn: `docs/DOI_AGENT.md` trước 25/10; (10–23/10 · N0032, N0037)
