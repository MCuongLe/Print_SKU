# Print SKU — WH-MATERIAL

Công cụ kho xưởng may Hasaki chạy trên trình duyệt: in tem SKU, Group UID, vị trí; cắt, cấp vải, lựa UID blocked, trả nhà cung cấp, xả vải; kiểm tra đầu vào, kiểm kê, rủi ro lưu trữ; đối chiếu với Inside và WMS.

Thành phần: trang tĩnh `index.html` (GitHub Pages) · Chrome Extension `extension/inside-po-connector` đọc Inside / WMS trong tab đã đăng nhập · Supabase (RPC, RLS, cron, Edge Function) · agent in `workstation-agent` trên máy trạm. Sơ đồ: `docs/CONTEXT_MAP.md`.

README mô tả hành vi hiện tại. Lịch sử thay đổi ở nhật ký `RULES.md` (chỉ trên máy) và lịch sử git.

## Mục lục

- [Chạy, kiểm thử, lên bản](#chạy-kiểm-thử-lên-bản) · [Tài liệu](#tài-liệu)
- In tem: [IN TEM SKU](#in-tem-sku-worker) · [IN TEM GROUP UID](#in-tem-group-uid-group-uid) · [MÃ VỊ TRÍ](#mã-vị-trí-location) · [TRỢ LÝ IN](#trợ-lý-in-assistant)
- Vận hành kho: [CẮT GROUP UID](#cắt-group-uid-cut-group-uid) · [LỊCH SỬ GROUP UID](#lịch-sử-group-uid-uidhist) · [TÌM SKU](#tìm-sku-find-sku) · [CHUYỂN ĐỔI ĐƠN VỊ](#chuyển-đổi-đơn-vị-unit-converter) · [THEO DÕI XẢ VẢI](#theo-dõi-xả-vải-xa-vai) · [TÌM GROUP UID](#tìm-group-uid-cap-vai--uid-block--tra-ncc)
- Kiểm tra: [KIỂM TRA ĐẦU VÀO](#kiểm-tra-đầu-vào-inspection) · [RỦI RO LƯU TRỮ](#rủi-ro-lưu-trữ-storage-risk) · [KIỂM KÊ SKU](#kiểm-kê-sku-inventory-audit) · [KIỂM SOÁT CÔNG TRÌNH](#kiểm-soát-công-trình-site-control)
- Quản trị: [KÍCH HOẠT MÁY](#kích-hoạt-máy) · [QUẢN TRỊ](#quản-trị-admin)
- Nền: [Dữ liệu và đồng bộ](#dữ-liệu-và-đồng-bộ) · [Agent máy trạm](#agent-máy-trạm) · [Chuẩn giao diện](#chuẩn-giao-diện)

## Chạy, kiểm thử, lên bản

**Chạy cục bộ**

```powershell
python -m http.server 8000
```

Mở `http://localhost:8000/`. Không mở thẳng tệp: camera cần `https://` hoặc localhost.

**Kiểm thử**

- Cả bộ: `python scripts/run_tests.py` (chạy nền, tự chạy lại test hỏng một lần). Một test: `--only <tên>`. Playwright nạp qua biến `PLAYWRIGHT_MODULE`.
- `tests/a11y_axe_browser.cjs` cần `npm install` một lần ở gốc repo (axe-core chỉ dùng khi test; `node_modules/` không commit).
- Agent máy trạm: `node --test` trong `workstation-agent`.
- Cổng trước commit: `python scripts/commit_gate.py --cached`. Luật viết test và commit: `docs/chuan/KIEM_THU_GIT.md`.

**Migration Supabase**

```powershell
python scripts/apply_supabase_sql.py supabase/<tệp>.sql --dry-run
python scripts/apply_supabase_sql.py supabase/<tệp>.sql
```

- Cần personal access token `sbp_…` (tạo ở Supabase Dashboard → Account → Tokens) trong biến môi trường `SUPABASE_ACCESS_TOKEN` hoặc tệp `.env` ở gốc repo (`.env` không vào git). Script không in token.
- Cầu dao: tệp có `DROP`, `TRUNCATE`, `DELETE FROM` ở cấp cao nhất phải thêm `--allow-destructive`; câu lệnh trong thân hàm `$$ … $$` không tính.
- Chạy xong script liệt kê bảng và hàm trong schema `public` để đối chiếu. Hàm nào ở tệp nào: `docs/PROJECT_MAP.md` mục 4.

**Edge Function**

- Deploy: `python scripts/deploy_<tên>.py [--dry-run]` với `sku-sync`, `group-uid-sync`, `print-assistant`, `sku-vision` (token cần quyền Edge Functions: write).
- Secrets nhập ở Supabase Dashboard → Edge Functions → Secrets, không bao giờ nằm trong `index.html` hay Extension:
  - `GEMINI_API_KEY` — TÌM SKU đọc tem, Trợ lý in khi không có khoá Anthropic.
  - `ANTHROPIC_API_KEY` — Trợ lý in (ưu tiên khi có); tuỳ chọn `ANTHROPIC_MODEL`, `GEMINI_ASSISTANT_MODEL`.
  - Tuỳ chọn `sku-vision`: `GEMINI_MODELS` (thứ tự model), `SKU_VISION_GLOBAL_DAILY` (mặc định 450 lượt/ngày cả kho), `SKU_VISION_DEVICE_DAILY` (mặc định không giới hạn theo máy), `SKU_VISION_HEDGE_MS` (mặc định 6000).
- Gói miễn phí Gemini: Google được dùng ảnh gửi lên để cải thiện sản phẩm; hạn mức tính theo ngày giờ Pacific.

**Chrome Extension**

- Chrome không cho trang web tự cài Extension. Bản nội bộ: mỗi máy cài một lần bằng **Load unpacked** thư mục `extension/inside-po-connector`; triển khai rộng: Chrome Web Store Unlisted hoặc IT cài bằng Chrome Enterprise Policy.
- Đổi bản: Reload ở `chrome://extensions`, rồi tải lại tab Inside / WMS. Đăng nhập Admin, tên máy và đồng bộ tự động ở trang Options của Extension. Chi tiết: `extension/inside-po-connector/README.md`.

**Lên bản**

- Push `main` là web lên ngay (GitHub Pages).
- Web cần hàm / cột / Edge mới: commit (chưa push) → migration → deploy Edge → Reload Extension → cài agent nếu đổi mẫu tem (in thử) → push.

## Tài liệu

| Tệp | Nội dung |
|---|---|
| `AGENTS.md` | Luật chung, thứ tự đọc, bốn luật cứng |
| `docs/CONTEXT_MAP.md` | Bản đồ 6 nguồn ngữ cảnh, gói repomix |
| `docs/PROJECT_MAP.md` | Module ↔ khối `index.html` ↔ Extension ↔ Edge ↔ SQL ↔ test |
| `docs/QUYET_DINH.md` | Quyết định đang hiệu lực, trạng thái lên thật |
| `docs/chuan/` | Chuẩn tài liệu, giao diện, mã web, dữ liệu, kiểm thử / git |
| `docs/DOI_AGENT.md` | Quy trình làm việc của đội agent |
| `docs/plans/` | Kế hoạch việc nhiều bước |
| `workstation-agent/README.md` | Cài và vận hành agent in |
| `extension/inside-po-connector/README.md` | Cài và vận hành Extension |

## IN TEM SKU (`#worker`)

- Dùng để: in tem SKU (tên, QR, SKU) cho phụ liệu, chỉ, vải.
- Ai dùng: Worker · điện thoại và máy tính; Phiếu IT chỉ Admin trên máy tính.
- Màn: bundle React `worker-bundle`, `sku-queue-ui-script`, `sku-it-script`, `sku-po-pick-script`.
- Dữ liệu: `SKU_Name` (danh mục trên máy `PrintSkuCatalog`), `print_enqueue`, `sku_po_lookup`; Extension `GET_INTERNAL_TRANSFER`.
- Test: `sku_queue_browser`, `sku_it_browser`, `sku_po_reprint_browser`, `scanner_states_browser`, `print_renamed_browser`.

Nhập hoặc quét SKU (camera, máy quét cầm tay; bàn phím ảo ẩn mặc định), tên tự điền từ danh mục, nhập số lượng in lên tem và số bản rồi **Thêm vào danh sách**. SKU Combo hỏi chọn SKU Normal. Danh sách có ô chọn để xoá nhiều, **Sửa**, **Xoá**; **In tem** in cả danh sách (≤ 100 SKU, ≤ 500 tem một lệnh).

Tên trên tem luôn theo database: SKU có trong danh mục thì máy chủ thay tên khác và báo "Tên đã cập nhật". SKU ngừng hoạt động không được gợi ý và bị máy chủ chặn khi in (`SKU_INACTIVE`).

**Phiếu IT** (icon phiếu, Admin, cần tab WMS): nhập số phiếu chuyển kho nội bộ → đọc các dòng, số lượng đúng theo phiếu, số bản mặc định 1 → thêm vào danh sách. SKU ngoài danh mục bị bỏ tick.

**In lại tem có PO**: quét SKU đã từng in tem Phụ liệu có PO → chọn PO (nhiều PO thì pop-up, một PO chọn sẵn) → tem mẫu v3 có khung PO + ngày nhận. Cùng SKU khác PO trong danh sách bị chặn. Cần agent khai `sku:v3`.

## IN TEM GROUP UID (`#group-uid`)

- Dùng để: in tem cuộn vải theo Group UID (SKU, tên, Lot, Roll, PO, ngày nhận).
- Ai dùng: Worker; Lấy từ WMS và Gán WMS chỉ Admin trên máy tính.
- Màn: `#uid-screen`, `uid-wms-script`, `uid-po-script`.
- Dữ liệu: RPC `group_uid_lookup` (≤ 100 mã), `print_enqueue` loại `group_uid`; Extension `GET_GROUP_UID_NEW_PAGE`, `GET_PACKING_LIST_PAGE`.
- Test: `group_uid_browser`, `group_uid_mockup_browser`, `group_uid_wms_picker_browser`, `group_uid_po_browser`, `group_uid_po_date_browser`, `group_uid_new_core`, `packing_list_core`.

Quét, gõ hoặc Nhập Excel Group UID → tra `group_uid_lookup`: UID đủ SKU và tên sang **Sẵn sàng in**, còn lại vào **Chưa gán SKU**. Mỗi UID một tem; Lot = Batch Code, Roll = Roll Code (phần Roll lặp Lot được cắt khi in). Tay kéo ⋮⋮ đổi thứ tự UID chờ gán.

**Gán SKU** có ba tab: theo tick chọn; **Gán tự động** (SKU + số UID nhập tay); **Gán WMS** (Admin) đọc Packing List của PO — mỗi dòng Approved là một cuộn, Combo đổi sang Normal, gán UID chờ theo thứ tự, không gán Lot / Roll (WMS gán khi nhận hàng).

**Lấy từ WMS** (Admin): đọc UID trạng thái New của kho WH - MATERIAL - MTG và WH - MATERIAL - GARMENT, lọc kho / ngày tạo / người tạo / đợt tạo trên trình duyệt (WMS không lọc được ngày tạo, người tạo), rồi thêm theo đường nhập tay.

**Sẵn sàng in** có ô Số PO và Ngày nhận (tuỳ chọn): tem vẽ ô SỐ PO | NGÀY NHẬN. PO lấy từ Gán WMS được ưu tiên; PO ≤ 20 ký tự gồm chữ, số, `. _ / -`. Cần agent ≥ 0.10.0.

## MÃ VỊ TRÍ (`#location`)

- Dùng để: in tem QR dán kệ (mã + tên vị trí).
- Ai dùng: Worker.
- Màn: `#location-screen`, `location-theme`.
- Dữ liệu: `print_enqueue` loại `location` (không có bảng vị trí); hàng đợi trên máy `location-queue-v1`.
- Test: `location_browser`; agent `node --test` trong `workstation-agent`.

Nhập **Mã vị trí** (chữ hoa không dấu, số, `. _ / -`, ≤ 40 ký tự), **Tên vị trí** (≤ 60, tuỳ chọn), **Số tem** (1–500) → **Thêm vào hàng đợi**. Hoặc **Nhập file Excel**: template import vị trí của WMS (cột Code, hoặc ghép 6 cột Floor…Bin; tên ở Bin Location Description) hoặc bảng Location / Description. Mã trùng và dòng sai bị bỏ, có báo số dòng.

Hàng đợi lưu trên máy (≤ 500 vị trí): tick chọn, sửa số tem, **In N tem**; tự chia lệnh ≤ 100 vị trí / ≤ 500 tem; in xong rời hàng đợi, lỗi thì giữ lại; gửi lại dùng cùng nonce. Tem 40 × 60 mm: QR + mã Arial đậm + tên; chữ được đo thật, không cắt ký tự. Không có xem trước. Cần agent ≥ 0.8.7 (`location:v1`); tem không tên cần ≥ 0.8.8.

## TRỢ LÝ IN (`#assistant`)

- Dùng để: in tem SKU theo phiếu IT bằng câu nói; dựng Packing List cấp vải từ danh sách Group UID.
- Ai dùng: Admin · máy tính ≥ 801 px, cần tab WMS.
- Màn: `print-assistant-style` / `-script`, `assistant-pl-style` / `-script`, `#assistant-screen`.
- Dữ liệu: cổng `window.HasakiSkuIt`; Edge `print-assistant`; RPC `fabric_issue_lookup_uids`, `fabric_issue_import`.
- Test: `print_assistant_browser`, `print_assistant_function`, `assistant_pl_browser`, `fabric_issue_lookup_sql`.

Gõ hoặc nói (nút mic, `vi-VN`) câu như `IT 100000001, 2 bản` → đọc phiếu trên WMS → thẻ xác nhận (dòng, số bản, tổng tem) → **In**. Không bao giờ in thẳng từ câu nói. Câu có số phiếu đi thẳng bộ phân tích trên máy; câu tự do mới gọi Edge `print-assistant` (Anthropic nếu có khoá, không thì Gemini). Edge lỗi vẫn gõ được `IT <số phiếu> [N bản]`.

**Packing List cấp vải**: dán, gõ, kéo thả hoặc đính kèm (.xlsx, .csv, .txt) danh sách Group UID (16 số bắt đầu `1028`, từ 2 UID) → tra dữ liệu đồng bộ → thẻ Packing List: tên đợt gợi ý, mỗi cuộn một hàng, số mét đổi theo đuôi tên SKU (`/mm`, `/cm`, `/m`) → **Tạo đợt** cấp vải hoặc **Tải PL** (.xlsx nhập lại được ở Cấp vải). Ô Excel kiểu số ≥ 10^15 không dùng làm UID (Excel chỉ giữ 15 chữ số).

Tạo đợt bị rớt mạng hay quá giờ: thẻ báo "chưa rõ" và khoá, chờ 20 giây rồi tìm đợt theo mã thao tác; thấy thì coi như đã tạo, không thấy mới cho gửi lại.

## CẮT GROUP UID (`#cut-group-uid`)

- Dùng để: ghi nhận cuộn đã cắt, in tem lại, đối chiếu lệnh ADJ trên WMS; lấy mẫu cắt / QC theo PO.
- Ai dùng: Worker trên máy đã kích hoạt; xoá UID đã cắt và quản lý phiên PO chỉ Admin.
- Màn: `#cut-group-uid-screen`, `cut-sample-core`, `cut-sample-script`.
- Dữ liệu: bảng `cut_group_uids`, `cut_sample_*`; RPC `cut_group_uid_*`, `cut_sample_*`; Extension đọc lịch sử Group UID và UID theo PO.
- Test: `cut_group_uid_browser`, `cut_sample_browser`, `cut_sample_core`, `cut_adj_reconcile_browser`, `cut_adj_core`, `cut_group_uid_po_date_browser`, `cut_group_uid_po_sql`.

Bốn tab: **Quét** · **Tra cứu** · **Tem chờ in** · **Đối chiếu**. Quét UID → lưu SKU, UID, Lot, Roll, tên (trạng thái in `pending`); UID không có dữ liệu, thiếu SKU / tên hoặc đã cắt bị chặn. Trạng thái in lưu Supabase; Tem chờ in là rổ tạm trong trình duyệt (chọn ở Tra cứu). Mỗi lệnh ≤ 100 tem, in lại được UID đã in, gửi lại dùng cùng nonce.

Tra cứu lọc SKU, Lot, PO (khớp đúng), ngày cắt; xuất Excel A4 ngang. Bấm UID mở barcode để quét vào phiếu ADJ rồi tick **Đã xuất ADJ**. Admin (nút khiên) xoá UID đã cắt; mỗi lần xoá được ghi nhật ký. Tab Tem chờ in có ô Số PO + Ngày nhận như IN TEM GROUP UID.

**Đối chiếu** (kho WH - MATERIAL - MTG): đọc lịch sử WMS (lệnh Cut) qua Extension hoặc nạp ZIP / XLSX. Nhóm: Khớp, Quên tick, Sai số lượng, Tick mà WMS không có, Cut nhiều lần, Chưa ADJ, Chuyển nội bộ, Chờ dữ liệu WMS. Có **Tick giúp** và **Đã xử lý**; nhóm Cắt mẫu QC chỉ để xem.

**Nguồn phiếu** của từng lần Cut: ADJ (xuất test khi lý do là Xuất test), IT (chuyển nội bộ) hoặc Chưa rõ. Chỉ Cut ADJ và Chưa rõ vào luật lệch số lượng và nhóm Cắt mẫu QC; Cut IT thành nhóm Chuyển nội bộ (UID đã tick ADJ thì vẫn là lệch).

Pop-up hiện chip nguồn, số phiếu, PO (ADJ) hoặc kho nhận + mô tả (IT); Excel có cột Nguồn, Số phiếu. WMS không ghi phiếu trên dòng Cut nên nguồn suy ra từ SKU + số lượng + giờ của phiếu xuất, một phần Cut luôn Chưa rõ. Cần Extension ≥ 0.12.0 và migration `cut_source_v1`.

**Theo PO** (công tắc ở tab Quét): Admin đọc UID của PO từ WMS → tạo phiên; quét báo Cắt / QC / Chuyển kho lưu trữ; mỗi lot cắt + QC ≥ 30% (máy chủ ép); **Chuyển sang Cắt UID** đẩy UID cắt đã quét vào luồng thường. UID ngoài phiên báo đỏ, không tự rơi sang Cắt tự do.

## LỊCH SỬ GROUP UID (`#uidhist`)

- Dùng để: tra Group UID đã chuyển đến / đi từ một vị trí và ai cập nhật.
- Ai dùng: mọi người xem; **Đọc WMS** chỉ Admin trên máy tính (Chrome, Extension, tab WMS).
- Màn: `uidhist-script`, `#uidhist-screen`; phần Tiến độ A5000: `uidhist-rfid-style`, `uidhist-rfid-script`.
- Dữ liệu: bảng `group_uid_moves`; RPC `group_uid_moves_overview` / `group_uid_moves_lookup` (đọc công khai), ghi bằng RPC Admin; Extension đọc lịch sử Transfer location. File Excel tải xuống có thêm cột Lot và Roll (lấy từ `group_uid_details` trong `group_uid_moves_lookup`, migration `group_uid_moves_lot_roll_v1`).
- Test: `group_uid_moves_core`, `group_uid_moves_browser`, `group_uid_moves_lot_roll_sql`, `uidhist_rfid_browser`, `rfid_progress_sql`.

Nhập SKU và / hoặc mã vị trí (khung quét; SKU Combo hỏi chọn Normal) → bốn thẻ **Lượt chuyển · Còn ở đây · Đã chuyển tiếp · Trả NCC** → popup bảng (lọc kho, người cập nhật; xuất Excel). Mỗi lần tìm lấy ≤ 1.000 lượt mới nhất. `F0-VR-00-00-00-00` hiện là Trả NCC. Người chưa đăng nhập Admin chỉ thấy phần trước @ của email. Đọc WMS lần đầu 365 ngày, các lần sau lùi 30 phút.

Công tắc đầu màn **Chuyển vị trí | Tiến độ A5000** (nhớ theo máy). **Tiến độ A5000**: chọn kho MTG / GARMENT → thẻ **Hoàn thành %** · **Ô đã xong** · **Đã dán A5000** · **Còn mã A3000** · **Chưa dán**, rồi mỗi dãy kệ một lưới khoang × tầng, mỗi ô là một bin có % UID tồn (qty > 0) đã dán A5000; mã cũ A3000 chưa tính là xong.

Bấm ô mở pop-up các Group UID của bin chưa dán A5000 (chưa có RFID trước, mã cũ A3000 sau; tìm, lọc tình trạng, xuất Excel); lọc ô Tất cả / Chưa xong / Đã xong. Số lấy từ bản chụp Group UID trên Supabase (giờ cập nhật ghi ở đầu khung, vàng khi quá 24 giờ); ai cũng xem.

## TÌM SKU (`#find-sku`)

- Dùng để: tìm SKU từ tem nhà cung cấp (ảnh, mã vạch, gõ mã), tính số lượng rồi in.
- Ai dùng: Worker · chủ yếu điện thoại.
- Màn: `#find-sku-screen` (neo `web-find-sku`), bộ đối chiếu `NDS_ENGINE`, quy đổi `FSK_CORE`.
- Dữ liệu: Edge `sku-vision` (Gemini, trừ lượt qua `sku_vision_take`), danh mục `PrintSkuCatalog`, `sku_combo_lookup`, `print_enqueue`.
- Test: `find_sku_engine`, `find_sku_core`, `find_sku_combo_normal_browser`, `find_sku_print_guard_browser`, `find_sku_mobile_browser`, `sku_vision_function`.

**Quét nhận diện**: camera toàn màn tự chụp khi ảnh nét → Edge đọc chữ trên tem (≤ 3 lần mỗi lần mở camera, mỗi lần 1 lượt AI); QR / mã vạch đọc trực tiếp không tốn lượt; hoặc chọn ảnh, gõ mã in trên tem. Lúc AI đọc hiện lớp phủ chibi. Gợi ý SKU tính trên máy, luôn đổi Combo sang Normal; thẻ đỏ khi chỉ tên Combo khớp.

**Tính số lượng**: SKU đơn vị chiều dài mở CHUYỂN ĐỔI ĐƠN VỊ; đơn vị khác gõ số thẳng. **Chờ in**: danh sách trên máy, **In tem đã chọn** (≤ 100 SKU, ≤ 500 tem); trước khi gửi đọc lại tên từ database, SKU không còn trong danh mục thì không gửi. Hết lượt AI hoặc mất mạng vẫn tìm được bằng mã gõ.

## CHUYỂN ĐỔI ĐƠN VỊ (`#unit-converter`)

- Dùng để: đổi khối lượng chỉ / vải sang mm để in tem.
- Ai dùng: Worker · điện thoại và máy tính.
- Màn: `unit-converter-app`.
- Dữ liệu: danh mục SKU; RPC `sku_combo_by_normal` (quy cách cuộn lấy từ Combo).
- Test: `unit_converter_browser`.

**Chỉ**: trừ lõi (số cuộn × khối lượng lõi), quy đổi theo `Tex / 1.000` g/m hoặc theo cân cuộn nguyên (cân thắng; lệch > 5% so với Tex thì cảnh báo). Ví dụ 10.000 g, 10 lõi × 14 g, Tex 27 → `365.185.185 mm`. Có Tex thì không cần SKU.

**Vải**: `GSM × khổ(cm) / 100` g/m; có cân cuộn nguyên thì ưu tiên cân; chỉ theo GSM có cảnh báo sai số ±5–8%.

Quét / nhập SKU hoặc Group UID để tự điền Tex, quy cách cuộn, khổ, GSM; quy cách cuộn tự lấy từ Combo một thành phần (500–100.000 m), nhiều quy cách thì hiện chip để chọn. Chỉ SKU đơn vị chiều dài mới đưa kết quả mm sang TÌM SKU để in. **Lô tiếp theo** giữ thông số, **Nhập lại** xoá hết.

## THEO DÕI XẢ VẢI (`#xa-vai`)

- Dùng để: ghi thời gian bắt đầu / kết thúc xả từng cuộn vải (thay phiếu theo dõi giấy).
- Ai dùng: Worker trên máy đã kích hoạt.
- Màn: `#xa-vai-screen`.
- Dữ liệu: bảng `xa_vai_log`, RPC `xa_vai_*`.
- Test: chưa có test riêng (bố cục điện thoại trong `mobile_modules_browser`).

Quét UID là bắt đầu xả ngay; mỗi UID xả một lần, toàn hệ thống chỉ một UID đang xả. Tab **Đang xả** và **Đã xả xong** (lọc theo ngày kết thúc, mặc định hôm nay); màn tự làm mới 15 giây.

## TÌM GROUP UID (`#cap-vai` · `#uid-block` · `#tra-ncc`)

- Dùng để: một ô trang chủ cho ba việc tìm cuộn — Cấp vải, UID blocked, Trả NCC; công tắc đầu màn, mở phần dùng gần nhất.
- Màn: `find-uid-style` / `find-uid-script`; đường dẫn riêng của từng phần vẫn mở thẳng.
- Test: `find_uid_browser`.

### Cấp vải (`#cap-vai`)

- Dùng để: cấp vải theo Packing List — ghép Group UID theo SKU + Lot + Roll, quét đánh dấu đã cấp.
- Ai dùng: nhập / đóng / xoá đợt chỉ Admin; quét trên máy đã kích hoạt; xem mọi người.
- Màn: `cap-vai-script`, `#cap-vai-screen`.
- Dữ liệu: bảng + RPC `fabric_issue_*` (`supabase/fabric_issue_v1.sql`, `fabric_issue_v2_no_double_issue.sql`).
- Test: `find_uid_browser`; nhập PL từ Trợ lý in trong `assistant_pl_browser`.

**Nhập Packing List** (.xlsx, đọc trên trình duyệt): sheet "Packing" hoặc cột ROLLS NO / LOT NO / QTY; dòng `COLOR: … (SKU 9 số)` đặt SKU cho các dòng dưới, dòng SUB TOTAL bị bỏ; sheet có cột "Mã NPL" + "Định mức cấp phát" cho số cần cấp theo SKU (chỉ hiển thị).
Ghép UID `Available` cùng SKU, Lot / Roll chuẩn hoá; nhiều UID khớp thì không đoán, ghi lý do. Đồng bộ thêm Group UID xong thì bấm **Ghép lại**.

**Quét**: pop-up không chiếm con trỏ (xanh tự đóng 1,6 giây; vàng / đỏ ở lại tới khi chạm hoặc quét mã khác). Tab **Vị trí** gom cuộn theo kệ, tab **Danh sách cuộn** lọc Chưa quét / Đã quét / Chưa ghép; tự làm mới 20 giây. UID đã cấp ở đợt khác báo đỏ, không cấp trùng. Số mét lấy từ WMS (mm đổi sang m theo tên SKU).

### UID blocked (`#uid-block`)

- Dùng để: lựa các cuộn đang Blocked trên WMS trong kho.
- Ai dùng: quét trên máy đã kích hoạt; danh sách chỉ Admin.
- Màn: `uid-block-style` / `uid-block-script`, `#uid-block-screen`.
- Dữ liệu: `uid_block_*`; cron `uid-block-refresh-wms` 30 phút; danh sách trên máy (IndexedDB `print-sku-cache`); hàng chờ gửi `uid-block-cho-gui`.
- Test: `uid_block_browser`, `uid_block_sql`, `uid_block_wms_sql`, `uid_block_auto_sql`.

Danh sách là Group UID đang Blocked ở kho MTG và GARMENT trong dữ liệu đồng bộ (**Lấy từ WMS**, Admin), máy chủ tự cập nhật 30 phút: UID mới Blocked có nhãn Mới 24 giờ, UID hết Blocked giữ 7 ngày. Nạp Excel là cách cũ, vẫn dùng được.

Quét: trong danh sách → thẻ đỏ **BLOCKED** (SKU, Lot, Roll, kho, vị trí, âm báo, rung) và vào Đã lựa; quét lại → thẻ vàng **ĐÃ SCAN** (giờ, máy); ngoài danh sách → thẻ xanh. Lượt quét lưu Supabase dùng chung nhiều máy; mất mạng thì vào hàng chờ và tự gửi lại. Quét được mã RFID (1 RFID = 1 UID). Tab Còn thiếu gom theo vị trí; xuất Excel.

### Trả NCC (`#tra-ncc`)

- Dùng để: theo dõi các cuộn trả nhà cung cấp theo danh sách tạm.
- Ai dùng: nạp danh sách, Đối chiếu và Xoá đợt chỉ Admin; quét trên máy đã kích hoạt.
- Màn: `vendor-return-style` / `vendor-return-script`, `#vendor-return-screen`.
- Dữ liệu: `vendor_return_*` (v1–v3); Đối chiếu cần Extension ≥ 0.10.6.
- Test: `vendor_return_browser`, `vendor_return_sql`, `vendor_return_v2_sql`, `vendor_return_v3_sql`.

Bố cục như UID blocked: dải tiến độ, tab Còn thiếu (thẻ theo vị trí hiện tại) · Đã quét · Danh sách. Cuộn chia theo vị trí hiện tại → `F0-VR-00-00-00-00` (đích) → Đã rời kho. **Đối chiếu** đọc WMS trực tiếp qua Extension; đọc lệch thì báo đỏ và không lưu. Kết quả quét là pop-up không chiếm con trỏ như Cấp vải.

**Xoá đợt** (tab Danh sách, Admin): hộp xác nhận nêu tên tệp và số Group UID đã quét; xoá luôn danh sách và lượt quét của đợt, không khôi phục được.

Máy chủ chỉ cho Admin và chỉ xoá đúng đợt đang hiện: Admin khác vừa nạp đợt mới thì báo "danh sách vừa đổi", không xoá gì. Máy quét còn giữ đợt đã xoá báo "Chưa có danh sách" rồi tải lại; có đợt mới thì quét lại ngay. Nạp Excel mới vẫn chỉ tắt đợt cũ.

Mất mạng hoặc hết giờ chờ lúc xoá thì màn báo "Chưa rõ kết quả xoá" kèm tên đợt còn hay không còn, có nút Thử lại. Đối chiếu, Nạp và Xoá khoá lẫn nhau khi một việc đang chạy.

## KIỂM TRA ĐẦU VÀO (`#inspection`)

- Dùng để: biên bản kiểm phụ liệu nhận theo PO (AQL) và in tem Phụ liệu có PO + ngày nhận.
- Ai dùng: QC kho · máy tính (Đọc Inside cần Extension; nguồn GARMENT cần Extension ≥ 0.11.0).
- Màn: `#ins-screen`, `inspection-script`, `ins-print-style` / `ins-print-script`.
- Dữ liệu: Extension đọc PO trên Inside Mastige hoặc Inside Garment; `sku_combo_lookup`; `print_enqueue` (tem SKU v2).
- Test: `inspection_print_browser`, `inspection_normal_sku_browser`, `inspection_vendor_browser`, `inspection_garment_browser`, `inspection_export_xlsx`, `inspection_name_parser`, `inside_po_connector`, `print_sku_po_sql`.

Lấy PO bằng **Đọc Inside** (tab Inside đã đăng nhập, Extension chỉ đọc) hoặc nhập `.xls` / `.xlsx`. Màn hiện SKU Normal; số lượng và đơn vị giữ theo PO; NCC là pháp nhân trên PO; Rcvd date là ngày LastModified của PO; số lượng kiểm theo AQL 0.4; xuất biên bản theo template.

**Nguồn PO**: nút **MTG | GARMENT** cạnh ô Mã PO chọn Inside Mastige hoặc Inside Garment (nhớ theo máy, khoá trong lúc đang đọc).
MTG nhận PO kho `WH - MATERIAL - MTG`; GARMENT nhận PO kho `WH - MATERIAL - GARMENT` và chỉ khi Extension ≥ 0.11.0 trả đúng `site` (Extension cũ bị chặn trước khi hỏi).
Buyer của biên bản theo nguồn của PO đã nạp: MASTIGE cho PO MTG, để trống cho PO Garment (QC tự điền).
Nhập Excel (file không ghi công ty): Buyer theo nút đang chọn lúc chọn file; trạng thái ghi `file · MTG` hoặc `file · GARMENT`; nút nguồn khoá trong lúc đọc Inside hoặc file.

**In tem**: mỗi SKU Normal một dòng (Combo đổi sang Normal, SKU ngừng bị bỏ), mặc định 1 tem, ô số lượng từng dòng (trống thì không in); PO = ô P/O, ngày nhận = Rcvd date. Lỗi khi gửi thì **Gửi lại** dùng cùng nonce. Cần agent khai `sku:v2` hoặc `sku:v3`.

## RỦI RO LƯU TRỮ (`#storage-risk`)

- Dùng để: tab **Hàng chưa lên kệ** (tồn ở vị trí ảo `F0-<vùng>-00-00-00-NN`) và tab **UID tạm** (dòng Create Temporary UID).
- Ai dùng: mọi người xem; Đọc WMS chỉ Admin.
- Màn: `storage-risk-script`, `storage-risk-temp-script`, `snapshot-cache-script`.
- Dữ liệu: bản chụp Kiểm kê (`sku_count_*`, `sku_count_snapshot`), `uid_temp_*`; Extension `GET_STOCK_IMPORT_EXPORT_PAGE`; tự động mỗi 2 giờ 07:00–19:30.
- Test: `storage_risk_browser`, `storage_risk_core`, `storage_risk_temp_browser`, `uid_temp_snapshot_sql`, `snapshot_cache_browser`.

**Hàng chưa lên kệ** (kho MTG + GARMENT): mọi dòng tồn được phân loại kệ thật / vùng ảo / vị trí lạ, chỉ kệ thật bị loại. Mức theo Modified date: ≤ 7 ngày Theo dõi, 8–30 Cần xử lý, > 30 ngày hoặc vị trí lạ Rủi ro cao. Màn báo khi thiếu một kho, bản chụp quá 24 giờ hoặc số dòng lệch.

Bấm một dòng (kể cả ô SKU) mở pop-up nguồn: các lần chuyển vào vị trí đó (loại chuyển, số lượng, người, giờ, Group UID nếu tra được) và phiếu nhập gần nhất của SKU; không có thì hiện "Không có nguồn trong lịch sử đọc được". Nguồn lưu cùng bản chụp Kiểm kê ở lượt đọc kế tiếp của Rủi ro lưu trữ (Extension ≥ 0.12.0).

**UID tạm**: dòng nhập ADJUSTMENT có lý do "uid temp" trong 90 ngày, mới nhất trước; tuổi ≤ 3 ngày là Mới. Lần đọc lưu Supabase (giữ 10 lượt) nên ai mở cũng thấy. Cả hai tab hiện ngay bản lưu trên máy rồi hỏi máy chủ một lần xem có lần đọc mới không.

Bấm một dòng UID tạm mở pop-up phiếu gốc: loại (IT, ADJ hoặc Lệnh sản xuất), mã phiếu xuất, lý do, người duyệt, giờ, kho xuất / đến và các dòng cùng phiếu. Cần migration `uid_temp_origin_v1`; dòng lưu trước đó chưa có phiếu gốc.

## KIỂM KÊ SKU (`#inventory-audit`)

- Dùng để: đối chiếu kiểm kê theo kho — SKU chưa kiểm / kiểm trong 30 ngày / quá 30 ngày.
- Ai dùng: mọi người xem (kể cả điện thoại); Đọc WMS chỉ Admin.
- Màn: `inventory-audit-script`, `#inventory-audit-screen`.
- Dữ liệu: `sku_count_runs`, `sku_count_rows`; RPC `sku_count_save_*`, `sku_count_overview`, `sku_count_snapshot`; Extension đọc Stock Location và lịch sử kiểm kê.
- Test: `inventory_audit_browser`, `inventory_audit_core`.

Tồn lấy từ Stock Location (In-BIN > 0), kiểm kê chỉ tính phiếu `APPROVED`; hai pháp nhân MTG / GARMENT. Kết quả lưu theo (kho, SKU), chỉ hiện khi lượt đọc hoàn tất; lượt rỗng bị từ chối; giữ 3 lượt. Nhóm 30 ngày tính lúc xem nên luôn đúng. Token WMS không rời tab. Đường dẫn cũ `#admin/kiem-ke` tự chuyển về đây.

## KIỂM SOÁT CÔNG TRÌNH (`#site-control`)

- Dùng để: đối chiếu app Hasaki Construction Management với kho WMS OFFICE - 130 AP CHANH - MTG theo SKU của app.
- Ai dùng: Admin · máy tính, cần tab WMS và tab app xây dựng đã đăng nhập.
- Màn: `site-control-script`.
- Dữ liệu: chỉ trong trình duyệt, không lưu Supabase; app xây dựng đọc `/api/stock`, `/api/wms-imports` qua `hcm-bridge.js`.
- Test: `site_control_browser`, `hcm_bridge_reads`, `wms_bridge_reads`.

Bốn ô **SKU theo dõi · Lệch tồn · Lệch nhập · Lệch xuất** mở popup ba tab Tồn kho / Nhập / Xuất; bấm một dòng mở chi tiết; xuất Excel từng tab. Kỳ tính bắt đầu từ ngày của dòng nhập đầu tiên trong app.

## KÍCH HOẠT MÁY

- Dùng để: cho phép một máy in tem và ghi dữ liệu ở xưởng.
- Ai dùng: Worker nhập mã trên máy; Admin tạo mã.
- Màn: ô **KÍCH HOẠT MÁY** (chỉ hiện khi máy chưa có khoá); tab **Thiết bị** trong Quản trị → Lệnh in.
- Dữ liệu: `print_devices`, `print_activation_codes`; khoá máy `tb-khoa` trong localStorage; RPC `floor_access_check`.
- Test: `print_devices_browser`, `floor_access_browser`, `floor_access_sql`.

Admin vào Quản trị → Lệnh in → Thiết bị → **Tạo mã kích hoạt** (`XXXX-XXXX`, hiệu lực 30 phút, dùng cho nhiều máy, chỉ hiện rõ một lần). Trên từng máy bấm ô KÍCH HOẠT MÁY, nhập mã và tên máy; máy nhận khoá riêng. Mất khoá (xoá dữ liệu trình duyệt, đổi máy) thì kích hoạt lại bằng mã mới.

Máy chưa kích hoạt bị từ chối in tem và ghi ở xưởng (cắt, lấy mẫu, cấp vải, xả vải, quét UID blocked); khi đó hộp kích hoạt tự mở, tra cứu vẫn dùng được. Nhập sai mã quá 30 lần trong một phút thì tạm khoá một phút. Admin tắt / đổi tên máy, thu hồi mã, xem máy lạ trong 7 ngày và chuyển khoá máy xưởng về chế độ Ghi nhận khi khẩn cấp.

## QUẢN TRỊ (`#admin/…`)

- Dùng để: Lệnh in, Đồng bộ SKU, Đồng bộ Group UID, Cấu hình.
- Ai dùng: Admin · chỉ máy tính.
- Màn: `admin-sync-shared`, `sku-sync-admin-script`, màn Đồng bộ Group UID, Cấu hình (React).
- Dữ liệu: RPC `print_admin_*`, `print_job_cancel`; Edge `sku-sync`, `group-uid-sync`; `sync_auto_*`.
- Test: `admin_entry_browser`, `admin_switch_browser`, `admin_web_sync_browser`, `print_jobs_admin_browser`, `sku_sync_admin_browser`, `group_uid_sync_admin_browser`, `sku_sync_function`, `group_uid_sync_function`.

Vào từ ô QUẢN TRỊ; chưa có phiên thì đăng nhập Supabase bằng tài khoản có vai trò `admin`. Thanh trái ở chế độ Quản trị gồm ← Trang chủ, Lệnh in, Đồng bộ SKU, Đồng bộ UID, Kiểm kê, Cấu hình và **Đăng xuất** ở chân thanh.

**Lệnh in**: `print_jobs` cả kho theo ngày (bảng chỉ giữ 3 ngày gần nhất), lọc SKU / UID, tìm theo SKU, UID, tên, mã lệnh. Bấm lệnh mở chi tiết; **In lại** SKU giống hệt lệnh gốc, UID chọn toàn bộ hoặc một phần (máy chủ dựng lệnh mới); **Huỷ lệnh** cho lệnh đang chờ. Tab Thiết bị: xem mục KÍCH HOẠT MÁY.

**Đồng bộ SKU** (Inside → Supabase) và **Đồng bộ Group UID** (WMS → Supabase): **Đọc** (gia tăng) hoặc **Toàn bộ** (đối chiếu) → xem trước → **Cập nhật** (hỏi xác nhận). Ô số liệu mở popup danh sách thay đổi (tìm không dấu, lọc, xuất Excel); Lịch sử ở dải mốc giờ. Ô **Tự động** cho tạm dừng / tiếp tục lượt nền của Extension; lượt vượt ngưỡng chờ Admin chạy tay.

Nút **Máy đồng bộ** trong ô Tự động liệt kê máy chạy tự động và bản Extension của từng máy (14 ngày): hàng đỏ khi bản thấp hơn mức tối thiểu đang chặn, vàng khi chưa khai báo bản mà chưa có mức. Extension dưới mức tối thiểu không đọc được nguồn và không ghi được, cả lượt bấm tay.

**Cấu hình**: nhóm Thiết bị này (tên máy, quyền in, mẫu tem, sổ tay SKU) và Hệ thống (danh mục SKU, trần một lệnh in, chỉ đọc).

## Dữ liệu và đồng bộ

### Danh mục SKU (`SKU_Name`)

- Nguồn là Inside, qua Extension + Edge `sku-sync`: gia tăng theo Modified; **Toàn bộ** mỗi sáng một lần để đối chiếu. Edge từ chối khi số SKU nguồn giảm ≥ 20% so với lần toàn bộ trước.
- SKU rời 7 nhóm đồng bộ được tự lưu trữ sang `sku_archive` khi lượt toàn bộ cập nhật (giữ lại SKU còn UID sống, trong Combo Active, đang xả vải, cắt trong 90 ngày).
- SKU ngừng (`status <> '1'`): ẩn khỏi tìm kiếm công khai, máy chủ chặn in tem SKU; tem Group UID và vị trí vẫn in. SKU mới đang ngừng không được nạp; ngừng quá 180 ngày thì lưu trữ (cron thứ Hai 03:45).
- Danh mục trên máy (IndexedDB) hỏi phiên bản qua `sku_catalog_changes`, tải lại toàn bộ sau 12 giờ; Supabase luôn là bản đúng.

Script cũ, chỉ chạy khi được yêu cầu (dữ liệu thật trong `data/` không vào git):

```powershell
python scripts/import_sku_xlsx.py "C:\path\to\hasaki-product-all-sku-cate.xlsx"
python scripts/merge_sku_category_xlsx.py "C:\path\to\product-list.xlsx" --category-id 957 --category-name "Thời Trang (NVL)" --backup data/sku.before-merge.db
python scripts/sync_sku_to_supabase.py --database data/sku.db --dry-run
python scripts/sync_sku_to_supabase.py --database data/sku.db [--include-inactive]
```

`import_sku_xlsx.py` tạo `data/sku.db` từ bản xuất Inside **Download → File**; `merge_sku_category_xlsx.py` ghép thêm một category (**Download → Category**) theo khoá SKU. `sync_sku_to_supabase.py` cần `SUPABASE_URL` và `SUPABASE_SECRET_KEY` trong biến môi trường, chỉ thêm / cập nhật theo `sku`, không xoá.

### Group UID (`group_uid_details`)

- Khoá là Group UID Code (chữ, giữ số 0 đầu); lưu Batch, Roll, kho, vị trí, SKU, số lượng, người / giờ cập nhật, trạng thái WMS, `qc_status`, RFID, PO. Tên sản phẩm tra từ `SKU_Name`, không lưu lại. Bảng bật RLS; web chỉ qua RPC.
- Đồng bộ qua Extension + Edge `group-uid-sync`: gia tăng lùi 30 phút hoặc Toàn bộ; đọc hết các trang vào bộ nhớ, kiểm tổng và trùng mã rồi mới ghi; luôn xem trước rồi mới cập nhật; không tự xoá UID thiếu trên WMS.
- UID Canceled quá 180 ngày bị dọn (cron thứ Hai 03:15) và bị bỏ qua khi đồng bộ.

Nạp Excel bằng script (dự phòng; kiểm trước, `--apply` mới ghi, lô 500 dòng, không ghi đè bản ghi mới hơn, không xoá):

```powershell
python scripts/import_group_uid_xlsx.py "C:\path\to\GROUP_UID_DETAIL.xlsx"
python scripts/import_group_uid_xlsx.py "C:\path\to\GROUP_UID_DETAIL.xlsx" --apply
```

### Đồng bộ tự động

Extension chạy nền trên máy đã đăng nhập Admin (trang Options): Group UID và SKU gia tăng mỗi 30 phút trong giờ làm, Toàn bộ một lần mỗi ngày trong khung 07:30–11:00; Đối chiếu ADJ và Rủi ro lưu trữ mỗi 2 giờ 07:00–19:30. Mỗi loại có lease 15 phút; lượt vượt ngưỡng bị giữ chờ Admin; tự động ngừng quá 70 phút thì Extension và màn Admin cảnh báo (ngừng buổi tối do tắt máy là bình thường).

Bản Extension: từ 0.10.10 Extension khai báo bản cho server. Mức tối thiểu đặt bằng SQL (`sync_auto_settings.min_extension`, rỗng = không chặn); máy dưới mức không thuê khoá, không đọc, hiện dấu "!" và thẻ đỏ "cần Extension ≥ x" ở Options. Quy trình nâng mức: `docs/chuan/DU_LIEU.md`.

## Agent máy trạm

Agent Node trong `workstation-agent/` chạy trên máy trạm `may-kho-01`: nhận lệnh từ `print_jobs` theo khả năng (`sku:v1`, `sku:v2`, `sku:v3`, `group_uid:v1`, `location:v1`, `location:name-optional`), vẽ tem rồi gửi máy in TSC. Cài đặt, cấu hình và lịch sử phiên bản: `workstation-agent/README.md`.

Phát hành mẫu tem mới: cài agent mới lên máy trạm và in thử thật trước khi push web — agent cũ bỏ qua trường mới mà web vẫn báo "Đã gửi".

## Chuẩn giao diện

Luật giao diện (màu, chữ, icon, vùng chạm, khung quét, hộp thoại, báo lỗi) và bộ test giữ luật: `docs/chuan/GIAO_DIEN.md`. Mã web: `docs/chuan/MA_WEB.md`.
