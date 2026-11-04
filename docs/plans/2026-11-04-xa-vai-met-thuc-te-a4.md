# THEO DÕI XẢ VẢI: nhập mét thực tế → hàng đợi → in phiếu A4 (2026-11-04)

Trạng thái (04/11/2026): **ĐÃ BUILD + 3 vòng review + cả bộ test; CHỜ COMMIT; CHƯA lên thật** (chưa migration, chưa cài agent, chưa push). Người dùng đã chốt Đ1, Đ6, Đ8, Đ10, Đ11, Đ12, Đ13.

## Thiết kế

- **Yêu cầu (04/11/2026):** nhập mã hàng; quét Group UID rồi nhập mét thực tế sau khi xả; UID có mét vào hàng đợi in; bấm In gửi lệnh tới máy trạm in A4 (HP LaserJet Professional P 1102w) qua agent cài trên máy nối với máy in đó.
- **Kết quả nhìn thấy được:**
  - `#xa-vai` (cùng ô trang chủ, cùng đường dẫn) có 3 tab: **Quét** (ô quét UID + ô Mét thực tế) · **Chờ in** (UID mọi SKU, nút In A4) · **Đã in** (lọc theo mã hàng + ngày, in lại, Excel).
  - Bấm In A4 → khung nhập **Mã hàng** (ví dụ `CWSH02`) → phiếu A4 ngang nhiều trang, **biển lớn "mã hàng + Xả dd/mm/yyyy" ở đầu mỗi trang** (như tờ treo người dùng gửi ảnh).
  - UID sang "Đã in" khi agent báo xong và lưu theo mã hàng để in lại; lệnh lỗi hoặc huỷ thì UID về "Chờ in".
  - Thẻ trạng thái máy in A4 riêng (sẵn sàng / mất kết nối), không lẫn với máy in tem.
- **Số đo thật (04/11/2026, máy dev DESKTOP-P19CGH6):**
  - `Get-Printer` thấy máy in là **kết nối chia sẻ** `\\DESKTOP-foq5t89\HP LaserJet Professional P 1102w` (Type = Connection, USB003); máy gắn USB thật là **DESKTOP-foq5t89**.
  - Agent cũ chỉ TSPL RAW cho máy tem TSC; P1102w là máy in host-based (GDI), không nhận RAW → cần đường in qua driver Windows.
  - Hàng đợi chia việc theo capability (`print_agent_claim`): loại lệnh mới + capability mới là cách định tuyến sang máy A4, không cần cột máy đích.
  - Web chọn "máy in đang sống" bằng agent có `last_seen_at` mới nhất, không lọc capability → khi agent A4 chạy, thẻ máy in tem đọc nhầm; đã sửa (Việc 3a) và phải lên TRƯỚC agent A4.
  - Số lượng Group UID vải tính bằng **gram** (qty 16763 g, 155gsm × 178cm ≈ 60.758 mm); `group_uid_lookup` không trả qty → quy đổi ở máy chủ.
  - `CWSH02` không phải SKU (mọi SKU là số 9 chữ số): chỉ nằm trong tên SKU quần mẫu `Quần mẫu FT/CWSH02/…` → mã hàng là mã kiểu hàng, nhập tay lúc in.
  - `may-kho-02` có sẵn ở `print_agents` nhưng dành cho máy tem TSC thứ hai, chưa cài; không dùng lại cho máy A4.
