---
name: review-claude
description: Review độc lập bằng Claude chạy SONG SONG với Codex (người dùng chốt 18/10/2026). Ba agent Claude đọc cùng phạm vi diff với Codex theo ba góc (logic/race/mất mạng; luật dự án RULES.md/AGENTS.md; lỗi im lặng/nhánh lùi), một agent Haiku chấm độ tin 0–100, chỉ giữ lỗi ≥ 80, gom theo loại. Dùng cho SQL, Edge, Extension, luồng in/quyền, cache/đồng bộ — cùng lúc với /review-codex.
---

# Review độc lập bằng Claude (song song Codex)

Theo cách của plugin `code-review` của Anthropic (nhiều agent độc lập + chấm độ tin, lọc ≥ 80) nhưng chạy trên cây làm việc (dự án không dùng Pull Request) và giữ **ba luật review** của dự án. Codex và Claude là hai họ mô hình khác nhau: lỗi cả hai cùng báo → ưu tiên sửa trước.

## Khi nào
- Cùng lúc với mỗi lượt `/review-codex` mã (`--working-tree` / `--since last`) cho SQL, Edge, Extension, luồng in/quyền, cache/đồng bộ. Không dùng cho ảnh giao diện (Codex `--images` lo), tài liệu, test thuần.
- Ba luật: tối đa 3 vòng một đợt (cùng số vòng với Codex; vòng 4 bị từ chối → dừng, xem lại hướng, hỏi người dùng); vòng 2–3 chỉ phần vừa sửa (`--since last`); gom lỗi theo loại.
- Không chạy cả bộ test cùng lúc (tải máy). Codex chạy nền song song được.

## Cách chạy
1. **Dựng phạm vi** (cùng diff, cùng trích RULES, cùng luật vòng với Codex; vòng 1 bỏ `--since last`):
   `python scripts/codex_review.py --working-tree --prepare-only --round N [--since last] --brief <md> --keywords "<từ khoá RULES>" --focus "<quyết định đã chốt, phần đã hoãn>" --add <tệp mới…>`
   Script in `PROMPT <đường dẫn>` và `REPORT <đường dẫn>`. `--prepare-only` KHÔNG lưu ảnh chụp; lượt Codex chạy cùng vòng với cùng tham số lưu ảnh chụp một lần (nên `--since last` của cả hai bên trỏ đúng ảnh vòng trước). Chạy `--prepare-only` trước, rồi Codex.
2. **Ba agent song song** (một lượt gọi Agent với 3 tool use, chạy nền, `subagent_type: general-purpose`, chỉ đọc — dặn rõ KHÔNG sửa tệp, KHÔNG chạy test trình duyệt, KHÔNG commit). Mỗi agent nhận: đường dẫn tệp PROMPT (đọc bằng Read), góc nhìn riêng, và yêu cầu trả **JSON** `[{"group":"tên loại","severity":"nghiêm trọng|trung bình|nhỏ","cause":"…","locations":["tệp:dòng"],"scenario":"dữ liệu cụ thể → sai","fix":"cách sửa cả nhóm"}]`, tối đa 6 nhóm, bỏ phong cách/nitpick, bỏ lỗi có sẵn trước diff, bỏ điều đã chốt trong PROMPT.
   - **A — logic, race, mất mạng** (`model: opus`): thứ tự phản hồi, generation/khoá, cache cũ ghi đè mới, nhánh offline/PGRST202, phân trang, so sánh kiểu, SQL sai ngữ nghĩa, tương thích Extension/Edge cũ-mới.
   - **B — luật dự án** (`model: sonnet`): soát vi phạm quyết định đã chốt, release order (migration trước push), quyền/RLS/SECURITY DEFINER + search_path, dữ liệu thật trong test, chuỗi giao diện trái chuẩn (câu hướng dẫn, icon), bản đồ dự án thiếu cập nhật.
     - Đọc `AGENTS.md`, `docs/DOI_AGENT.md`, `docs/QUYET_DINH.md`, `docs/chuan/` (tệp theo loại thay đổi), `docs/PROJECT_MAP.md`; căn cứ khi cần ở `C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md`.
   - **C — lỗi im lặng và nhánh lùi** (`model: sonnet`): catch nuốt lỗi, trả null che lỗi, fallback hiển thị dữ liệu sai mà không báo, thông báo cho người dùng sai/thiếu, trạng thái kẹt (cờ không được xoá).
3. **Chấm độ tin** — một agent `model: haiku` nhận toàn bộ JSON của A/B/C + đường dẫn PROMPT, đọc mã thật ở từng vị trí, chấm mỗi nhóm 0–100 theo thang (đưa nguyên văn):
   0 = báo nhầm hoặc lỗi có sẵn trước thay đổi; 25 = có thể đúng nhưng không kiểm được; 50 = đúng nhưng hiếm/nhỏ; 75 = đã kiểm lại, rất có thể gặp thật, ảnh hưởng chức năng hoặc trái luật ghi rõ trong RULES/AGENTS; 100 = chắc chắn, bằng chứng trực tiếp, gặp thường xuyên. Lỗi "trái luật" phải trích đúng câu luật, không có thì ≤ 25.
4. **Gộp** (lead): giữ nhóm ≥ 80; gộp nhóm trùng giữa A/B/C; so với báo cáo Codex cùng vòng (`outputs/codex-review/review-*.md` mới nhất) và đánh dấu **[cả hai]** cho lỗi Codex cũng báo. Ghi `REPORT` (tiếng Việt, theo mẫu nhóm của Codex + cột điểm) rồi lọc ba nhóm như `/review-codex` bước 4: sửa ngay / làm sau / trái quyết định đã chốt.
5. **Tham vấn Fable** (người dùng yêu cầu 22/10/2026; mọi vòng, sau khi cả Codex và A/B/C xong): gọi agent `co-van` (Fable, chỉ đọc, chạy nền) với tệp phát hiện thô của cả hai bên (JSON A/B/C sau chấm điểm — kèm nhóm < 80 đánh dấu "điểm thấp" — + đường dẫn báo cáo Codex) và tệp PROMPT. Fable: gộp trùng thành vấn đề gốc (ghi nguồn, đánh dấu [cả hai]), **mở mã thật** xác nhận từng vấn đề (đúng / sai / phóng đại), xếp **nên sửa / làm sau / bỏ qua có lý do**, phân xử chỗ Codex và Claude mâu thuẫn, và nêu chỗ cần người dùng quyết. Đưa phát hiện thô, KHÔNG đưa kết luận của lead (để Fable không bị neo). Lead đối chiếu với bản lọc của mình: khớp → dùng; lệch → lead đọc lại mã ở chỗ lệch rồi quyết, ghi "Fable: …" trong REPORT/RULES. Lead là Fable thì lead tự làm bước này.
6. **Sửa:** lỗi logic giữ lại (nhất là [cả hai]) → lead đọc mã xác nhận, viết test đỏ tái hiện, rồi sửa cả nhóm (người dùng 18/10/2026: có hai review thì không dùng agent tái hiện riêng).

## Giới hạn
- Agent chỉ đọc mã: không chạy Inside/WMS/máy in/Supabase thật; bằng chứng chạy thật là test đỏ lead viết khi sửa.
- `index.html` quá lớn: agent đọc diff trong PROMPT rồi Read đúng đoạn quanh vị trí, không đọc cả tệp.
- Không đưa `.env`, token, mã SKU thật vào prompt.
- Chi phí: 1 Opus + 2 Sonnet + 1 Haiku + 1 Fable (`co-van`) mỗi vòng — chỉ dùng cho loại thay đổi ở mục "Khi nào".
