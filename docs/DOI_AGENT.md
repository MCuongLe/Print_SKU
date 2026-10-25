# Đội agent của Print_SKU — bản 3 (18/10/2026)

Bản 3 quay về cách làm nhanh: **lead tự làm phần lớn việc**, chỉ gọi agent khi có lợi thật, bỏ giấy tờ và vòng soát trung gian. Giữ lại những luật rẻ mà đáng giá của bản 2 (bằng chứng trước khi báo xong, nguyên nhân gốc trước khi sửa lỗi, commit khi người dùng nói, migration trước push) và giữ Codex làm mắt thứ hai, kể cả cho giao diện. Hồ sơ agent ở `.claude/agents/*.md`, gọi bằng Agent tool (`subagent_type` = tên tệp). Nếu plugin Superpowers được cài, **tệp này thắng khi hai bên khác nhau**.

Lý do đổi (18/10/2026): bản 2 làm việc Vừa chậm gấp 3–5 lần vì mỗi việc qua trinh sát → người thực thi trong worktree → soát đặc tả → Codex hai vòng; mỗi agent mới phải đọc lại bối cảnh, dựng worktree và cổng riêng; cả bộ test (~10 phút) bị chạy nhiều lần; việc Lớn phải viết tệp kế hoạch có ô trạng thái.

## Bốn luật không ngoại lệ

Xem `AGENTS.md` mục "Bốn luật cứng" (nguồn duy nhất từ 25/10/2026). Luật 2 làm theo mục "Quy trình sửa lỗi" dưới đây.

## Ai làm gì

| Vai | Mô hình | Hồ sơ | Khi nào dùng |
|---|---|---|---|
| Lead | Fable 5.1 (dự phòng Opus 5.5) | phiên chính | **Mặc định làm thẳng mọi việc**: đọc `docs/PROJECT_MAP.md`, grep xác minh neo, sửa, viết test, chạy test liên quan, gọi Codex, báo cáo, migration/deploy cùng người dùng, commit khi được bảo |
| Thực thi logic | Opus | `thuc-thi-logic` | Chỉ khi có **một khối logic lớn tách được** (hàm SQL mới nhiều nhánh, Edge action mới, bộ đọc Extension mới) **và** lead đang làm việc khác song song. Giao một lần cả khối, không chia việc con |
| Trinh sát | Haiku | `trinh-sat` | Chỉ khi vùng mã lạ với lead **và** bản đồ dự án không đủ (ví dụ truy đường dữ liệu qua 4–5 chặng cho một lỗi). Không gọi cho việc đã rõ neo |
| Kiểm thử | Sonnet (từ 18/10/2026, trước là Haiku) | `kiem-thu` | **Mỗi đợt, khi lead báo xong phần mã:** chạy cả bộ test nền, phân loại mỗi test hỏng (lỗi thật / test lệch hành vi mới / chập chờn) kèm dòng mã nghi ngờ, rồi `commit_gate.py` + soát hunk `index.html` ngoài vùng giao; không sửa gì. Lead làm tài liệu, `RULES.md` song song |
| Review chất lượng | Codex CLI | kỹ năng `review-codex` | **Một vòng** cuối mỗi đợt: SQL, Edge, Extension, luồng in/quyền **và giao diện** (ảnh chụp). Bỏ qua cho tài liệu và test thuần |
| Review Claude | Opus + 2 Sonnet + Haiku | kỹ năng `review-claude` | **Song song với mỗi lượt Codex mã** (SQL, Edge, Extension, in/quyền, cache/đồng bộ): 3 agent đọc cùng diff theo 3 góc (logic/race/mất mạng; luật dự án; lỗi im lặng), Haiku chấm độ tin, giữ ≥ 80, gom theo loại; lỗi Codex cũng báo đánh dấu [cả hai]. Cùng số vòng với Codex (tối đa 3). Thêm 18/10/2026 theo yêu cầu người dùng |
| Cố vấn quyết định | Fable | `co-van` | Chỉ đọc. **Bước cố định của mọi vòng review mã (người dùng yêu cầu 22/10/2026):** sau khi Codex + `/review-claude` xong, Fable nhận phát hiện thô (không kèm kết luận của lead), gộp trùng, mở mã xác nhận, xếp nên sửa / làm sau / bỏ qua; lead đối chiếu với bản lọc của mình, lệch thì đọc lại mã rồi quyết (không áp dụng cho vòng ảnh giao diện). Ngoài ra gọi khi lead (Opus) **không tự quyết được**, ở 4 điểm: (1) chọn giữa ≥ 2 hướng thiết kế mà đọc mã/dữ liệu vẫn không rõ bên nào hơn, khi hướng đó chạm dữ liệu, in, quyền hay migration; (2) review chạm giới hạn 3 vòng, cần hướng tiếp cận khác; (3) Codex và `/review-claude` mâu thuẫn, hoặc không rõ một phát hiện có thật không; (4) đã thử 2 giả thuyết mà chưa ra nguyên nhân gốc. Bản hỏi ≤ 1 trang (câu hỏi, các hướng, bằng chứng, ràng buộc). Không gọi cho lựa chọn người dùng thấy (hỏi người dùng), lỗi đơn giản, thẩm mỹ giao diện. Lead vẫn quyết và báo người dùng "đã hỏi Fable: …". Lead là Fable thì không cần. Thêm 18/10/2026 theo yêu cầu người dùng |
| Nghiệm thu | người dùng | | chốt thiết kế khi có lựa chọn, chạy thật trên Inside/WMS/máy in, duyệt ảnh |