- **Đã chốt:**
  - **Đ1 · Thay luồng cũ** (người dùng "Chốt, build"): bỏ giờ bắt đầu / kết thúc xả, "1 UID đang xả", tự làm mới 15 giây của bản 26/09 (N0350, N0355, N0357, N0367, N0400). Bảng `xa_vai_log` và hàm `xa_vai_*` cũ giữ ở server, web không gọi.
  - **Đ3 · Mét thực tế:** tối đa 2 chữ số thập phân, `,` hoặc `.`, > 0; lệch > 20% so với mét hệ thống thì hỏi `WhDialog`; mỗi UID một số mét, sửa / xoá được khi còn "Chờ in".
  - **Đ4 · Hàng đợi lưu Supabase** (25/10 · N1212): ghi = máy đã kích hoạt (`floor_access_check`), xem = mọi người; nhiều máy dồn vào một hàng đợi.
  - **Đ5 · Bấm In:** máy chủ dựng payload từ DB, ≤ 100 UID / lệnh (web tự chia), 1–5 bản; xong → "Đã in"; `failed` / huỷ → "Chờ in" bằng trigger.
  - **Đ6 · Phiếu A4 ngang** "PHIẾU THEO DÕI XẢ VẢI": biển lớn đầu mỗi trang; cột STT · Group UID · SKU · Lot · Roll · Hệ thống (mm) · Thực tế (mm) · Chênh lệch (mm) · Giờ nhập; chân phiếu TỔNG + hai ô ký (Người xả · Người kiểm). Số dòng mỗi trang theo chiều cao biển.
  - **Đ7 · Agent A4** = cùng mã nguồn, bản 0.11.0, `PRINTER_KIND=a4`; capability duy nhất `xa_vai_sheet:v1`; `label` (mặc định) giữ nguyên; `PRINTER_KIND` lạ → agent từ chối khởi động (ghi `agent.log`).
  - **Đ8 · Máy chạy agent = DESKTOP-foq5t89** (người dùng chốt 04/11; máy cắm USB, in cục bộ, `PRINTER_NAME=HP LaserJet Professional P 1102w`, khác máy in tem `may-kho-01`).
  - Lưu ý cài: `install-agent.ps1` chạy task bằng SYSTEM; SYSTEM không thấy máy in chia sẻ do người dùng thêm riêng → trên máy khác phải thêm kết nối cấp máy (`printui /ga`).
  - **Đ9 · Định danh** `may-a4-01` ("Máy in A4"), token sinh trên máy dev, chỉ ở `.env` ngoài git; đăng ký kèm `allowed_capabilities = {xa_vai_sheet:v1}`.
  - **Đ10 · Đơn vị so sánh = mm** (người dùng chốt 04/11): qty WMS đổi ra mm ở máy chủ theo trường cuối tên SKU (`m` × 1000; `mm`; `g` × 1000 ÷ (GSM × khổ m)); lưu `system_mm` / `actual_mm`; màn hình hiện mét (mm ÷ 1000), phiếu A4 và Excel hiện mm nguyên (Đ13).
  - **Đ11 · Mã hàng nhập lúc in** (người dùng chốt 04/11 sau ảnh tờ treo): chọn UID rồi bấm In → khung nhập Mã hàng (viết hoa, `A-Z 0-9 . _ -`, ≤ 40); màn quét không có ô Mã hàng, UID mọi SKU; lưu theo mã hàng để lọc và in lại (mỗi phiếu một mã hàng).
  - **Đ12 · Ngày xả** = ngày nhập mét (`measuredAt`, giờ Việt Nam) của các dòng trên phiếu; nhiều ngày thì in khoảng.
  - **Đ13 · Bỏ "Độ co %"; phiếu A4 và Excel dùng mm** (người dùng chốt 04/11): không còn cột / số co ở đâu; cột Hệ thống, Thực tế, Chênh lệch của phiếu và Excel là số nguyên mm; màn hình (ô nhập, Chờ in, Đã in) giữ mét.
  - **Đ14 · Quét → tự tra → pop-up nhập mét** (người dùng yêu cầu 04/11 trên điện thoại Honeywell): đủ 16 chữ số trong ô quét thì tự tra (chỉ đọc; ghi vẫn Enter / Lưu), UID chưa in mở pop-up nhập mét ngay (neo đầu màn trên điện thoại, cao ~270 px vì Honeywell 360 × ~670 px chỉ còn ~290 px phía trên bàn phím số); UID đã in / đang in hiện thẻ báo, không pop-up.
