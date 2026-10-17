# Đội agent của Print_SKU (từ 16/10/2026)

Một yêu cầu build mới đi qua bốn bước, do lead điều phối. Hồ sơ từng agent nằm ở `.claude/agents/*.md`; phiên Claude Code nào mở repo cũng dùng được bằng Agent tool (`subagent_type` = tên tệp).

## Vai trò

| Vai | Mô hình | Hồ sơ | Làm | Không làm |
|---|---|---|---|---|
| Lead | Fable | phiên chính | đặc tả, chia tệp và vùng, quyết định, gộp, chạy migration và deploy cùng người dùng, commit | giao việc chưa có chuỗi neo và test nghiệm thu |
| Trinh sát | Haiku | `trinh-sat` | bản đồ tệp, chuỗi neo, chỗ gọi, test liên quan, quyết định đã chốt | sửa tệp, đề xuất thiết kế |
| Thực thi logic | Opus | `thuc-thi-logic` | SQL, Edge Function, Extension, luồng in và quyền, kèm test đơn vị | chạy migration, deploy, commit, mở rộng phạm vi |
| Thực thi khuôn | Sonnet | `thuc-thi-khuon` | màn web theo khuôn, test Playwright, README/RULES theo mẫu | logic máy chủ, Extension |
| Kiểm thử | Haiku | `kiem-thu` | chạy bộ test, báo test hỏng; cổng trước commit | sửa mã nghiệp vụ |
| Review độc lập | Codex CLI | kỹ năng `review-codex` | review mã và giao diện bằng mô hình khác họ | sửa thẳng repo |
| Nghiệm thu | người dùng | | chạy thật trên Inside, WMS, máy in; duyệt ảnh | |

## Bốn bước cho một yêu cầu

1. **Đặc tả.** Lead gọi `trinh-sat` lấy bản đồ, rồi viết bản giao việc theo mẫu dưới. Mỗi người thực thi một bộ tệp không trùng nhau; `index.html` chỉ một người sửa tại một thời điểm.
2. **Thực thi.** Mỗi agent thực thi chạy trong worktree riêng (`isolation: worktree`), sửa đúng chuỗi neo, viết và chạy test của mình, không commit.
3. **Gộp và kiểm.** Lead gộp vào cây làm việc chính (đọc lại tệp trước khi ghi), gọi `kiem-thu` chạy cả bộ và soát cổng trước commit. Thay đổi SQL, Edge, Extension, luồng in/quyền hoặc màn mới thì chạy thêm `review-codex`; lead xử lý từng phát hiện, ghi lý do bỏ qua vào `RULES.md`.
4. **Lên và nghiệm thu.** Thứ tự bắt buộc: migration → deploy Edge → người dùng Reload Extension → chạy thật. Lead commit chỉ phần của đội (dùng chỉ mục tạm nếu cây đang có phần dở của phiên khác), push khi người dùng nói.

## Mẫu bản giao việc

```
Yêu cầu: <một câu của người dùng>
Kết quả mong muốn: <hành vi nhìn thấy được>
Phạm vi tệp: <tệp → vùng/khối → chuỗi neo nguyên văn>
Ngoài phạm vi: <tệp/khối không được chạm>
Quyết định đã chốt liên quan: <RULES.md mục …, một câu mỗi mục>
Hợp đồng dữ liệu: <RPC/Edge/lệnh Extension: tham số vào, trả về, lỗi>
Test nghiệm thu: <tên test mới hoặc sửa, điều phải khẳng định; bộ chuẩn phải PASS>
Chưa kiểm được bằng máy: <việc người dùng sẽ thử thật>
```

## Quy tắc chung không đổi

- Sửa nhỏ nhất trong `index.html`, không reformat; giữ CRLF/LF hiện trạng; không ghi lại cả tệp từ bản đọc cũ.
- Tiếng Việt có dấu; icon trước nhãn ngắn; không câu hướng dẫn kiểu AI trong màn.
- Không phụ thuộc ngoài, không gọi mạng mới, không bí mật hay dữ liệu thật trong repo.
- Mỗi thay đổi logic có test; mỗi quyết định có mục trong `RULES.md`.
- Việc đã chốt là không làm (ví dụ không nạp SKU ngừng hoạt động, không lọc Active ở nguồn, không nạp bù Excel) thì người thực thi không được "sửa lại cho đúng".

## Chạy nhanh

- Cả bộ test: `python scripts/run_tests.py` (hoặc `--only sku_sync`).
- Review Codex: kỹ năng `/review-codex` trong phiên, hoặc `python scripts/codex_review.py --commit <sha>` / `--working-tree` / `--images <thư mục ảnh>`.
- Chụp màn để review giao diện: viết script Playwright theo mẫu test của màn đó, lưu ảnh vào thư mục tạm rồi đưa vào `--images`.

## Bản đồ dự án (từ 17/10/2026)

- `docs/PROJECT_MAP.md` là bản đồ nhanh: ô trang chủ → hash → id khối trong `index.html`, tệp và lệnh Extension, action Edge, bảng Supabase, tệp migration giữ bản mới nhất của từng hàm, lệnh test/deploy.
- **Trinh sát** đọc bản đồ trước, rồi chỉ grep xác minh chuỗi neo của phần được hỏi; báo cáo nêu rõ chỗ bản đồ đã lỗi thời (nếu có).
- **Lead** cập nhật bản đồ trong cùng commit mỗi khi thêm/đổi module, lệnh Extension, action Edge hoặc chuỗi migration. Cổng kiểm thử coi "bản đồ chưa cập nhật" là một mục cảnh báo (không chặn).