Agent được giao việc **không commit, không migration/deploy, không ghi `RULES.md`**, báo cáo kèm dòng test thật. `RULES.md` không vào git: đọc bằng đường dẫn tuyệt đối `C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md`. Agent làm trong worktree thì dùng cổng máy chủ riêng (8001, 8002, …) và `BASE=`.

## Một yêu cầu đi thế nào

1. **Hiểu và quyết.** Lead tự làm; trinh sát / Fable chỉ theo điều kiện ở bảng "Ai làm gì".
   - **Đọc:** theo thứ tự của `CLAUDE.md` — `docs/CONTEXT_MAP.md` → `docs/PROJECT_MAP.md` → mục lục "QUYẾT ĐỊNH ĐANG HIỆU LỰC" đầu `RULES.md` (grep theo tên module, trước khi hỏi hay tự quyết); grep xác minh neo; đo dữ liệu thật nếu cần (Supabase MCP chỉ đọc, DevTools trên tab Inside/WMS, không dùng `get_network_request` vì lộ token).
   - **Đúng loại sản phẩm:** yêu cầu "thiết kế", "đánh giá", "kiểm tra", "cảnh báo khi tôi nhờ" → giao đúng sản phẩm đó (bản vẽ, nhận xét, số đo, câu báo trong chat), không kèm danh sách build, luật mới hay mã chạy thường trực; làm tiếp chỉ khi người dùng gọi.
   - **Mẫu phản hồi thật:** mã mới đọc phản hồi RPC / Edge / WMS / Inside nào thì lấy một mẫu phản hồi thật của đúng lời gọi đó trước khi viết test (chỉ đọc: Supabase MCP, DevTools GET trên tab thật): ghi tên khoá, kiểu, định dạng mã — vd. `fabric_issue_get` trả dòng khoá camelCase `groupUid`; số phiếu IT cũng 16 số, tiền tố `1007`, còn Group UID tiền tố `1028`. Test giả dựng đúng theo mẫu đó, giá trị thay bằng dữ liệu giả chuẩn; mẫu thật không vào repo (người dùng chốt 25/10/2026, sau đợt Trợ lý in → Packing List: mock sai khoá `group_uid_code` che lỗi tới vòng review).
   - **Sửa hàm SQL / Edge đang chạy:** trước khi viết, so bản trên Supabase (`pg_get_functiondef`, mã Edge đã deploy — MCP chỉ đọc) với tệp mới nhất trong repo và kiểm tên cột thật; lệch thì xuất phát từ bản đang chạy, ghi `RULES.md` và nêu trong brief review.
   - **Màn / tab mới sinh dữ liệu** (quét, đọc WMS, nạp tệp): mặc định lưu Supabase, ghi = máy đã kích hoạt hoặc Admin, xem = mọi người; chỉ đưa vào lượt hỏi khi muốn khác (người dùng chốt 25/10/2026).
   - **Hỏi:** có lựa chọn ảnh hưởng người dùng thấy thì hỏi **một lượt** (tối đa 4 câu, phương án khuyến nghị đứng đầu); điều suy được từ mã hay dữ liệu thì không hỏi. Mỗi phương án kèm hệ quả một câu (vd. "trên máy → máy khác không thấy", "giữ 2 mẫu → phải tách 2 lệnh"); việc nhắm giảm dữ liệu hay tăng tốc thì đo trước và nêu con số lợi ích dự kiến. Phương án đổi chốt cũ ghi "đổi chốt <ngày>: …"; yêu cầu trái chốt thì nêu chốt ngay trong câu trả lời đầu, trước khi viết brief.
   - **Tin nhắn thiết kế** nói gọn trong chat, mở bằng hai dòng: **Giả định đã kiểm** (dữ liệu nguồn, hợp đồng RPC / WMS, điều kiện vận hành: giờ chạy, tab, thiết bị, phiên bản agent — mỗi giả định ghi cách kiểm: mẫu thật, SELECT hay "hỏi") và **Ngoài phạm vi** (luồng anh em cùng loại cố ý không làm, tìm bằng grep id khối); không có thì ghi "không". Không viết tệp kế hoạch, trừ việc có migration nhiều bước hoặc khi người dùng yêu cầu (mẫu `docs/plans/README.md`).
   - Sáu luật trên (trừ mẫu phản hồi thật) thêm 25/10/2026 sau rà soát của lead + Fable: 13 lần sai có gốc ở bước 1, 9 lần do người dùng phát hiện, 5 lần sau khi đã lên thật. Tốn thêm khoảng 5 phút mỗi đợt.