- **Hợp đồng dữ liệu hiện hành (V3):**
  - Bảng `xa_vai_measures`: `group_uid_code` (PK) · `sku` · `item_code` · `batch_code` · `roll_code` · `system_qty` · `system_mm` · `actual_mm` · `measured_at` · `device_id` · `status` (`pending` / `printing` / `printed`) · `print_job_id` · `printed_at`. RLS bật, không policy.
  - Đọc (anon): `xa_vai_measure_lookup`, `xa_vai_measure_list(p_item_code, p_status)`, `xa_vai_measure_search(p_item_code, p_sku, p_date_from, p_date_to, p_limit)`.
  - Ghi (khoá máy): `xa_vai_measure_save(p_access_token, p_group_uid, p_actual_mm, p_replace)`, `xa_vai_measure_delete`, `xa_vai_print_enqueue(p_access_token, p_uids, p_copies, p_nonce, p_reprint, p_item_code)`.
  - Lệnh in `xa_vai_sheet` v1: `copies` = số bản cả phiếu (1–5); `payload = { itemCode, productName (chỉ khi một SKU), printedAt, reprint, items: [{ groupUid, sku, lot, roll, systemMm, actualMm, measuredAt }] }`.
  - Lỗi `{ ok:false, error:{ code, message } }`: `INVALID_UID`, `GROUP_UID_NOT_READY`, `ALREADY_MEASURED`, `NOT_PENDING`, `NOT_FOUND`, `INVALID_QTY`, `INVALID_ITEM_CODE`, `MIXED_ITEM_CODE`, `INVALID_JOB`, `ACCESS_DENIED`.
  - Chi tiết từng phiên bản của hợp đồng ở các tệp `CONTRACT*.md` trong thư mục tạm của phiên (không vào git); hợp đồng hiện hành là mục này.
- **Rủi ro và cách chặn:**
  - **Agent A4 cấu hình sai thành agent tem** → máy chủ `print_agents.allowed_capabilities` (claim chỉ giao phần capability cho phép) + agent từ chối `PRINTER_KIND` lạ.
  - **Thẻ máy in tem đọc nhầm máy A4** → web lọc agent theo capability, lên trước agent A4; `print_queue_status` đếm riêng `queuedA4`.
  - **In trùng phiếu** → sổ tay `sent-journal` và nonce: đã gửi xuống spooler mà mất kết nối thì chỉ báo `SENT_UNCONFIRMED`, không in lại.
  - **UID kẹt ở `printing`** → trigger đưa về `pending` khi `failed` / huỷ; lệnh hết lease quay về `queued`.
  - **P1102w ngủ / báo Offline** trên USB: agent coi là "máy in chưa sẵn sàng", lệnh chờ; ngưỡng kẹt 10 phút của `waitForSpooler` giữ nguyên.
  - **Nhiều phiên cùng sửa `index.html`:** phần của đợt này chỉ trong khối `xa-vai`; commit tách hunk, không đụng hunk phiên khác.
- **Chưa kiểm được bằng máy (người dùng thử thật):** in giấy A4 thật trên P1102w (lề, nét chữ, biển lớn, khi máy vừa ngủ dậy); agent trên DESKTOP-foq5t89 tự chạy lại sau khởi động; máy quét Honeywell và camera điện thoại; nhiều máy cùng quét.

## Kế hoạch
Thứ tự đã chạy: Việc 0 → (Việc 1 ∥ Việc 2 ∥ Việc 3a) → Việc 3b → đợt sửa 1 (review vòng 1, đơn vị mm) → đợt sửa 2 (mã hàng nhập lúc in, biển lớn, bỏ Co %, review vòng 2 và 3). Còn lại: Việc 4 (phát hành) và Việc 5 (hoàn tất tài liệu).

### Việc 0 — Đo và chốt · lead · [x]
- [x] Người dùng chốt Đ1, Đ6, Đ8 ("Chốt, build"; máy DESKTOP-foq5t89), Đ10 (mm), Đ11 (mã hàng lúc in), Đ12 (ngày xả), Đ13 (bỏ Co %, mm ở phiếu và Excel).
- [x] Đo chỉ đọc (Supabase MCP): qty UID vải tính bằng gram; `print_agents` có `may-kho-01`, `may-kho-02`; `CWSH02` không phải SKU (SKU_Name 22.867 dòng đều là số). Không ghi SKU / UID thật vào git.
- [x] Thử đường in qua driver bằng "Microsoft Print to PDF" (PowerShell `PrintDocument`, A4 ngang): 2 trang × 2 bản ra PDF 4 trang.

