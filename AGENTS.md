# AGENTS.md — luật chung cho mọi phiên và agent

Áp cho toàn repository. Tài liệu viết theo `docs/chuan/TAI_LIEU.md`.

## Dự án

- Công cụ kho xưởng may Hasaki: trang tĩnh `index.html` (GitHub Pages) + Chrome Extension `extension/inside-po-connector` + Supabase (RPC, RLS, cron, Edge Function) + agent in trên máy trạm. Sơ đồ: `docs/CONTEXT_MAP.md`.
- Mã vạch / QR, camera, khuôn tem in và trạng thái trên trình duyệt là hành vi người dùng đang dùng thật.

## Đọc trước khi làm

1. Tệp này.
2. `docs/CONTEXT_MAP.md` — 6 nguồn ngữ cảnh.
3. `docs/PROJECT_MAP.md` — module ↔ khối ↔ Extension ↔ Edge ↔ SQL ↔ test.
4. Mục lục "QUYẾT ĐỊNH ĐANG HIỆU LỰC" đầu `RULES.md` (chỉ trên máy). Quyết định đã chốt ở đó ràng buộc mọi agent.
5. Tệp trong `docs/plans/` nếu việc đang dở.
6. Đọc thêm theo loại việc:

| Loại việc | Đọc thêm |
|---|---|
| Mọi việc | `docs/DOI_AGENT.md` — quy trình bước 1–9, đội agent, review |
| Tài liệu, quyết định, nhật ký | `docs/chuan/TAI_LIEU.md` |
| Giao diện | `docs/chuan/GIAO_DIEN.md` |
| Mã web `index.html` | `docs/chuan/MA_WEB.md`; `docs/PROJECT_MAP.md` mục 2; `python scripts/index_outline.py [chuỗi lọc]` |
| SQL, RPC, Edge, quyền, luồng dữ liệu | `docs/chuan/DU_LIEU.md`; `docs/PROJECT_MAP.md` mục 4 |
| Extension, đồng bộ | `docs/chuan/DU_LIEU.md`; `docs/PROJECT_MAP.md` mục 3; `extension/inside-po-connector/README.md` |
| In tem, agent máy trạm | mục lục `RULES.md` chủ đề 3; `workstation-agent/README.md`, `workstation-agent/RULES.md` |
| Test, commit | `docs/chuan/KIEM_THU_GIT.md`; lệnh ở `docs/PROJECT_MAP.md` mục 5 |

Quyết định riêng của từng module vẫn ở mục lục `RULES.md` theo chủ đề.

## Bốn luật cứng

1. Không báo "xong" khi chưa trích kết quả lệnh thật; điều chưa kiểm phải nói rõ là chưa kiểm.
2. Không sửa lỗi khi chưa có nguyên nhân gốc có bằng chứng.
3. Chỉ commit / push khi người dùng nói; xong việc nhắc commit kèm danh sách tệp.
4. Push `main` = web lên ngay. Web cần hàm / cột / Edge mới: commit (chưa push) → migration → deploy Edge → Reload Extension (tải lại tab Inside / WMS) → push.

## Luật kỹ thuật

- `index.html` chạy như trang tĩnh độc lập. Không thêm npm, bước build, CDN, analytics, tracker hay lời gọi mạng mới khi chưa được duyệt; không bịa lệnh build / lint / test không có trong repo.
- Sửa `index.html` nhỏ nhất, tìm theo id khối hoặc chuỗi neo, không theo số dòng; không định dạng lại hay minify lại. Nhiều phiên cùng sửa tệp này: commit chỉ phần của mình.
- Grep `index.html` luôn giới hạn độ dài dòng: khối `worker-bundle` có dòng hàng trăm KB.
- Giữ chữ giao diện tiếng Việt, mã hoá Unicode, kiểu in và bố cục điện thoại.
- Không commit bí mật, khoá, endpoint riêng hay dữ liệu SKU / UID / PO thật; dùng dữ liệu giả chuẩn (SKU `9000000xx`, UID `1028260000000xxx`).
- Hàm SQL `SECURITY DEFINER` mới: `revoke execute … from public, anon, authenticated`, rồi chỉ `grant` cho vai cần.
- Supabase MCP chỉ để đọc. Migration, deploy và mọi lệnh ghi do người dùng chạy script, trừ khi người dùng cho phép rõ từng lần.
- Agent được giao việc không commit, không chạy migration / deploy, không ghi `RULES.md`.

## Kiểm chứng (làm phần áp dụng)

1. `git diff --check`; xem diff không có thay đổi lớn ngoài ý muốn.
2. Phục vụ repo qua máy chủ tĩnh (`python -m http.server 8000`; worktree của agent dùng cổng khác + `BASE=`), không mở tệp trực tiếp. Trang không có lỗi console.
3. Chạy luồng bị ảnh hưởng bằng dữ liệu giả, trên máy tính và điện thoại. Giao diện Admin chỉ xét máy tính.
4. Tem, bố cục in: xem trước khi in — khổ giấy, lề, chữ bị cắt, mã vạch đọc được, nhiều tem sang trang.
5. Camera, máy quét: từ chối quyền, không có camera, quét đúng, nhập tay. Camera cần `https://` hoặc localhost.
6. Trong lúc làm chạy test liên quan; trước khi báo xong chạy cả bộ `python scripts/run_tests.py` (nền) và `python scripts/commit_gate.py`.
7. Phần không tự động kiểm được: nêu đúng những gì người dùng còn phải thử.

## Bàn giao

- Hành vi người dùng thấy đã đổi.
- Đã kiểm gì, chưa kiểm gì (trình duyệt, camera, máy in, khổ tem).
- Thay đổi lớn ở `index.html` và lý do.
- Tài liệu đã cập nhật theo `docs/chuan/TAI_LIEU.md` mục 5.
- Dòng nhắc commit kèm danh sách tệp.

Trả lời người dùng bằng tiếng Việt có dấu.
