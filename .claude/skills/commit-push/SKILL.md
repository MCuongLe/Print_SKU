---
name: commit-push
description: Commit đúng các tệp của đợt việc vừa xong rồi push lên main (deploy web GitHub Pages), theo luật dự án Print_SKU. Chỉ người dùng gọi (/commit-push), vì push là deploy.
disable-model-invocation: true
---

# Commit và push đợt việc vừa xong

Người dùng gọi `/commit-push` (tương đương câu "commit và push"). Push `main` = deploy web ngay, nên làm đủ các bước, không bỏ bước nào.

## 1. Xác định tệp của đợt
- `git status --short` và `git diff --stat`. Chỉ lấy tệp thuộc đợt việc vừa làm trong phiên; tệp chưa theo dõi hay tệp của phiên khác (xem RULES.md, ghi chú "phiên khác") thì KHÔNG đưa vào — liệt kê riêng cho người dùng.
- Không có gì để commit: báo rõ (kèm `git status -sb` cho thấy main đã khớp origin) và dừng.

## 2. Điều kiện trước khi commit
- Đợt có đổi hành vi / mã: phải có kết quả `python scripts/run_tests.py --no-server` (cả bộ) của chính trạng thái này trong phiên. Chưa có thì chạy nền, chờ xong. Test hỏng thật → dừng, báo người dùng, không commit. Mục CHẬP CHỜN → ghi vào thông điệp commit và báo cáo.
- Đợt chỉ tài liệu / cấu hình: bỏ qua bộ test, nói rõ vì sao.
- **Migration trước push**: web cần hàm SQL / cột / action Edge mới mà migration hoặc deploy Edge chưa chạy → chạy theo luật `AGENTS.md` (lead được tự chạy `python scripts/apply_supabase_sql.py <tệp>` / `python scripts/deploy_<tên>.py`, dry-run trước; lệnh phá huỷ hỏi người dùng) rồi mới push; không chạy được thì commit nhưng KHÔNG push và nhắc người dùng.
  - Migration đã chạy trực tiếp: sau commit ghi sổ bằng `python scripts/record_ledger.py supabase/<tệp>.sql`.
- **Có `scripts/release.py`:** trước khi push chạy `python scripts/release.py --plan` (chỉ đọc). Còn việc chờ (migration, Edge, Extension) thì dừng ở commit và gợi ý người dùng chạy `python scripts/release.py --apply` (script giữ thứ tự và là bên push); không tự push.

## 3. Commit
- `git add <đúng từng tệp>` (không `git add -A`), rồi `python scripts/commit_gate.py --cached` phải in "Đủ điều kiện commit". (Hook PreToolUse trong `.claude/settings.json` cũng tự chạy cổng này khi gặp `git commit` và chặn nếu KHÔNG ĐẠT.)
- Thông điệp không dấu (như các commit trước), dòng đầu tóm hành vi người dùng thấy; các dòng sau: khối/tệp chính, Codex đã xử lý gì, kết quả test (số PASS, thời gian, test chập chờn). Kết bằng dòng attribution theo hướng dẫn của phiên.

## 4. Push và ghi nhận
- `git push`, rồi `git status -sb` xác nhận khớp origin.
- Thêm một dòng vào `C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md`: ngày, "ĐÃ commit + push <sha>", câu người dùng, kết quả test, điều chưa kiểm thật.
- Báo người dùng bằng tiếng Việt: mã commit, web cập nhật sau vài phút, việc cần làm thêm (Reload Extension, tải lại tab Inside/WMS nếu đợt có đổi Extension), tệp còn lại ngoài commit.
