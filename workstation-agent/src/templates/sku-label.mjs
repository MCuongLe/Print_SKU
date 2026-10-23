import { qrRects } from "./qr.mjs";
import { escapeXml, formatDate, formatQuantity, LABEL_WIDTH, svgDocument, wrapText } from "./common.mjs";
import { estimateTextWidth, fitFooter, fitTextBlock, maxLinesForSize } from "./text-layout.mjs";

// Hằng số bố cục dùng chung với `maxLinesForSize` trong text-layout.mjs — MỘT
// nguồn sự thật duy nhất. Đổi khoảng đệm ở đây thì phải đổi luôn layout truyền
// cho `fitProductName` ở render.mjs, nếu không hai nơi sẽ tính lệch nhau.
//
// Vạch kẻ và hàng số lượng/ngày CỐ ĐỊNH ở đáy tem (30/09/2026), không trôi theo
// số dòng tên nữa. Vị trí chọn đúng bằng chỗ bản cũ đặt khi tên 8 dòng, nên tên
// vẫn chứa tối đa 8 dòng cỡ 22 như trước.
export const SKU_LABEL_LAYOUT = {
  qrSize: 147, // ước lượng trước khi biết kích thước QR thật: box=154, SKU 9–10 chữ số ra QR version 1 (21 module) nên module≈7
  skuOffset: 28,
  lineOffset: 12, // khoảng tối thiểu từ chân số SKU tới vạch kẻ
  pad: 10,
  lineY: 431,     // vạch kẻ, nét 2 dot: 430–432
  footerY: 465,   // chân chữ số lượng/ngày; lề dưới 15 dot
};
export const SKU_LABEL_MAX_WIDTH_PX = 296; // vùng chữ: x=12 → x≈308
// Đỉnh chữ cao nhất (Arial, có dấu) ≈ 0,75 cỡ chữ trên chân chữ. Số lượng cỡ
// 40 có đỉnh ở y≈435, vẫn cách mép dưới vạch kẻ 3 dot — có test giữ bất biến này.
export const QUANTITY_TOP_RATIO = 0.75;

// Tem SKU phiên bản 2 (0.10.1, 22/10/2026) — tem Phụ liệu in ở KIỂM TRA ĐẦU VÀO: giữa SKU và vạch kẻ có khung hai hàng
// "PO: …" / "Ngày nhận: …" (nhãn thường, giá trị đậm), không in số lượng (chỉ ngày in góc phải). Khung cố định
// y=357→421 nên tên còn tối đa 5 dòng cỡ 22/20, 6 dòng cỡ 18/16 (v1: 8). PO/ngày trống thì vẫn vẽ khung + nhãn để ghi bút.
export const SKU_V2_BOX_LAYOUT = {
  left: 12, right: 308, top: 357, bottom: 421, divider: 389, // viền 2 chấm trong khung x=12→308
  padding: 10, labelSize: 16, labelGap: 8, rowBaselines: [382, 414],
  valueSizes: [26, 24, 22, 20, 18, 16, 14, 12]
};
// Giới hạn dòng tên của v2: tính như v1 nhưng "vạch" là mép trên khung (maxLinesForSize trong text-layout.mjs).
export const SKU_V2_NAME_LAYOUT = { ...SKU_LABEL_LAYOUT, lineY: SKU_V2_BOX_LAYOUT.top, lineOffset: 10 };

// Tem SKU phiên bản 3 (0.10.2, 23/10/2026) — gộp v1 + v2, quyết định theo TỪNG tem trong lệnh: có PO hoặc ngày nhận
// (khác rỗng sau trim) thì vẽ khung PO / Ngày nhận như v2, không có thì giống từng byte v1. Số lượng in như v1 (có thì in,
// kể cả tem có khung). v1, v2 giữ nguyên để lệnh cũ còn trong hàng đợi in được. render.mjs dùng chung hai hàm này.
export function skuHasPoBox(payload, version) {
  const v = Number(version);
  if (v === 2) return true;
  if (v === 3) return Boolean(String(payload?.po ?? "").trim() || String(payload?.receivedDate ?? "").trim());
  return false;
}
// Chỉ v2 bỏ số lượng ở chân tem; v1, v3 in nếu có.
export function skuShowsQuantity(version) {
  return Number(version) !== 2;
}

