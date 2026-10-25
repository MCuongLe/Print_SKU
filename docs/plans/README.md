# docs/plans — kế hoạch cho việc nhiều bước

Luật lead chống sót việc (18/10/2026, `docs/DOI_AGENT.md`): mỗi gạch là một ô `- [ ]` tích kèm bằng chứng, việc [x] khi đủ ô; rà lại tệp sau mỗi việc, mỗi vòng review và trước khi báo xong; yêu cầu phát sinh ghi mục "Phát sinh" (commit riêng); làm khác kế hoạch ghi "Lệch kế hoạch" và báo người dùng ngay.

Từ bản 3 (18/10/2026) chỉ việc có **migration nhiều bước hoặc kéo dài hơn một phiên** mới có tệp `yyyy-mm-dd-<tên-ngắn>.md` ở đây (xem `docs/DOI_AGENT.md`); việc khác thiết kế gọn trong chat. Tệp vào git để lead nào (hết ngữ cảnh, đổi model, phiên mới) cũng tiếp được việc đang dở; mẫu dưới dùng rút gọn, bỏ mục nào không cần. Không ghi khoá, token, mã SKU/UID thật; dùng dữ liệu giả.

## Mẫu

```markdown
# <Tên tính năng> (<yyyy-mm-dd>)

## Thiết kế
- **Yêu cầu:** <câu của người dùng, nguyên văn ngắn>
- **Kết quả nhìn thấy được:** <người dùng sẽ thấy/làm được gì>
- **Đã chốt với người dùng:** <mỗi quyết định một dòng; ghi rõ nếu đổi quyết định cũ trong `docs/QUYET_DINH.md`>
- **Số đo thật:** <dữ liệu đã đo trên Supabase/Inside/WMS, kèm thời điểm>
- **Hợp đồng dữ liệu:** <RPC / action Edge / lệnh Extension: vào, ra, lỗi>
- **Rủi ro và cách chặn:** <…>
- **Chưa kiểm được bằng máy:** <việc người dùng sẽ thử thật>

## Kế hoạch
Thứ tự chạy: <việc 1 → việc 2; việc 3 song song với 1>

### Việc 1 — <tên> · <lead | thuc-thi-logic> · [ ]
- Tệp và neo: `<tệp>` → `<chuỗi neo nguyên văn>`
- [ ] <sản phẩm 1 — tích kèm bằng chứng: test / ảnh / số đo>
- [ ] <sản phẩm 2>
- [ ] Test đỏ trước: `<tests/…>` khẳng định <…> (lệnh `node tests/<…>`, mong đợi PASS)
- Ngoài phạm vi: <…>

### Việc 2 — …

## Phát sinh
- <ngày giờ> <yêu cầu mới giữa đợt> → làm ngay (nhỏ, không đụng tệp đợt chính) | để sau đợt · commit riêng

## Lệch kế hoạch
- <làm khác / bỏ / thêm gì, vì sao> · đã báo người dùng <ngày giờ>

## Nhật ký
- <ngày giờ> Việc 1 ĐÚNG ĐẶC TẢ (kiem-thu); Codex vòng 1: 3 sửa / 1 bỏ qua (lý do …)
- <ngày giờ> run_tests.py 70/70; commit <sha>; migration + deploy xong; kiểm thật: <số đo>
```
