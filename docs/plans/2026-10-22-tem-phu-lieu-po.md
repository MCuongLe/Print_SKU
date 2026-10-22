# Tem Phụ liệu có PO + ngày nhận (2026-10-22)

## Thiết kế
- **Yêu cầu:** ảnh mẫu 22/10 — tem 1 cột: tên (3 dòng) → QR SKU → SKU lớn → **khung kẻ 2 hàng "PO: …" / "Ngày nhận: …"** → vạch → ngày in góc phải ("20/10/26"). Không có số lượng.
- **Đã chốt 21/10/2026** (ghi chú phiên `ke-hoach-tem-phu-lieu-po-ngay-nhan.md`, bộ nhớ `project_tem_phu_lieu_po`):
  1. In ở **KIỂM TRA ĐẦU VÀO** (`#ins-screen`): nút In tem ở thẻ danh sách phụ liệu, sau khi Đọc Inside / Nhập Excel. Không thêm vào IN TEM SKU.
  2. **PO** = ô `#ins-po`; **Ngày nhận** = ô Rcvd date `#ins-date` (= LastModified PO, sửa tay được).
  3. Mặc định **1 tem mỗi SKU**, sửa số tem từng dòng; Combo in theo **SKU Normal** (`item.normals`), Normal ngừng hoạt động → bỏ + báo số dòng bỏ.
  4. Tem Phụ liệu dùng mẫu SKU **phiên bản 2** (`templateVersion: 2`) để agent cũ để lệnh nằm chờ (thấy được) thay vì in thiếu PO.

### Hiện trạng thay đổi từ 21/10 (đọc mã 22/10)
- Agent đã lên **0.10.0** (tem Group UID có ô SỐ PO | NGÀY NHẬN, commit a080530); may-kho-01 đang chạy 0.10.0 (Supabase `print_agents.state.version`). may-kho-02 đã có danh tính, chưa cài.
- `job-validator.mjs` đã có kiểm `po` (≤ 20 ký tự `PO_PATTERN`) và `receivedDate` (`dd/mm/yyyy`) — dùng lại cho tem SKU, không viết mới.
- `text-layout.mjs` đã đo chữ PO/ngày trong cùng lần gọi GDI+ (nhóm của tem Group UID) — dùng lại để thu cỡ PO dài.
- Tem Group UID dùng **ô hai cột** (SỐ PO | NGÀY NHẬN); mẫu Phụ liệu dùng **khung hai hàng** "PO:" / "Ngày nhận:" → hai kiểu vẽ riêng, chung phần đo chữ + kiểm dữ liệu.
- `print_agent_claim` bản mới nhất: `supabase/warehouse_location_v1.sql` (sku chỉ có nhánh v1).

### Bố cục tem SKU v2 (40 × 60 mm = 320 × 480 chấm, 2 tem/hàng như v1)
| Vùng | y (chấm) | Ghi chú |
|---|---|---|
| Tên | 0 → ~150 | tối đa 5 dòng cỡ 22/20 (6 dòng cỡ 18/16); v1 cho 8 dòng |
| QR (chỉ chứa SKU, như v1) | ~165 → ~310 | giữ module để Honeywell / TÌM SKU đọc như cũ |
| SKU đậm cỡ 32 | chân ~345 | |
| Khung 2 hàng | 355 → 419 | nhãn thường ~16 ("PO:", "Ngày nhận:") + giá trị đậm ~26; PO dài thu cỡ, không cắt |
| Vạch | 431 | |
| Ngày in phải | 465 | không in số lượng ở v2 |
- Tem v1 **không đổi byte nào** (test ảnh v1 giữ nguyên).

## Kế hoạch
### Việc 1 — Agent 0.10.1: tem SKU v2 (lead) · [x]
- [x] `templates/index.mjs` `CAPABILITIES` thêm `sku:v2`; `job-validator` `normalizeSku` giữ `po` / `receivedDate` khi `templateVersion = 2` (dùng lại kiểm sẵn có; sai mẫu → từ chối cả lệnh)
- [x] `sku-label.mjs`: v2 vẽ khung 2 hàng + bỏ số lượng; ngân sách tên 5–6 dòng; đo PO/ngày cùng lần gọi GDI+
- [x] Test đỏ trước: khung không chồng SKU/vạch, tên 5/6 dòng, PO 20 ký tự thu cỡ, v1 ảnh giữ nguyên; `preview:sku` ra PNG (đối chiếu ảnh mẫu); VERSION/package.json 0.10.1; build ZIP
### Việc 2 — Migration `print_sku_po_v1.sql` (lead làm luôn — chỉ 1 dòng) · [x]
- [x] Chỉ thay `print_agent_claim`: thêm `(type='sku' and template_version=2 and 'sku:v2'=any(v_cap))`; test SQL tĩnh + đột biến; dry-run
### Việc 3 — Web KIỂM TRA ĐẦU VÀO (lead) · [x]
- [x] Nút icon In tem ở thẻ danh sách → hộp thoại: SKU Normal + số tem (mặc định 1), PO + Ngày nhận từ thẻ 2; chia lệnh ≤ 100 SKU / ≤ 500 tem; cần máy đã kích hoạt (khoá máy như In tem SKU)
- [x] `PrintSkuQueue.enqueue({ type: "sku", templateVersion: 2, items: [{ sku, productName, printedDate, copies, po, receivedDate }] })`
- [x] Test trình duyệt mới (payload v2, combo → normal, chia lệnh, thiếu PO/ngày) + chạy lại `inspection_*`; ảnh 390 + 1280
### Việc 4 — Review · [ ]
- [ ] Codex `--working-tree` (SQL + agent + luồng in) + `--images` (ảnh màn + PNG tem); `/review-claude` cho luồng in
### Việc 5 — Lên · [ ]
- [ ] commit (chưa push) → migration `print_sku_po_v1` → cài agent 0.10.1 lên may-kho-01 (log khởi động có `sku:v2`) → in thử 1 lệnh v2 dữ liệu giả, đọc QR bằng máy quét → push web
- [ ] Cài may-kho-02 thì dùng gói 0.10.1 (gói 0.10.0 hiện có cần đóng lại)

## Rủi ro
- Agent chưa cập nhật mà web đã push → lệnh v2 nằm hàng chờ (không in sai) → bắt buộc cài agent trước khi push.
- Hai máy trạm: hàng đợi chưa định tuyến theo máy (may-kho-02) — tem có thể ra máy kia nếu cả hai cùng chạy.
- Tên rất dài bị giới hạn 5–6 dòng (v1: 8) → nếu vượt thì thu QR module 7 → 6 thêm 1 dòng, không nhỏ hơn.
- Ngày nhận = LastModified có thể lệch ngày nhận thật nếu PO sửa sau → ô sửa tay trước khi in.

## Phát sinh

## Lệch kế hoạch

## Nhật ký
- 22/10 build: agent 0.10.1 (test sku-po-0101 đỏ trước → 193/193 agent đạt, preview PNG khớp mẫu); migration print_sku_po_v1 (hàm đang chạy khớp md5 bản warehouse_location_v1, test print_sku_po_sql 5/5 đột biến); web #ins-print + #ins-tem (inspection_print_browser đỏ trước → đạt 1280/390; 14 test liên quan đạt). ZIP agent chưa dựng (dựng lúc lên, kèm index.html mới).
- 22/10 lập lại kế hoạch từ bản 21/10 theo ảnh mẫu; cập nhật agent 0.10.0 → 0.10.1, dùng lại kiểm PO/ngày + đo chữ của tem Group UID. CHƯA build.
