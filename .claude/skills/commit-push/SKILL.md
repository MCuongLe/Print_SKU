---
name: commit-push
description: Commit đúng các tệp của đợt việc vừa xong rồi push lên main (deploy web GitHub Pages), theo luật dự án Print_SKU. Người dùng gọi (/commit-push) khi muốn chạy đủ các bước; lead vẫn tự commit + push theo AGENTS.md luật 3 mà không cần lệnh này.
disable-model-invocation: true
---

# Commit và push đợt việc vừa xong

Người dùng gọi `/commit-push` (tương đương câu "commit và push"). Luật nguồn: `AGENTS.md` luật 3–4 và `docs/chuan/KIEM_THU_GIT.md`. Push `main` = web lên ngay, nên làm đủ các bước, không bỏ bước nào.

## 1. Xác định tệp của đợt
- `git status --short` và `git diff --stat`. Chỉ lấy tệp (và hunk) thuộc đợt việc vừa làm; tệp chưa theo dõi hay phần của phiên khác KHÔNG đưa vào — liệt kê riêng cho người dùng. Tách hunk: `docs/chuan/KIEM_THU_GIT.md` mục "Nhiều phiên cùng sửa".
- Không có gì để commit: báo rõ (kèm `git status -sb` cho thấy main đã khớp origin) và dừng.

## 2. Test theo bậc
- Phạm vi test theo bốn bậc ở `docs/chuan/KIEM_THU_GIT.md` mục "Chạy test" (lead Fable / Opus quyết; phiên Sonnet chỉ làm bậc 0). Chưa có kết quả của chính trạng thái này thì chạy đúng bậc đó; cả bộ chỉ khi đợt thuộc bậc 3.
- Ghi dòng `Phạm vi test:` (bậc · test đã chạy kèm dòng PASS nguyên văn · lý do không chạy phần còn lại). Test hỏng thật → dừng, báo người dùng, không commit. Mục CHẬP CHỜN → ghi vào báo cáo.

## 3. Migration trước push (luật 4)
- Web cần hàm SQL / cột / action Edge mới chưa lên: commit (chưa push) → `python scripts/apply_supabase_sql.py <tệp> --dry-run` rồi chạy thật → `python scripts/deploy_<tên>.py --dry-run` rồi chạy thật → Reload Extension (người dùng làm) → cài agent + in thử nếu đổi mẫu tem → push.
- Lệnh phá huỷ (`--allow-destructive`, DROP / DELETE / TRUNCATE) cần người dùng cho phép rõ từng lần. Bước nào chưa làm được thì commit, KHÔNG push, báo người dùng bước còn chờ.
- Migration đã chạy: kiểm bằng truy vấn chỉ đọc; sau commit ghi sổ `python scripts/record_ledger.py supabase/<tệp>.sql`.
- `python scripts/release.py --plan` (chỉ đọc) dùng được để xem việc còn chờ; Claude không chạy `release.py --apply` (`docs/QUYET_DINH.md` chủ đề 9).

## 4. Commit
- Stage đúng từng tệp / hunk (không `git add -A`), rồi `python scripts/commit_gate.py --cached` phải in "Đủ điều kiện commit". Hook PreToolUse trong `.claude/settings.json` cũng tự chạy cổng này khi gặp `git commit` trong lệnh Bash hoặc PowerShell.
- Thông điệp tiếng Việt không dấu, dòng đầu tóm hành vi người dùng thấy; các dòng sau: khối / tệp chính, review đã xử lý gì, dòng `Phạm vi test:`. Kết bằng dòng attribution theo hướng dẫn của phiên.

## 5. Push và ghi nhận
- `git push` (lệnh riêng, không xâu với commit), rồi `git status -sb` xác nhận khớp origin.
- Thêm mục nhật ký ở CUỐI `C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md`, mở bằng mã `[N<yyyymmdd>-<hhmm>]` (giờ Việt Nam) theo khuôn `docs/chuan/TAI_LIEU.md` mục 4: quyết định, `Phạm vi test:`, commit đã push, điều chưa kiểm thật.
- Báo người dùng bằng tiếng Việt: mã commit, web cập nhật sau vài phút, việc cần làm thêm (Reload Extension, tải lại tab Inside/WMS, cài agent), tệp còn lại ngoài commit.
