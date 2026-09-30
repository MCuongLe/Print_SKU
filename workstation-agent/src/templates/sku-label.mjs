import { qrRects } from "./qr.mjs";
import { escapeXml, formatDate, formatQuantity, LABEL_WIDTH, svgDocument, wrapText } from "./common.mjs";
import { estimateTextWidth, fitFooter } from "./text-layout.mjs";

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

export function renderSkuLabel(payload) {
  const sku = escapeXml(payload.sku);
  // Ưu tiên dùng kết quả đã đo bề rộng THẬT qua GDI+ (payload.productNameLines
  // + productNameFontSize, tính sẵn ở render.mjs bằng text-metrics.mjs — xem
  // RULES.md phần "Đo chữ thật"). Không có (preview đơn lẻ ngoài luồng in
  // thật, hoặc bước đo lỗi) thì lùi về cách cũ: đếm 22 ký tự/dòng, cỡ chữ cố
  // định 22, tối đa 8 dòng — giữ nguyên byte-for-byte hành vi trước đây.
  const hasMeasuredLines = Array.isArray(payload.productNameLines) && payload.productNameLines.length > 0;
  const fontSize = hasMeasuredLines ? Number(payload.productNameFontSize) || 22 : 22;
  const productLines = hasMeasuredLines ? payload.productNameLines : wrapText(payload.productName, 22, 8);
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
  const quantityText = formatQuantity(payload.quantity);
  const dateText = String(payload.printedDate || formatDate());
  // Cỡ chữ đã đo thật (payload.footerFit, tính ở render.mjs) — không có thì ước lượng.
  const footer = payload.footerFit ?? fitFooter(quantityText, dateText, { measureQuantity: estimateTextWidth, measureDate: estimateTextWidth });
  return svgDocument(
    product +
    qr.rects +
    `<text x="160" y="${skuY}" font-size="32" font-weight="700" text-anchor="middle">${sku}</text>` +
    `<line x1="20" y1="${lineY}" x2="300" y2="${lineY}" stroke="#000" stroke-width="2"/>` +
    (quantityText ? `<text x="20" y="${footerY}" font-size="${footer.quantityFontSize}">${escapeXml(quantityText)}</text>` : "") +
    `<text x="300" y="${footerY}" font-size="${footer.dateFontSize}" text-anchor="end">${escapeXml(dateText)}</text>`
  );
}