### Việc 1 — SQL · thuc-thi-logic · [x] viết xong + test tĩnh; CHƯA chạy migration
- Tệp: `supabase/xa_vai_a4_v1.sql` (dòng `-- kiem:` chỉ đọc, khối `-- Rút lui`).
- [x] Bảng `xa_vai_measures` (`item_code`, `system_mm`, `actual_mm`) + RPC đọc / ghi; hàm mới `revoke … from public, anon, authenticated` rồi `grant` đúng vai; ghi qua `floor_access_check`.
- [x] `print_jobs.type` thêm `xa_vai_sheet`; `print_agent_claim` chép `backend_hygiene_v1.sql` + nhánh A4 + `allowed_capabilities`; `print_queue_status` tách `queuedA4`; trigger `xa_vai_measures_sync_job` (khoá thứ tự, xoá `item_code` khi lỗi / huỷ).
- [x] Test tĩnh `tests/xa_vai_a4_sql.cjs` PASS (20/20 đột biến bị bắt) + 5 test SQL cũ PASS + `--dry-run` tới cuối; dòng `-- kiem:` đã qua phân tích cú pháp trên Supabase (lỗi duy nhất là hàm chưa tồn tại) sau khi sửa lỗi `andexists` do review vòng 3.
- [ ] Đăng ký agent `may-a4-01` (hàng `print_agents`, token băm, `allowed_capabilities = {xa_vai_sheet:v1}`; token thật chỉ ở `.env` ngoài git) — làm ở Việc 4.

### Việc 2 — Agent 0.11.0 · thuc-thi-logic · [x] viết xong + test; CHƯA in giấy thật, CHƯA cài lên máy
- [x] `PRINTER_KIND` (`label` mặc định | `a4`); capability theo chế độ; giá trị lạ → từ chối khởi động và ghi `agent.log`.
- [x] `xa-vai-sheet.mjs`: SVG → PNG 300 dpi A4 ngang; biển lớn đầu mỗi trang (mã hàng + `Xả dd/mm/yyyy`); cột SKU; Hệ thống / Thực tế / Chênh lệch bằng mm nguyên; 18 dòng / trang; TỔNG + hai ô ký ở trang cuối; "IN LẠI".
- [x] `print-bitmap.ps1` (PrintDocument qua driver; số bản lặp trong một tài liệu); `normalizeJob` nhận `itemCode`, `sku` từng dòng.
- [x] Test `workstation-agent/tests/xa-vai-sheet-0110.test.mjs`; `cd workstation-agent && node --test` toàn bộ PASS; ảnh xem trước đã duyệt.
- [x] Mã hàng dài bị cắt "…" trên biển thì in đủ ở dòng nhỏ `Mã hàng: <đầy đủ>` dưới biển (review vòng 3; `node --test` 236/236 PASS, đã xem ảnh `xvma22` / `xvma40`).

### Việc 3a — Web: lọc thẻ máy in theo capability · lead · [x]
- [x] `PrintSkuQueue.latestAgent(agents, "label" | "a4")` ở ba chỗ (`pr_hangdoi`, thẻ ở IN TEM GROUP UID, thẻ ở Lệnh in Admin); test `tests/printer_pill_capability_browser.cjs` (đỏ trước, xanh 5/5); `tests/print_jobs_admin_browser.cjs` thêm `capabilities` cho đúng dạng phản hồi thật.
- Phải lên TRƯỚC khi agent A4 chạy lần đầu; commit và push riêng, không cần migration.

### Việc 3b — Web: màn `#xa-vai-screen` · thuc-thi-logic · [x] viết xong + test; CHƯA thử máy quét / camera / Excel thật
- [x] Ba tab Quét / Chờ in / Đã in; tab Quét không có ô Mã hàng; Chờ in mọi SKU + khung nhập Mã hàng khi In; Đã in lọc theo mã hàng, in lại, Excel mm nguyên; màn hình hiện mét; thẻ máy in A4 theo capability.
- [x] Lỗi mạng khi In báo "chưa rõ", 4xx báo "chưa gửi được"; theo dõi dòng `printing` của máy khác bằng `printJobId`; `tests/xa_vai_a4_browser.cjs`, `tests/floor_access_browser.cjs` PASS; bộ chuẩn UI PASS.
- [x] Giới hạn dừng theo dõi không bị bật lại (`paused`), ô lọc mã hàng báo lỗi thay vì xoá ký tự, báo lỗi tải dùng `PrintSkuNotice.retry` (review vòng 3; `xa_vai_a4_browser` PASS, test đỏ trước rồi xanh).

