import { qrRects } from "./qr.mjs";
import { escapeXml, formatDate, LABEL_HEIGHT, LABEL_WIDTH, svgDocument, wrapText } from "./common.mjs";

// Hằng số bố cục dùng chung với `maxLinesForSize` trong text-layout.mjs — MỘT
// nguồn sự thật duy nhất. Đổi khoảng đệm ở đây thì phải đổi luôn layout truyền
// cho `fitProductName` ở render.mjs, nếu không hai nơi sẽ tính lệch nhau.
export const SKU_LABEL_LAYOUT = {
  labelHeight: LABEL_HEIGHT,
  qrSize: 147, // ước lượng trước khi biết kích thước QR thật: box=154, SKU 9–10 chữ số ra QR version 1 (21 module) nên module≈7
  skuOffset: 28,
  lineOffset: 16,
  dateOffset: 28,
  pad: 10,
  bottomMargin: 17,
};
export const SKU_LABEL_MAX_WIDTH_PX = 296; // vùng chữ: x=12 → x≈308

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
  const { skuOffset, lineOffset, dateOffset, pad } = SKU_LABEL_LAYOUT;
  const qrTop = Math.max(170, 34 + productLines.length * lineHeight + pad);
  const qr = qrRects(payload.sku, { centerX: LABEL_WIDTH / 2, top: qrTop, box: 154 });
  const skuY = qrTop + qr.size + skuOffset;
  const lineY = skuY + lineOffset;
  const footerY = lineY + dateOffset;
  const quantityRaw = String(payload.quantity || "");
  const quantity = escapeXml(quantityRaw);
  // Số lượng dài thì thu nhỏ font để không đè lên ngày (vùng trống bên trái ~200 dot: x=20 → ~220).
  const QTY_MAX_WIDTH = 200;
  const quantityFont = Math.max(18, Math.min(40, Math.floor(QTY_MAX_WIDTH / Math.max(1, quantityRaw.length * 0.62))));
  const printedDate = escapeXml(payload.printedDate || formatDate());
  return svgDocument(
    product +
    qr.rects +
    `<text x="160" y="${skuY}" font-size="32" font-weight="700" text-anchor="middle">${sku}</text>` +
    `<line x1="20" y1="${lineY}" x2="300" y2="${lineY}" stroke="#000" stroke-width="2"/>` +
    (quantity ? `<text x="20" y="${footerY}" font-size="${quantityFont}" font-weight="700">${quantity}</text>` : "") +
    `<text x="300" y="${footerY}" font-size="17" text-anchor="end">${printedDate}</text>`
  );
}
