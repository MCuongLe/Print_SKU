---
name: review-claude
description: Review độc lập bằng Claude chạy SONG SONG với Codex (người dùng chốt 18/10/2026). Hai agent Claude đọc cùng diff với Codex: A logic/race/mất mạng (Opus); BC luật dự án + lỗi im lặng/nhánh lùi (Sonnet, thử gộp 2 đợt từ 26/10/2026). `co-van` (Fable) gộp, xác nhận bằng mã, chấm 0–100, xếp nhóm. Dùng cho SQL, Edge, Extension, luồng in/quyền, cache/đồng bộ — cùng lúc với /review-codex.
---

# Review độc lập bằng Claude (song song Codex)

Theo cách của plugin `code-review` của Anthropic (nhiều agent độc lập + chấm độ tin; ở đây `co-van` chấm) nhưng chạy trên cây làm việc (dự án không dùng Pull Request) và giữ **ba luật review** của dự án. Codex và Claude là hai họ mô hình khác nhau: lỗi cả hai cùng báo → ưu tiên sửa trước.

## Khi nào
- Cùng lúc với mỗi lượt `/review-codex` mã (`--working-tree` / `--since last`) cho SQL, Edge, Extension, luồng in/quyền, cache/đồng bộ. Không dùng cho ảnh giao diện (Codex `--images` lo), tài liệu, test thuần.
- Ba luật: tối đa 3 vòng một đợt (cùng số vòng với Codex; vòng 4 bị từ chối → dừng, xem lại hướng, hỏi người dùng); vòng 2–3 chỉ phần vừa sửa (`--since last`); gom lỗi theo loại.
- Không chạy cả bộ test cùng lúc (tải máy). Codex chạy nền song song được.

## Cách chạy
1. **Dựng phạm vi** (cùng diff, cùng trích RULES, cùng luật vòng với Codex; vòng 1 bỏ `--since last`):
   `python scripts/codex_review.py --working-tree --prepare-only --round N [--since last] --brief <md> --keywords "<từ khoá RULES>" --focus "<quyết định đã chốt, phần đã hoãn>" --add <tệp mới…>`
   Script in `PROMPT <đường dẫn>` và `REPORT <đường dẫn>`. `--prepare-only` KHÔNG lưu ảnh chụp; lượt Codex chạy cùng vòng với cùng tham số lưu ảnh chụp một lần (nên `--since last` của cả hai bên trỏ đúng ảnh vòng trước). Chạy `--prepare-only` trước, rồi Codex.
2. **Hai agent song song** (một lượt gọi Agent với 2 tool use, chạy nền, `subagent_type: general-purpose`, chỉ đọc — dặn rõ KHÔNG sửa tệp, KHÔNG chạy test trình duyệt, KHÔNG commit).
   - Mỗi agent nhận: đường dẫn tệp PROMPT (đọc bằng Read), góc nhìn riêng, và yêu cầu trả **JSON** `[{"group":"tên loại","severity":"nghiêm trọng|trung bình|nhỏ","cause":"…","locations":["tệp:dòng"],"scenario":"dữ liệu cụ thể → sai","fix":"cách sửa cả nhóm"}]`, bỏ phong cách/nitpick, bỏ lỗi có sẵn trước diff, bỏ điều đã chốt trong PROMPT.
   - **A — logic, race, mất mạng** (`model: opus`, tối đa 6 nhóm): thứ tự phản hồi, generation/khoá, cache cũ ghi đè mới, nhánh offline/PGRST202, phân trang, so sánh kiểu, SQL sai ngữ nghĩa, tương thích Extension/Edge cũ-mới.
   - **BC — luật dự án + lỗi im lặng** (`model: sonnet`, tối đa 8 nhóm; gộp B và C, thử 2 đợt từ 26/10/2026 — `docs/DOI_AGENT.md` mục "Thử gộp review B+C"). Soát lần lượt hai góc trong cùng agent; mỗi nhóm thêm khoá `"angle":"luật|im lặng"`.
     - **Góc luật dự án:** vi phạm quyết định đã chốt, release order (migration trước push), quyền/RLS/SECURITY DEFINER + search_path, dữ liệu thật trong test, chuỗi giao diện trái chuẩn (câu hướng dẫn, icon), bản đồ dự án thiếu cập nhật.
     - Đọc `AGENTS.md`, `docs/DOI_AGENT.md`, `docs/QUYET_DINH.md`, `docs/chuan/` (tệp theo loại thay đổi), `docs/PROJECT_MAP.md`; căn cứ khi cần ở `C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md`.
     - **Góc lỗi im lặng và nhánh lùi:** catch nuốt lỗi, trả null che lỗi, fallback hiển thị dữ liệu sai mà không báo, thông báo cho người dùng sai/thiếu, trạng thái kẹt (cờ không được xoá).
     - Soát đủ cả hai góc rồi mới trả; một góc không có phát hiện thì ghi rõ trong câu trả lời, không bỏ trống im lặng.
3. **Chấm độ tin:** không có agent riêng (từ 25/10/2026); `co-van` chấm ở bước 5 theo thang trong `.claude/agents/co-van.md`.
4. **Gom thô** (lead): ghi JSON của A và BC cùng đường dẫn báo cáo Codex cùng vòng (`outputs/codex-review/review-*.md` mới nhất) vào một tệp; không lọc, không kết luận.
5. **Tham vấn Fable** (người dùng yêu cầu 22/10/2026; mọi vòng, sau khi cả Codex, A và BC xong): gọi agent `co-van` (Fable, chỉ đọc, chạy nền) với tệp gom thô ở bước 4 và tệp PROMPT.
   - Fable: gộp trùng thành vấn đề gốc (ghi nguồn, đánh dấu [cả hai]), **mở mã thật** xác nhận từng vấn đề (đúng / sai / phóng đại) và chấm 0–100, xếp **nên sửa / làm sau / bỏ qua có lý do**, phân xử chỗ Codex và Claude mâu thuẫn, và nêu chỗ cần người dùng quyết.
   - Đưa phát hiện thô, KHÔNG đưa kết luận của lead (để Fable không bị neo).
   - Lead đối chiếu với bản lọc của mình: khớp → dùng; lệch → lead đọc lại mã ở chỗ lệch rồi quyết, ghi "Fable: …" trong REPORT/RULES.
   - Lead ghi `REPORT` (tiếng Việt, mẫu nhóm của Codex + cột điểm của Fable) và lọc ba nhóm như `/review-codex` bước 4: sửa ngay / làm sau / trái quyết định đã chốt.
   - Lead là Fable thì lead tự làm bước này, kể cả chấm điểm.
6. **Sửa:** lỗi logic giữ lại (nhất là [cả hai]) → lead đọc mã xác nhận, viết test đỏ tái hiện, rồi sửa cả nhóm (người dùng 18/10/2026: có hai review thì không dùng agent tái hiện riêng).

## Giới hạn
- Agent chỉ đọc mã: không chạy Inside/WMS/máy in/Supabase thật; bằng chứng chạy thật là test đỏ lead viết khi sửa.
- `index.html` quá lớn: agent đọc diff trong PROMPT rồi Read đúng đoạn quanh vị trí, không đọc cả tệp.
- Không đưa `.env`, token, mã SKU thật vào prompt.
- Chi phí: 1 Opus + 1 Sonnet + 1 Fable (`co-van`) mỗi vòng — chỉ dùng cho loại thay đổi ở mục "Khi nào".
