# In lại tem SKU có PO khi quét mã SKU đã nhận theo PO

Trạng thái: ĐÃ BUILD (23/10/2026) trên mẫu tem gộp v3 (docs/plans/2026-10-23-gop-tem-sku-mot-mau.md). Người dùng thêm: pop-up chỉ hiện số PO (ngày nhận lưu database, số lần in — không hiện).

## Người dùng chốt (23/10/2026)
- D1 Nguồn: **A** — lưu từ lệnh in tem PO (bảng + trigger + nạp bù).
- D2 Nơi quét: **khung quét có sẵn của IN TEM SKU**; SKU có PO → tấm Tem PO; SKU chưa có PO → in tem thường như cũ.
- D3 SKU nhiều PO: **pop-up cho người dùng chọn PO** (mới nhất trên cùng, mỗi dòng: PO · ngày nhận · số lần đã in). SKU chỉ một PO → chọn sẵn.
- D4 Quyền: **máy đã kích hoạt** (như In tem SKU), không cần Admin.
- AI đọc số PO từ ảnh tem cũ (mở rộng Edge `sku-vision`, nút "Chụp tem" trong pop-up): khả thi khi hàng còn tem v2 có PO — **ĐỢT SAU**.
- Mã vạch PO trên tem: **KHÔNG LÀM**.

## Yêu cầu
Người dùng (ảnh tem Phụ liệu thật 22/10 — SKU, PO, ngày nhận in đúng): "Lập kế hoạch hướng in lại tem SKU có PO khi người dùng quét các mã SKU đã có PO về."
→ Quét SKU (QR / mã vạch trên tem cũ hoặc trên hàng) → app biết SKU đó đã về theo PO nào, ngày nhận nào → in lại tem SKU mẫu v2 (khung PO + Ngày nhận) đúng thông tin đó.

## Hiện trạng (đo 23/10)
- Tem v2 chỉ in từ KIỂM TRA ĐẦU VÀO (`ins-print-script` → `HasakiSkuIt.enqueue(…, { templateVersion: 2 })`; PO + ngày nhận nằm trong `print_jobs.payload.items[]`).
- Không có bảng nào lưu lâu dài "SKU → PO + ngày nhận". `print_jobs` tự dọn sau 3 ngày (`print_jobs_purge`) → 4 lệnh v2 ngày 22–23/10 sẽ mất khoảng 25–26/10 nếu không lưu lại.
- WMS báo cáo nhập xuất (`GET_STOCK_IMPORT_EXPORT_PAGE`) có `source_type` / `source_code` từng dòng nhập — có thể là nguồn lịch sử đầy đủ (dòng nhập theo PO), nhưng CHƯA đo: API có lọc theo SKU không, `source_code` có đúng là số PO không, giờ nhập có trùng "Rcvd date" của Inside không.

## Phương án nguồn dữ liệu
| | A. Nhật ký in tem PO (khuyến nghị làm trước) | B. Đọc WMS nhập kho theo SKU |
|---|---|---|
| Cách | Bảng `sku_po_receipts` (sku, po, received_date, product_name, lần in đầu/cuối, số lần in); trigger trên `print_jobs` ghi mỗi khi có lệnh `sku` v2 có PO; nạp bù 4 lệnh v2 đang còn trong `print_jobs` | Extension đọc báo cáo nhập xuất WMS lọc SKU + nguồn PO, lấy PO + giờ nhập |
| Phủ | Chỉ SKU đã in tem PO bằng app (từ 22/10) | Mọi lần nhập theo PO trong WMS (cả trước 22/10) |
| Cần | Migration 1 tệp, không Edge, không Extension | Đo API WMS trước; Extension mới; cần tab WMS khi quét |
| Rủi ro | Thấp; dữ liệu đúng như lúc in | Ngày nhận WMS có thể lệch Rcvd date Inside; chậm hơn |

## Luồng đề xuất (A)
1. Quét SKU ở **IN TEM SKU** (khung quét có sẵn) — hoặc màn khác tuỳ chốt D2.
2. App tra `sku_po_lookup(p_skus)` (anon, như `sku_combo_lookup`): mỗi SKU → danh sách {PO, ngày nhận, tên SKU, lần in gần nhất}, mới nhất trước.
3. SKU có PO → hiện trong tấm "Tem PO" (dùng lại giao diện tấm `#ins-tem` của KIỂM TRA ĐẦU VÀO: ô tick, số bản, PO + ngày nhận từng dòng); nhiều PO → mặc định PO mới nhất, đổi được. SKU chưa có PO → in tem thường như cũ.
4. In → `HasakiSkuIt.enqueue(items, { templateVersion: 2 })` (cần agent 0.10.1 `sku:v2` — đã cài may-kho-01). Mỗi lần in lại cập nhật `last_printed_at` / `print_count` qua cùng trigger.

## Việc build (khi chốt)
- [ ] `supabase/sku_po_receipts_v1.sql`: bảng (khoá sku+po, chỉ service_role), trigger `after insert on print_jobs` (type `sku`, template_version 2, mỗi item có `po` + `receivedDate` dd/mm/yyyy → upsert), nạp bù từ `print_jobs` hiện có, RPC `sku_po_lookup(p_skus text[])` anon ≤ 100 SKU. Test SQL tĩnh.
- [ ] `index.html`: chế độ / nút "Tem PO" ở màn đã chốt, tra cứu + tấm chọn PO + in v2; test trình duyệt dữ liệu giả.
- [ ] Review Codex + Claude + Fable; ảnh 390 + 1280; cả bộ test; PROJECT_MAP; RULES.
- [ ] Lên: migration TRƯỚC (càng sớm càng giữ được 4 lệnh v2 đang có trong print_jobs) → push web.
- (B, đợt sau nếu chốt) Đo API WMS nhập xuất theo SKU bằng DevTools (chỉ đọc) → Extension đọc lịch sử PO → gộp vào cùng bảng với `source = 'wms'`.

## Cần người dùng chốt
- D1 Nguồn: A (khuyến nghị) / B / A rồi B.
- D2 Nơi quét: IN TEM SKU (khuyến nghị) / KIỂM TRA ĐẦU VÀO (tab In lại) / ô trang chủ riêng.
- D3 SKU có nhiều PO: mặc định PO mới nhất + đổi được (khuyến nghị) / luôn hỏi chọn.
- D4 Quyền: như In tem SKU (máy đã kích hoạt, không cần Admin) (khuyến nghị) / chỉ Admin.
