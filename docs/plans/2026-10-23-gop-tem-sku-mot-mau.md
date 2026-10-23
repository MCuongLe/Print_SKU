# Gộp tem SKU thường (v1) và tem Phụ liệu có PO (v2) thành một mẫu

Trạng thái: ĐÃ BUILD (23/10/2026, review 3 vòng, cả bộ test đạt) — chờ migration + cài agent 0.10.2 + in thử trước khi push.

## Người dùng chốt (23/10/2026)
- D1 Tem không có PO: **giống hệt tem thường hiện nay** (không khung, tên 8 dòng).
- D2 KIỂM TRA ĐẦU VÀO: tem Phụ liệu giữ PO + ngày nhận, **thêm ô nhập số lượng từng dòng** trong tấm In tem; không nhập thì để trống (không in số lượng).
- D3 **Cùng một đợt** với "in lại tem PO khi quét SKU" (docs/plans/2026-10-23-in-lai-tem-sku-po.md): làm lại phần đó trên mẫu gộp — một lệnh, item có PO mang PO + số lượng người dùng nhập; ngày nhận = lần in gần nhất; 8 mục Fable xếp Nên sửa (review vòng 1) áp dụng phần còn đúng (lựa chọn PO ghi sau kiểm cuối, valid kiểm ô SKU, kiểm mẫu PO + năm, nạp bù chỉ completed, raise warning, cardinality trước unnest, bỏ SKU/PO thật trong plan); phần tách 2 lệnh / trạng thái multi / chống in trùng từng phần không còn cần.

## Yêu cầu
Người dùng: "sku v1 (tem thường: tên, QR, SKU, số lượng, ngày in) — IN TEM SKU, Phiếu IT, Trợ lý in, TÌM SKU; sku v2 (tem Phụ liệu: thêm khung PO + Ngày nhận, không số lượng) — KIỂM TRA ĐẦU VÀO. Tôi cần nhập 2 luồng này thành 1."

## Hiện trạng
- Hai mẫu tem SKU do agent vẽ (`workstation-agent/src/templates/sku-label.mjs`):
  - v1: tên tối đa 8 dòng, QR, SKU, vạch kẻ, chân tem "số lượng (trái) · ngày in (phải)".
  - v2: tên tối đa 5 dòng, QR, SKU, **khung PO / Ngày nhận** (luôn vẽ, trống để ghi bút), vạch kẻ, chân tem chỉ có ngày in (bỏ số lượng).
- Hàng đợi giao lệnh theo capability: `sku:v1` mọi agent, `sku:v2` từ agent 0.10.1 (may-kho-01 đã cài). Web chọn mẫu: KIỂM TRA ĐẦU VÀO gửi v2, mọi màn khác gửi v1.
- Phần "in lại tem PO khi quét SKU" (đang tạm dừng, chưa commit) phải TÁCH một danh sách thành 2 lệnh (v1 + v2) → phức tạp: 2 nonce, trạng thái gộp, chống in trùng từng phần.

## Hướng đề xuất: một mẫu tem SKU "tự co giãn" (v3)
- **Một mẫu, nội dung theo dữ liệu từng tem:**
  - Có PO hoặc ngày nhận → vẽ khung PO / Ngày nhận (như v2), tên tối đa 5 dòng.
  - Không có PO và ngày nhận → giống hệt v1 (không khung, tên 8 dòng).
  - Số lượng: có thì in ở chân trái (cả tem có PO); trống thì bỏ. Ngày in luôn ở chân phải.
- **Một lệnh cho cả danh sách:** tem có PO và tem không PO đi chung một lệnh (agent vẽ từng tem theo dữ liệu của nó) → bỏ hẳn việc tách 2 lệnh của phần in lại tem PO.
- **Một điểm chọn mẫu (sau review vòng 2):** mọi màn đi qua `PrintSkuQueue.enqueue`; agent vẽ MỘT mẫu, số phiên bản chỉ là nhãn định tuyến. Lệnh cần khả năng mới (có PO / ngày nhận, hoặc tem Phụ liệu có số lượng) → v3 (chỉ agent 0.10.2 nhận); còn lại giữ v1 (KIỂM TRA ĐẦU VÀO: v2) để mọi agent nhận — tem in ra giống hệt.
- **Vì sao số phiên bản mới (v3) chứ không sửa v2:** agent 0.10.1 đang chạy hiểu v2 là "luôn có khung, không số lượng"; dùng v3 + capability `sku:v3` thì lệnh mới chỉ tới agent mới, agent cũ không vẽ sai. v1/v2 vẫn giữ trong agent để lệnh cũ còn trong hàng đợi in được.

## Việc build (khi chốt)
1. Agent 0.10.2: mẫu v3 trong `sku-label.mjs` + `render.mjs` (số dòng tên theo có/không khung, chân tem có số lượng), validator nhận v3 (po / receivedDate tuỳ chọn, kiểm mẫu như v2), capability `sku:v3`; test: v3 không PO **giống từng byte** v1, v3 có PO giống v2 + số lượng. Đóng gói ZIP.
2. Migration `print_agent_claim`: thêm nhánh (sku, 3, `sku:v3`).
3. Web: `PrintSkuQueue.enqueue` (`skuTemplate`) chọn v3 khi lệnh cần, hỏi `print_queue_status` lúc đó (không có `sku:v3` → báo "cần agent 0.10.2"; không hỏi được → báo đúng lỗi, ACCESS_DENIED mở hộp kích hoạt máy). Phần in lại tem PO: một lệnh, item có PO mang PO.
4. Review Codex + Claude + Fable; ảnh tem (render SVG) cho Codex; cả bộ test; PROJECT_MAP; RULES.
5. Thứ tự lên (sửa sau review vòng 2): chạy `print_sku_v3_v1.sql` + `sku_po_receipts_v1.sql` (không cần `--allow-destructive`) → cài agent 0.10.2 trên may-kho-01 (log có `sku:v3`) → in thử thật 3 tem từ web chạy cục bộ (không PO / có PO / có PO + số lượng) → push web.

## Đã chốt (23/10/2026)
D1–D3 ở đầu tệp. Review vòng 2: tem Phụ liệu có số lượng mà PO + ngày đều trống (in không khung hay giữ khung trống ghi bút) — làm sau, hỏi người dùng khi gặp.
