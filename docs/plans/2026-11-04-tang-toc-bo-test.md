# Tăng tốc bộ test (2026-11-04)

Trạng thái (04/11/2026): **ĐÃ LÊN `main` — commit `cd8f117`** (cherry-pick từ nhánh `claude/trusting-yonath-5b13fd`, commit `786c38d`). Cả bộ `--jobs 4`: 1482 s → 506 s, 140/140 PASS (số do phiên làm báo, chạy trong worktree). Lead kiểm lại trên cây chính: 26 test đơn vị của runner OK, `--only rfid --jobs 2` 4/4 PASS kèm bảng thời gian.

## Thiết kế
- **Yêu cầu:** "Hiện tại tôi thấy luồng test khá lâu, có phương án nào cải thiện tốc độ không." → "Đợi phiên xả vải test xong mới làm phần tăng tốc độ test."
- **Kết quả nhìn thấy được:** `python scripts/run_tests.py` chạy nhanh hơn nhiều với cùng 142 test; có cờ chọn test liên quan khi đang làm; nhiều phiên không còn chạy chồng cả bộ.
- **Đã chốt với người dùng:** thứ tự làm = sau khi phiên xả vải báo xong bộ test cuối (kể cả `commit_gate`). Chưa chốt chi tiết kỹ thuật (số tiến trình, cách khoá): phiên làm đề xuất rồi báo.
- **Số đo thật** (04/11/2026, `run_tests.py` chạy nền): 142 test, 2026 giây (~34 phút), tuần tự từng tệp (vòng `for path in files`), khi 2–3 phiên cùng chạy test; một mình ~20 phút. Hỏng 3 / 142 (`design_tokens_ratchet`, `floor_access_browser` do pop-up xả vải; `sku_catalog_screens_browser` chập chờn), hai mục đầu đã sửa.
  - Máy: 12 lõi, 15,7 GB RAM. Loại test: 76 trình duyệt (mỗi test tự mở Chrome), 27 SQL tĩnh, 15 core, 4 Edge `.mjs`, 2 Extension, 21 tệp khác; ~18 test có `sleep` / hẹn giờ ≥ 3 s.
  - Chưa có thời gian từng test (bản chạy nền chỉ lưu phần đuôi) → bước đầu là đo.
- **Rủi ro và cách chặn:**
  - Test nhạy thời gian chập chờn khi chạy song song → giữ bước chạy lại tuần tự lần 2; `--jobs 1` = hành vi cũ.
  - Test dùng chung tệp / cổng / thư mục tạm → kiểm trước khi song song, đánh dấu "chạy riêng" nếu không an toàn.
  - Chọn test theo thay đổi (`--changed`) bỏ sót → luôn chạy CẢ BỘ trước khi báo xong (`AGENTS.md` mục Kiểm chứng); không map được thì chạy cả bộ.
- **Chưa kiểm được bằng máy:** số tiến trình tối ưu trên máy người dùng; ảnh hưởng của nhiều phiên cùng chạy.

## Kế hoạch
Thứ tự chạy: điều kiện bắt đầu → Việc 1 (đo) → Việc 2 (song song) → Việc 3 (khoá) → Việc 4 (`--changed`) → Việc 5 (cắt thời gian chết) → Việc 6 (tài liệu).

### Điều kiện bắt đầu · lead · [x]
- [x] Phiên `local_9fca609b-bc9e-4146-a1a1-11b1b6a1e58c` (Xả vải: pop-up nhập mét) báo xong cả bộ test cuối và `commit_gate`; khi nhận ghi chú đó, lead báo người dùng và bấm thẻ `task_0ce4b715` (người dùng đã cho phép làm sau mốc này). Xong 04/11 ~16:50: người dùng bảo "tiến hành làm kế hoạch tăng tốc bộ test", lead bấm thẻ.

### Việc 1 — Đo · phiên `tang-toc-test` · [x]
- Tệp và neo: `scripts/run_tests.py` → vòng `for path in files:`.
- [x] In bảng thời gian từng test + 15 test chậm nhất, ghi `outputs/test-times.json`; chạy một lần lấy số thật.