### Việc 4 — Phát hành · lead (+ người dùng) · [ ]
Thứ tự theo luật 4 và quyết định 21/10 ("cài agent trước khi push web, in thử thật"):
- [x] Cả bộ `python scripts/run_tests.py` (kiem-thu, 04/11 ~14:00): 141/142 PASS; hỏng duy nhất `sku_catalog_screens_browser` chập chờn khi cả bộ tải nặng (PASS 7/7 lần chạy riêng); `commit_gate` 1 mục KHÔNG ĐẠT là báo nhầm (`workstation-agent/package.json` báo nhầm vì lúc đó còn thêm script `preview:xavai`; đã bỏ script, gate chỉ cho đổi dòng `version` 0.10.2 → 0.11.0, xem trước bằng `node src/cli.mjs preview --type xa_vai_sheet`).
- [ ] Commit và push RIÊNG hunk Việc 3a (thẻ máy in theo capability); các phần còn lại commit nhưng CHƯA push.
- [ ] Migration: `python scripts/apply_supabase_sql.py supabase/xa_vai_a4_v1.sql --dry-run --allow-destructive`, rồi chạy thật (người dùng cho phép rõ `--allow-destructive`); kiểm chỉ đọc (dòng `-- kiem:` + thử bằng dữ liệu giả); ghi `RULES.md`; sau commit ghi sổ `release_ledger`.
- [ ] Tạo hàng `print_agents` `may-a4-01` (token băm, `allowed_capabilities = {xa_vai_sheet:v1}`); token vào `.env` của máy in, ngoài git.
- [ ] **Người dùng** cài agent 0.11.0 trên DESKTOP-foq5t89 bằng `install-agent.ps1` (`AGENT_ID=may-a4-01`, `PRINTER_NAME=HP LaserJet Professional P 1102w`, `PRINTER_KIND=a4`); log khởi động phải có `xa_vai_sheet:v1`.
- [ ] In thử thật một phiếu 2 trang bằng dữ liệu giả (SKU `9000000xx`, UID `1028260000000xxx`, mã hàng thử): xem lề, biển (treo cách 1,5 m), tổng.
- [ ] Push màn mới; thử luồng từ máy xưởng.

### Việc 5 — Tài liệu · lead · [x]
- [x] `docs/QUYET_DINH.md` mục "Xả vải", `docs/PROJECT_MAP.md`, `docs/CONTEXT_MAP.md`, `docs/chuan/MA_WEB.md`, `docs/chuan/GIAO_DIEN.md`, `README.md`, `workstation-agent/README.md`, `workstation-agent/docs/QUEUE_CONTRACT.md`; nhật ký `RULES.md` mục `N20261104-1700`, `N20261104-1930`.
- [ ] Dòng nhắc commit kèm danh sách tệp khi xong.

## Phát sinh
- 04/11/2026 Việc 3c — Web: pop-up nhập mét + tự tra (Đ14) · lead · [x] viết xong + test (`xa_vai_a4_browser` phần `popupScan`); CHƯA thử máy Honeywell thật (bàn phím số, máy quét có / không Enter), CHƯA commit.
  - Gồm `#xa-vai-uid-dialog`, `#xa-vai-note`, tự tra khi đủ 16 chữ số, chống tra trùng + Enter đến muộn.
  - Codex vòng 1 (ảnh) và vòng 2 (phần vừa sửa) sửa 6 điểm: lỗi mạng khi tra tiếp, rời màn lúc đang lưu, Enter chỉ lưu khi ô mét đã đổi, nhãn Mét thực tế + bố cục, chốt Enter ở `submit` (nút Lưu `type="button"`), tra nền trả muộn sau khi quay lại.

## Lệch kế hoạch
- 04/11/2026 Việc 1: kế hoạch ghi chép nguyên văn `print_agent_claim` từ `print_sku_v3_v1.sql`; đối chiếu bản đang chạy (Supabase MCP chỉ đọc) thấy bản mới nhất là `backend_hygiene_v1.sql` (có `agent_id is null or agent_id=p_agent_id`, hai khối trả lease) → migration mới xuất phát từ bản đó;
  - `print_queue_status` bản mới nhất ở `print_devices_v1.sql` (kiểm khoá máy). Báo người dùng cùng tin nhắn bắt đầu build.
