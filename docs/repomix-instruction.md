# Cách đọc gói ngữ cảnh Print_SKU

1. Thứ tự đọc (giống AGENTS.md và CONTEXT_MAP): `AGENTS.md` (luật làm việc) → `docs/CONTEXT_MAP.md` (6 nguồn ngữ cảnh: Source Code, Database, Business Logic, Dependencies, Documentation, Git History) → `docs/PROJECT_MAP.md` (module → id khối trong index.html → Extension → Edge → SQL) → `RULES.md` (không có trong gói).
2. Gói này KHÔNG có:
   - `index.html` (web một tệp ~2,5 MB): vị trí từng module ghi theo id khối / chuỗi neo trong PROJECT_MAP mục 2 — hỏi người dùng hoặc grep repo thật, đừng đoán.
   - Migration `supabase/*.sql`: bản mới nhất của một hàm nằm ở tệp mới nhất đụng nó (chuỗi ở PROJECT_MAP mục 4).
   - `RULES.md` (quyết định đã chốt, chỉ trên máy người dùng), test, nội dung `docs/plans/` (chỉ có tên tệp + README mẫu), `README.md` gốc, `workstation-agent/RULES.md`.
   - Thân hàm JS/TS/Python: mã đã nén (chỉ chữ ký + cấu trúc). Cần logic chi tiết thì hỏi người dùng tệp cụ thể.
3. Trả lời bằng tiếng Việt có dấu. Không đề xuất thêm CDN/npm runtime cho web, không đổi mô hình triển khai (GitHub Pages tĩnh). Thứ tự lên: migration → deploy Edge → Reload Extension → cài agent (nếu có) → push web.
4. Phần "git logs" cuối gói là 40 commit gần nhất: dùng để biết đợt việc mới nhất và phiên bản Extension / agent đang chạy.