### Việc 2 — Chạy song song · phiên `tang-toc-test` · [x]
- [x] Cờ `--jobs N` (đề xuất mặc định 4, tối đa theo lõi), mỗi test một tiến trình, giữ chạy lại tuần tự lần 2; `--jobs 1` giống cũ.
- [x] Kiểm tài nguyên dùng chung (tệp ghi chung, cổng cố định, `outputs/`, thư mục tạm); sửa hoặc đánh dấu chạy riêng.
- [x] Cả bộ `--jobs 4`: cùng 142 test PASS (cùng tập chập chờn như trước), kèm số thời gian trước / sau.

### Việc 3 — Một bộ một lúc · phiên `tang-toc-test` · [x]
- [x] Tệp khoá (PID + thời điểm, tự bỏ khoá chết); phiên thứ hai chờ hoặc báo rõ; `--no-lock` cho `--only`.

### Việc 4 — Chọn test liên quan (`--changed`) · phiên `tang-toc-test` · [x]
- [x] Đọc `git diff` (kể cả tệp chưa theo dõi), chọn test theo `docs/PROJECT_MAP.md` mục 4; `index.html` đổi thì kèm nhóm test chuẩn giao diện; không map được thì chạy cả bộ.

### Việc 5 — Cắt thời gian chết · phiên `tang-toc-test` · [x]
- [x] 5 test chậm nhất theo số đo: thay `sleep` cố định bằng chờ điều kiện / thu nhỏ hẹn giờ, không đổi điều khẳng định.

### Việc 6 — Tài liệu · phiên `tang-toc-test` · [x]
- [x] `docs/chuan/KIEM_THU_GIT.md`, lệnh ở `docs/PROJECT_MAP.md` mục 5; nhật ký `RULES.md`.
- [x] Dòng nhắc commit kèm danh sách tệp khi xong.

## Phát sinh
- 04/11 `python scripts/run_tests.py --help` báo UnicodeEncodeError trên console Windows cp1252 (cấu hình luồng UTF-8 chạy sau `parse_args`): chạy `python -X utf8 scripts/run_tests.py --help` hoặc sửa nhỏ sau · commit riêng.

## Lệch kế hoạch
- (chưa có)

## Nhật ký
- 2026-11-04 ~16:50 Phiên xả vải báo 143/143 + `commit_gate` đạt, người dùng đang commit / push; lead bấm thẻ, phiên `local_524bb97a-4eee-4937-8b19-bf1dfa79fa76` bắt đầu.
- 2026-11-04 Lập kế hoạch từ câu hỏi của người dùng; thẻ `task_0ce4b715` tạo nhưng chờ; người dùng bảo đợi phiên xả vải test xong rồi mới làm.
- 2026-11-04 ~19:10 Phiên `local_524bb97a-4eee-4937-8b19-bf1dfa79fa76` xong, push nhánh `claude/trusting-yonath-5b13fd` (`786c38d`); người dùng bảo commit + push → lead cherry-pick lên `main` (`cd8f117`, không có hunk phiên khác), kiểm lại như mục Trạng thái, push `main`.
  - Việc 1–6 tích theo mô tả commit (`--jobs`, bảng thời gian + `outputs/test-times.json`, khoá, `--changed`, cắt thời gian chết ở 5 test, tài liệu); lead chưa tự thử khoá và `--changed`.
  - `QUYET_DINH.md` ghi lúc 21:23 (dòng dưới). Nhánh `claude/trusting-yonath-5b13fd` còn trên origin, chưa xoá.
- 2026-11-04 21:23 Người dùng bảo ghi nhớ phần test cho các phiên sau: lead ghi `docs/chuan/KIEM_THU_GIT.md` ("Dọn sau khi chạy test", "Kiểm commit chỉ chứa một phần cây làm việc"), `docs/QUYET_DINH.md` "Test và dữ liệu", `AGENTS.md` kiểm chứng 2; nhật ký `N20261104-2123`. Chưa commit.
