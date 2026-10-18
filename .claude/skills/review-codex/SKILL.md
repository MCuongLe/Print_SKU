---
name: review-codex
description: Gửi thay đổi (một commit, cây làm việc, hoặc bộ ảnh chụp màn) cho Codex CLI review độc lập ở chế độ chỉ đọc, rồi lọc kết quả theo quyết định đã chốt của dự án. Một vòng cuối mỗi đợt, trước khi báo xong, cho SQL, Edge Function, Extension, luồng in/quyền và mọi thay đổi giao diện (kèm ảnh chụp).
---

# Review độc lập bằng Codex

Review chất lượng độc lập bằng mô hình khác họ (bước 3 của `docs/DOI_AGENT.md` bản 3). Mặc định một vòng; có phát hiện phải sửa thì vòng 2–3 chỉ review phần vừa sửa, tối đa 3 vòng (xem Ba luật dưới); khởi động nền rồi làm việc khác trong lúc chờ. Codex chỉ nhận xét; lead xử lý.

## Khi nào
- Trước khi báo xong một đợt có thay đổi `supabase/*.sql`, `supabase/functions/*`, `extension/inside-po-connector/*`, luồng `print_*`, quyền: `--working-tree` (hoặc `--commit`).
- Mọi thay đổi giao diện người dùng thấy (18/10/2026, kể cả sửa nhỏ): `--images` với ảnh chụp 390 + 1280 (trang chủ, màn xưởng) hoặc 1280/1440 (Admin), chụp bằng Playwright với dữ liệu giả; kèm `--working-tree` nếu có đổi hành vi. **Thời điểm: ngay khi màn chạy được lần đầu**, trước khi người dùng duyệt; sửa theo góp ý xong thì không chụp gửi lại (vòng hai 17–18/10 cho 0/5 góp ý phải sửa).
- **Ba luật (18/10/2026):** tối đa 3 vòng một đợt (`--round N`, vòng 4 script từ chối → dừng, xem lại hướng tiếp cận, báo người dùng); vòng 2–3 chỉ review phần vừa sửa (`--working-tree --since last --round N`, script tự lưu ảnh chụp tệp sau mỗi lượt `--working-tree`); Codex gom lỗi theo loại, lead sửa cả nhóm một lần. Ảnh giao diện vẫn một vòng.
- Tệp mới chưa theo dõi (test mới…) phải đưa vào bằng `--add <tệp>`, nếu không diff cây làm việc bỏ sót.
- Trong lúc Codex chạy không chạy cả bộ test (test chập chờn vì tải máy).
- Bỏ qua cho tài liệu và test thuần.

## Cách chạy
1. Kiểm tra `codex --version` (chưa có thì nhờ người dùng cài: `npm install -g @openai/codex@latest`, đăng nhập bằng `codex login`).
2. Chuẩn bị bối cảnh: bản giao việc hoặc 5–10 dòng mô tả màn/luồng, ghi vào một tệp Markdown tạm trong thư mục scratchpad của phiên. Liệt kê rõ QUYẾT ĐỊNH ĐÃ CHỐT liên quan (lấy từ RULES.md) để Codex không báo nhầm.
3. Chạy một trong:
   - `python scripts/codex_review.py --commit <sha> --brief <tệp.md> --keywords "<từ khoá RULES>"`
   - `python scripts/codex_review.py --working-tree --brief <tệp.md>`
   - `python scripts/codex_review.py --images <thư mục ảnh> --brief <tệp.md>` (ảnh chụp bằng Playwright với dữ liệu giả, đặt tên theo thứ tự muốn Codex đọc).
   Kết quả ghi ở `outputs/codex-review/review-<ngày giờ>.md` (thư mục outputs không vào git) hoặc tệp chỉ định bằng `--out`, và in ra màn hình. Mỗi lượt khoảng 2–15 phút.
4. Lọc: với từng phát hiện, đối chiếu mã thật và RULES.md; xếp vào ba nhóm: sửa ngay, ghi nhận làm sau, trái quyết định đã chốt (bỏ qua, ghi lý do). Ghi kết quả lọc vào RULES.md theo mẫu "Review … bằng Codex (ngày)".
5. Lead tự sửa nhóm "sửa ngay" (test đỏ trước nếu là logic); chỉ hỏi người dùng khi bản sửa đổi một quyết định đã chốt hoặc đổi hành vi người dùng thấy. Báo người dùng bảng ba nhóm trong phần bàn giao.

## Giới hạn đã biết
- Codex không chạy được Inside/WMS/máy in/Supabase thật; không chạy được test cần tạo thư mục tạm trong sandbox (EPERM) — không phải lỗi của thay đổi.
- `index.html` quá lớn: luôn gửi diff hoặc ảnh, không gửi cả tệp.
- Không đưa `.env`, token, mã SKU thật vào prompt hay ảnh.