- 04/11/2026 Số lượng hệ thống của UID vải tính bằng gram → thêm bước quy đổi sang mét ở máy chủ (cột "Mét hệ thống" của phiếu). Báo người dùng cùng tin nhắn bắt đầu build.

## Nhật ký
- 2026-11-04 Việc 2 xong (agent thuc-thi-logic, 215 nghìn token, 15 phút): áp patch vào cây chính, `node --test` 222/222. Quyết định lọc: (1) dòng tổng chênh lệch tính trên dòng có mét hệ thống — đúng hơn hợp đồng ghi "tổng thực tế − tổng hệ thống", thêm chú thích; (2) số bản lặp trong một tài liệu thay vì `Copies = N`: chấp nhận;
  - (3) `productName` > 180 ký tự cắt chứ không từ chối: chấp nhận; (4) agent A4 không tải danh mục SKU (`catalogEnabled` thêm `printerKind !== "a4"`): chấp nhận; (5) `printedAt`/`measuredAt` đòi ISO CÓ múi giờ — SQL trả `…Z` nên qua. Chưa kiểm: in giấy thật trên P1102w, bù lề cứng khi in ngang, tìm job spooler của máy in kết nối chia sẻ.
- 2026-11-04 Việc 1 xong (agent thuc-thi-logic, 200 nghìn token, 10 phút): đọc migration cả 549 dòng, áp patch vào cây chính. Quyết định lọc câu hỏi của agent: (1) bỏ tên WMS dự phòng cho `systemM` (`group_uid_details` không có cột tên sản phẩm; SKU không có trong `SKU_Name` thì "—"); (2) chặn sớm mã agent không in được: làm;
  - (3) Admin in lại lệnh A4 từ màn Lệnh in báo `INVALID_JOB`: chấp nhận, in lại đi qua màn xả vải; (4) `SENT_UNCONFIRMED` trả UID về "Chờ in": chấp nhận, người dùng quyết in lại. Lưu ý lúc chạy thật: migration có `drop constraint` nên cần `--allow-destructive` → xin người dùng cho phép rõ.
- 2026-11-04 Lập kế hoạch sau khi đọc `AGENTS.md`, `docs/QUYET_DINH.md` (chủ đề 3, 6, 9, 11), agent 0.10.2 (`agent.mjs`, `printer.mjs`, `job-validator.mjs`, `config.mjs`), `print_agent_claim` bản `print_sku_v3_v1.sql`, `xa_vai_log_v1.sql`, khối `xa-vai-script`; đo `Get-Printer` trên máy dev. Chưa sửa mã, chưa chạy migration.
- 2026-11-04 Review vòng 1 (Codex 3 nhóm, Claude A 2 nhóm, Claude BC 8 nhóm; co-van Fable lọc 11 vấn đề gốc):
  - NÊN SỬA — chặn agent A4 cấu hình sai (máy chủ `allowed_capabilities` + agent từ chối `PRINTER_KIND` lạ), lỗi mạng khi In báo "chưa rõ" + theo dõi dòng `printing` bằng `printJobId`, Lot/Roll bị cắt, hàng chờ lẫn SKU, deadlock trigger, thứ tự push, tài liệu.
  - BỎ QUA có lý do — nonce trùng (hành vi có sẵn của `print_enqueue`), `exit 1` (lead và co-van đều thử thật: host vẫn sống), `spoolConfirmed=false` (đã chốt Đ8). Người dùng chốt thêm Đ10 (mm).
- 2026-11-04 Đợt sửa 1 (ba agent trên cây chính + lead): SQL xong (`xa_vai_a4_v1.sql` 575 dòng, test tĩnh PASS, dry-run tới cuối); agent xong (`node --test` 227/227; lead nới cột Lot/Roll 560 px để Lot tới 28 ký tự in đủ, cột Group UID 440); web: đang chạy. Còn: review vòng 2 (`--since last`), cả bộ test, commit_gate, tách commit 3a, phát hành.