2. **Làm.** Lead sửa thẳng trên cây chính. Test đỏ trước **bắt buộc khi sửa lỗi và khi đổi logic** (SQL, Edge, Extension, hàm tính, luồng in/quyền); với giao diện, viết test cùng lúc với mã là đủ nhưng test phải khẳng định hành vi mới. Trong lúc làm **chỉ chạy test liên quan** (`node tests/<tên>` hoặc `run_tests.py --only`).
3. **Hai review song song: Codex + `/review-claude`** (người dùng chốt 18/10/2026: có hai review thì không cần agent tái hiện lỗi — đã bỏ `tai-hien`; lỗi logic được xác nhận khi đọc mã thì lead tự viết test đỏ trước rồi sửa). Chi tiết Codex: **Codex** (`python scripts/codex_review.py --working-tree --brief <md tạm>`; giao diện thêm `--images <ảnh 390/1280>`). **Giao diện: chụp ảnh ngay khi màn chạy được lần đầu, gửi Codex, sửa theo góp ý, rồi KHÔNG gửi lại** (số đo 17–18/10: vòng ảnh đầu 4/9 và 6/7 góp ý dùng được, vòng hai sau khi sửa 0/5). **Ba luật review (người dùng chốt 18/10/2026), `scripts/codex_review.py` tự giữ:** (1) **tối đa 3 vòng** một đợt (`--round N`; vòng 4 bị từ chối) — 3 vòng chưa xong thì dừng vá, xem lại hướng tiếp cận (thiết kế, nguyên nhân gốc) và báo người dùng; (2) **vòng sau chỉ review phần vừa sửa** (`--working-tree --since last --round 2`: script lưu ảnh chụp tệp sau mỗi vòng, vòng sau chỉ gửi diff từ ảnh chụp đó, không quét lại cả đợt; tệp mới chưa theo dõi đưa vào bằng `--add <tệp>`); (3) **gom lỗi theo loại**: Codex trả nhóm lỗi cùng nguyên nhân/mẫu kèm mọi vị trí (cả chỗ tương tự ngoài diff), lead sửa cả nhóm một lần rồi mới sang vòng sau. Lead lọc từng nhóm thành **sửa / làm sau / bỏ qua có lý do** (trái quyết định đã chốt) **và tham vấn Fable (`co-van`) cùng việc lọc đó trên phát hiện thô của cả hai review** (từ 22/10/2026, xem `/review-claude` bước 5), tự quyết, chỉ hỏi người dùng khi bản sửa đổi một quyết định đã chốt hoặc đổi hành vi người dùng thấy. Ghi kết quả lọc vào `RULES.md`. Codex chạy 2–15 phút: khởi động nền rồi làm tiếp việc khác, **nhưng không chạy cả bộ test cùng lúc** (hai lần test chập chờn 17/10 đều lúc máy chạy Codex + agent song song).
4. **Cả bộ test một lần, chạy nền** (`python scripts/run_tests.py --no-server` khi máy chủ 8000 đang chạy) trước khi báo xong; script tự chạy lại test hỏng một lần, tuần tự, và in mục **CHẬP CHỜN** cho test chỉ đạt lần hai — chép mục đó vào báo cáo. **Cổng trước commit là script:** `python scripts/commit_gate.py` (bí mật, dữ liệu thật, mojibake + `diff --check`, đổi CRLF cả tệp, phiên bản Extension khi manifest đổi, CDN/npm mới, cảnh báo bản đồ) phải in "Đủ điều kiện commit" trước khi nhắc commit; mục KHÔNG ĐẠT nào là dữ liệu giả hợp lệ bị bắt nhầm thì ghi rõ trong báo cáo. Riêng mục "hunk `index.html` ngoài vùng được giao" lead tự nhìn diff.
5. **Báo cáo và nhắc commit.** Hành vi đổi, dòng test thật, Codex đã xử lý thế nào, điều chưa kiểm, danh sách tệp chờ. Lead cập nhật `docs/PROJECT_MAP.md` cùng commit khi đổi module/lệnh/Edge/migration; `README.md` khi đổi hành vi người dùng; `RULES.md` quyết định và số đo.
6. **Lên:** theo luật 4. Sau khi lên, lead kiểm thật (Supabase MCP chỉ đọc hoặc SQL/DevTools) và ghi số đo vào `RULES.md`.

