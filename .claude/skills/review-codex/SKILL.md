---
name: review-codex
description: Gửi thay đổi (một commit, cây làm việc, hoặc bộ ảnh chụp màn) cho Codex CLI review độc lập ở chế độ chỉ đọc, rồi lọc kết quả theo quyết định đã chốt của dự án. Dùng trước khi commit thay đổi SQL, Edge Function, Extension, luồng in/quyền, hoặc sau khi dựng xong một màn mới.
---

# Review độc lập bằng Codex

Vòng review thứ hai bằng mô hình khác họ, sau `/code-review` nội bộ. Codex chỉ nhận xét; lead xử lý.

## Khi nào
- Trước commit: thay đổi `supabase/*.sql`, `supabase/functions/*`, `extension/inside-po-connector/*`, luồng `print_*`, quyền.
- Sau khi màn mới hoặc sửa lớn chạy được: review giao diện bằng ảnh chụp 1280/1440 (Admin) hoặc 390/1280 (trang chủ).
- Bỏ qua cho tài liệu, test, sửa giao diện nhỏ.

## Cách chạy
1. Kiểm tra `codex --version` (chưa có thì nhờ người dùng cài: `npm install -g @openai/codex@latest`, đăng nhập bằng `codex login`).
2. Chuẩn bị bối cảnh: bản giao việc hoặc 5–10 dòng mô tả màn/luồng, ghi vào một tệp Markdown tạm trong thư mục scratchpad của phiên. Liệt kê rõ QUYẾT ĐỊNH ĐÃ CHỐT liên quan (lấy từ RULES.md) để Codex không báo nhầm.
3. Chạy một trong:
   - `python scripts/codex_review.py --commit <sha> --brief <tệp.md> --keywords "<từ khoá RULES>"`
   - `python scripts/codex_review.py --working-tree --brief <tệp.md>`
   - `python scripts/codex_review.py --images <thư mục ảnh> --brief <tệp.md>` (ảnh chụp bằng Playwright với dữ liệu giả, đặt tên theo thứ tự muốn Codex đọc).
   Kết quả ghi ở `outputs/codex-review/review-<ngày giờ>.md` (thư mục outputs không vào git) và in ra màn hình. Mỗi lượt khoảng 2–5 phút.
4. Lọc: với từng phát hiện, đối chiếu mã thật và RULES.md; xếp vào ba nhóm: sửa ngay, ghi nhận làm sau, trái quyết định đã chốt (bỏ qua, ghi lý do). Ghi kết quả lọc vào RULES.md theo mẫu "Review … bằng Codex (ngày)".
5. Báo người dùng bảng ba nhóm; chỉ sửa khi người dùng đồng ý hoặc khi bản giao việc đã cho phép.

## Giới hạn đã biết
- Codex không chạy được Inside/WMS/máy in/Supabase thật; không chạy được test cần tạo thư mục tạm trong sandbox (EPERM) — không phải lỗi của thay đổi.
- `index.html` quá lớn: luôn gửi diff hoặc ảnh, không gửi cả tệp.
- Không đưa `.env`, token, mã SKU thật vào prompt hay ảnh.