function poDateRows(payload) {
  const b = SKU_V2_BOX_LAYOUT;
  const rows = [["PO:", String(payload.po ?? "").trim()], ["Ngày nhận:", String(payload.receivedDate ?? "").trim()]];
  const labelX = b.left + b.padding;
  return `<rect x="${b.left + 1}" y="${b.top + 1}" width="${b.right - b.left - 2}" height="${b.bottom - b.top - 2}" rx="5" fill="none" stroke="#000" stroke-width="2"/>` +
    `<line x1="${b.left + 1}" y1="${b.divider}" x2="${b.right - 1}" y2="${b.divider}" stroke="#000" stroke-width="2"/>` +
    rows.map(([label, value], index) => {
      const y = b.rowBaselines[index];
      const valueX = Math.ceil(labelX + estimateTextWidth(label, b.labelSize) + b.labelGap);
      const size = fitTextBlock([value], b.right - b.padding / 2 - valueX, { sizes: b.valueSizes });
      return `<text x="${labelX}" y="${y}" font-size="${b.labelSize}">${label}</text>` +
        (value ? `<text x="${valueX}" y="${y}" font-size="${size}" font-weight="700">${escapeXml(value)}</text>` : "");
    }).join("");
}

export function renderSkuLabel(payload, { version = 1 } = {}) {
  const box = skuHasPoBox(payload, version);
  const sku = escapeXml(payload.sku);
  // Ưu tiên dùng kết quả đã đo bề rộng THẬT qua GDI+ (payload.productNameLines
  // + productNameFontSize, tính sẵn ở render.mjs bằng text-metrics.mjs — xem
  // RULES.md phần "Đo chữ thật"). Không có (preview đơn lẻ ngoài luồng in
  // thật, hoặc bước đo lỗi) thì lùi về cách cũ: đếm 22 ký tự/dòng, cỡ chữ cố
  // định 22, tối đa 8 dòng — giữ nguyên byte-for-byte hành vi trước đây.
  const hasMeasuredLines = Array.isArray(payload.productNameLines) && payload.productNameLines.length > 0;
  const fontSize = hasMeasuredLines ? Number(payload.productNameFontSize) || 22 : 22;
  // Tem có khung PO/ngày (v2, v3 có PO): cách đếm ký tự dự phòng cũng chỉ lấy số dòng v2 (5 ở cỡ 22), không 8 như v1 (review Codex 22/10)
  const productLines = hasMeasuredLines ? payload.productNameLines : wrapText(payload.productName, 22, box ? maxLinesForSize(22, SKU_V2_NAME_LAYOUT) : 8);
  const lineHeight = fontSize + 3;
  const product = productLines.map((line, index) =>
    `<text x="12" y="${34 + index * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`
  ).join("");
  // QR dời xuống dưới khối tên (chừa đệm cho tên dài), tối thiểu y=170 khi tên
  // ngắn. Cỡ chữ càng nhỏ thì lineHeight càng nhỏ, tên nhiều dòng hơn vẫn vừa.
  const { skuOffset, pad, lineY, footerY } = SKU_LABEL_LAYOUT;
  const qrTop = Math.max(170, 34 + productLines.length * lineHeight + pad);
  const qr = qrRects(payload.sku, { centerX: LABEL_WIDTH / 2, top: qrTop, box: 154 });
  const skuY = qrTop + qr.size + skuOffset;
  const quantityText = skuShowsQuantity(version) ? formatQuantity(payload.quantity) : "";
  const dateText = String(payload.printedDate || formatDate());
  // Cỡ chữ đã đo thật (payload.footerFit, tính ở render.mjs) — không có thì ước lượng.
  const footer = payload.footerFit ?? fitFooter(quantityText, dateText, { measureQuantity: estimateTextWidth, measureDate: estimateTextWidth });
  return svgDocument(
    product +
    qr.rects +
    `<text x="160" y="${skuY}" font-size="32" font-weight="700" text-anchor="middle">${sku}</text>` +
    (box ? poDateRows(payload) : "") +
    `<line x1="20" y1="${lineY}" x2="300" y2="${lineY}" stroke="#000" stroke-width="2"/>` +
    (quantityText ? `<text x="20" y="${footerY}" font-size="${footer.quantityFontSize}">${escapeXml(quantityText)}</text>` : "") +
    `<text x="300" y="${footerY}" font-size="${footer.dateFontSize}" text-anchor="end">${escapeXml(dateText)}</text>`
  );
}