Việc có **migration nhiều bước hoặc kéo dài hơn một phiên** (ví dụ đồng bộ tự động, khoá máy xưởng) thì vẫn ghi một tệp `docs/plans/<yyyy-mm-dd>-<tên>.md` theo mẫu rút gọn ở `docs/plans/README.md`, để lead mới tiếp được; còn lại không viết.

## Lead: chống sót việc (người dùng duyệt 18/10/2026)

Rút từ đợt cache 18/10: lead quên Codex ảnh, hai phần của một việc và README vì đánh [x] cả việc mà không đối chiếu từng gạch; 7 yêu cầu phát sinh làm xen với 3 vòng review; lệch kế hoạch chỉ ghi nhật ký; tính năng và thay đổi đội agent lẫn một cây làm việc.

1. **Mỗi gạch đầu dòng là một ô tích.** Trong tệp kế hoạch, mỗi sản phẩm của một việc là `- [ ]` riêng; tích kèm bằng chứng (tên test, ảnh, số đo). Việc chỉ [x] khi mọi ô đã tích. Việc không có tệp kế hoạch: lead liệt kê các ô trong tin nhắn đầu tiên và đối chiếu lại trước khi báo xong.
2. **Rà kế hoạch ở 3 mốc, bằng cách mở lại tệp:** sau mỗi việc, sau mỗi vòng review, trước khi báo xong. Trước khi báo xong lập bảng "kế hoạch ↔ thực tế" (có thể giao `kiem-thu` đối chiếu diff với các ô).
3. **Yêu cầu phát sinh giữa đợt** ghi ngay vào mục "Phát sinh" của kế hoạch (hoặc danh sách trong chat), rồi chọn: làm ngay nếu nhỏ và không đụng tệp của đợt chính, để sau đợt nếu ngược lại. Việc phát sinh đi **commit riêng**.
4. **Lệch kế hoạch** (làm khác, bỏ, thêm) ghi vào mục "Lệch kế hoạch" và **báo người dùng một dòng ngay trong tin nhắn kế tiếp**, không chỉ ghi nhật ký.
5. **Chia việc cố định:** lead giữ quyết định, sửa `index.html` (một người sửa tại một thời điểm), lọc kết quả review, nói chuyện với người dùng, lên bản; `thuc-thi-logic` (Opus) SQL/Edge song song; `kiem-thu` (Sonnet) cả bộ test + chẩn đoán + cổng + đối chiếu kế hoạch; Codex và `/review-claude` chạy nền; `co-van` (Fable) lọc kết quả mỗi vòng review mã và khi lead kẹt quyết định.

