# Claude Code

`AGENTS.md` là nguồn hướng dẫn chính của toàn bộ repository và áp dụng cho mọi
phiên Claude Code. Không sao chép hoặc tạo một bộ quy tắc song song trong tệp
này.

Trước khi làm việc, đọc theo thứ tự:

1. `AGENTS.md` — phạm vi, quy tắc làm việc, kiểm chứng và bàn giao.
2. `docs/CONTEXT_MAP.md` — bản đồ sáu nguồn ngữ cảnh.
3. `docs/PROJECT_MAP.md` — vị trí module, Extension, Edge, SQL và test.
4. Mục lục "QUYẾT ĐỊNH ĐANG HIỆU LỰC" ở đầu `RULES.md` — quyết định cục bộ
   đang ràng buộc; tệp này không được commit.
5. Tệp liên quan trong `docs/plans/` nếu công việc hiện tại có kế hoạch nhiều
   bước.

Quy trình agent và review nằm trong `docs/DOI_AGENT.md`. Chỉ commit, push,
chạy migration hoặc deploy khi người dùng yêu cầu rõ ràng theo các quy tắc ở
trên.
