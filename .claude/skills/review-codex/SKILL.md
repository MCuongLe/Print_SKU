---
name: review-codex
description: Gửi thay đổi (một commit, cây làm việc, hoặc bộ ảnh chụp màn) cho Codex CLI review độc lập ở chế độ chỉ đọc, rồi lọc kết quả theo quyết định đã chốt của dự án. Dùng trước khi commit thay đổi SQL, Edge Function, Extension, luồng in/quyền, hoặc sau khi dựng xong một màn mới.
---

# Review độc lập bằng Codex

Review chất lượng độc lập bằng mô hình khác họ (bước 5 của `docs/DOI_AGENT.md`), sau khi các việc đã qua soát đặc tả của `kiem-thu`. Có thể chạy thêm `/code-review` trước nếu muốn, nhưng không bắt buộc. Codex chỉ nhận xét; lead xử lý.

## Khi nào
- Trong quy trình việc Lớn (`docs/DOI_AGENT.md` bước 5): sau khi mọi việc đã qua soát đặc tả, trước cổng cuối; truyền tệp kế hoạch làm `--brief`. Tối đa hai vòng.
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
   Kết quả ghi ở `outputs/codex-review/review-<ngày giờ>.md` (thư mục outputs không vào git) hoặc tệp chỉ định bằng `--out`, và in ra màn hình. Mỗi lượt khoảng 2–15 phút.
4. Lọc: với từng phát hiện, đối chiếu mã thật và RULES.md; xếp vào ba nhóm: sửa ngay, ghi nhận làm sau, trái quyết định đã chốt (bỏ qua, ghi lý do). Ghi kết quả lọc vào RULES.md theo mẫu "Review … bằng Codex (ngày)".
5. Lead tự quyết và giao sửa nhóm "sửa ngay" (theo bước 3–4 của DOI_AGENT); chỉ hỏi người dùng khi bản sửa đổi một quyết định đã chốt hoặc đổi hành vi người dùng thấy. Báo người dùng bảng ba nhóm trong phần bàn giao.

## Giới hạn đã biết
- Codex không chạy được Inside/WMS/máy in/Supabase thật; không chạy được test cần tạo thư mục tạm trong sandbox (EPERM) — không phải lỗi của thay đổi.
- `index.html` quá lớn: luôn gửi diff hoặc ảnh, không gửi cả tệp.
- Không đưa `.env`, token, mã SKU thật vào prompt hay ảnh.