## Lead đánh giá thành viên (người dùng duyệt 18/10/2026)

1. **Cuối mỗi đợt**, lead ghi vào bảng "Đánh giá thành viên" trong `RULES.md` một dòng cho MỖI thành viên đã dùng (agent, Codex, `/review-claude`, `co-van`): việc gì · kết quả (đúng / sai / báo nhầm: bao nhiêu lần, chi tiết một câu) · lead phải làm lại gì · token + thời gian (từ thông báo khi agent xong) · nhận xét Tốt / Khá / Kém.
2. **Hai tiêu chí:** (a) thành viên có bắt được / làm được điều lead và người khác không làm được; (b) lead mất bao công kiểm lại, sửa lại.
3. **Lỗi lặp lại được của một thành viên → sửa hồ sơ ngay đợt đó** (nguyên nhân gốc + luật mới + thử luật trên dữ liệu thật của lần lỗi), ghi vào bảng.
4. **Mỗi 3 đợt**, lead xem lại bảng và đề xuất với người dùng: giữ / đổi mô hình (lên hoặc xuống) / sửa hồ sơ / bỏ.

## Bản giao việc cho agent (dán vào lời nhắn, 7 dòng)

Mọi lần vấp của agent 16–17/10 đều do thiếu một trong các dòng này (cổng 8001 trùng, patch lệch CRLF, không biết quyết định đã chốt). Không viết tệp riêng; dán thẳng vào prompt của Agent tool:

```
Việc: <một câu; kết quả nhìn thấy được>
Tệp → neo: <tệp> → `<chuỗi neo nguyên văn, grep -c = 1>`; xuống dòng của tệp: <CRLF|LF>
Ngoài phạm vi: <tệp/khối không chạm>
Đã chốt (RULES.md, đọc ở C:\Users\HASAKI\Documents\GitHub\Print_SKU\RULES.md): <mỗi mục một câu>
Test: <tên test đỏ trước (nếu là logic/lỗi) + điều khẳng định; bộ chuẩn phải PASS>
Môi trường: cây chính | worktree; máy chủ cổng <800N> + BASE=http://127.0.0.1:<800N>/; PLAYWRIGHT_MODULE=C:/Users/HASAKI/playwright-tools/node_modules/playwright
Bàn giao: sửa thẳng (cây chính) | git diff > <scratchpad>/<việc>.patch (worktree); báo cáo kèm dòng FAIL/PASS thật; không commit, không RULES.md
```

## Quy trình sửa lỗi (mọi cỡ)

1. **Tái hiện bằng bằng chứng**, không đoán: ảnh/câu người dùng → SQL trên Supabase, DevTools trên tab thật, log Edge, `print_events`. Ghi lại dữ liệu sai cụ thể (giá trị, thời điểm, mã lệnh).
2. **Truy ngược tới nguyên nhân gốc**: đi theo đường dữ liệu từ nguồn (Inside/WMS/RPC) tới chỗ hiển thị; so trường hợp đúng với trường hợp sai; mỗi lần kiểm **một** giả thuyết. Ví dụ đã làm: "Failed to fetch" → Supabase trả 403 cho token hết hạn chứ không phải 401; Rcvd date → `cells[5]` là cột Delivery, LastModified ở `cells[4]`.
3. **Test đỏ tái hiện lỗi** (Node/vm cho lõi, Playwright cho màn).
4. **Sửa một chỗ**, test xanh, chạy bộ liên quan. Sửa ba lần chưa xong → dừng, xem lại thiết kế và báo người dùng thay vì vá tiếp.
5. Ghi `RULES.md`: triệu chứng, nguyên nhân gốc, bằng chứng, cách sửa, điều chưa kiểm.

## Khi phiên bị gián đoạn

- Lead mới (hết ngữ cảnh, đổi model, phiên mới) đọc theo `AGENTS.md` mục "Đọc trước khi làm", rồi các mục cuối nhật ký `RULES.md` → `git status` → tệp kế hoạch mới nhất trong `docs/plans/` nếu có.
- **Lead dự phòng**: Fable 5.1 hết hạn mức → Opus 5.5 làm lead trong cùng phiên (đổi model ở bộ chọn của app), giữ nguyên bốn luật và quy trình. Sonnet và Haiku không làm lead. Hết ngữ cảnh khác hết hạn mức: phiên tự tóm tắt và tiếp tục với cùng model.

## Quy tắc chung không đổi

- Sửa nhỏ nhất trong `index.html`, không reformat; giữ CRLF/LF hiện trạng; đọc lại tệp ngay trước khi ghi; không ghi lại cả tệp từ bản đọc cũ. Khối mới đặt trong `<style id="…">`/`<script id="…">` riêng.
- Tiếng Việt có dấu; icon Lucide trước nhãn ngắn; không câu hướng dẫn kiểu AI trong màn; Admin chỉ xét máy tính; trang chủ và màn xưởng xét cả 390 px.
- Màn mới hoặc làm lại giao diện: nạp kỹ năng `frontend-design` để lấy hướng bố cục, thứ bậc thị giác, khoảng trắng, trạng thái rỗng/đang chờ/kết quả. **Chuẩn dự án thắng khi khác nhau:** giữ màu chính #005F41 và bảng màu hiện có, một font hệ thống, thang chữ và cỡ icon mà `typography_browser`/`icon_standard_browser`/`ui_standard_browser`/`a11y_axe_browser` kiểm; không thêm font, CDN hay thư viện.
- Không phụ thuộc ngoài, không gọi mạng mới khi chưa được duyệt, không bí mật hay dữ liệu thật trong repo. Dữ liệu giả chuẩn: SKU `9000000xx`, Group UID `1028260000000xxx` (cũ còn dùng `9999991000000001`), số phiếu/PO `100000001`; fixture cũ đã có trong HEAD giữ nguyên.
- **Supabase MCP (plugin, 17/10/2026) chỉ dùng để ĐỌC** (schema, RLS, log Edge, advisors, SELECT) trên project `ikzhitdqkoatlmkrxuuh`. Migration, deploy, ghi dữ liệu, đổi cấu hình/khoá vẫn qua `scripts/apply_supabase_sql.py` / `deploy_*.py` do người dùng chạy, trừ khi người dùng cho phép rõ từng lần. Thiết lập Auth/bảo mật trong Dashboard do người dùng tự bấm.
- Extension đổi hành vi thì nâng phiên bản trong `manifest.json`, cập nhật mọi test khẳng định số đó (`grep -l` trong `tests/`) và ghi chú trong `extension/inside-po-connector/README.md`.
- Việc đã chốt là không làm trong `RULES.md` thì không ai được "sửa lại cho đúng".
- Nhiều phiên cùng sửa `index.html`: `git status` trước khi gộp; commit chỉ phần của đội.

## Chạy nhanh

- Cả bộ test: `python scripts/run_tests.py [--no-server] [--only <tên>] [--no-retry]` (tự chạy lại test hỏng một lần, in mục CHẬP CHỜN); máy chủ tĩnh cổng 8000; `PLAYWRIGHT_MODULE=C:/Users/HASAKI/playwright-tools/node_modules/playwright`.
- Cổng trước commit: `python scripts/commit_gate.py [--cached | --commit <sha>]` (thoát 1 khi có mục KHÔNG ĐẠT). Từ 18/10/2026 hook `.claude/settings.json` tự chạy cổng này trước mọi `git commit` và chặn Write ghi đè cả `index.html` / sửa `.env` (`scripts/claude_hooks.py`); người dùng gọi `/commit-push` để commit + push theo đủ luật.
- Review Codex: `/review-codex`, hoặc `python scripts/codex_review.py --commit <sha> | --working-tree | --images <thư mục> --brief <md>`.
- Migration: `python scripts/apply_supabase_sql.py <tệp> [--dry-run] [--allow-destructive]`; deploy Edge: `python scripts/deploy_<tên>.py [--dry-run]`.
- Bản đồ dự án: `docs/PROJECT_MAP.md`; mẫu kế hoạch cho việc nhiều bước: `docs/plans/README.md`.
