import { qrRects } from "./qr.mjs";
import { escapeXml, formatDate, LABEL_WIDTH, svgDocument, wrapText } from "./common.mjs";

export function renderSkuLabel(payload) {
  const sku = escapeXml(payload.sku);
  // Tên sản phẩm ở trên cùng (tối đa 8 dòng — tăng từ 7 để tên dài hiển thị được
  // trọn vẹn thay vì bị cắt bớt); mã QR ở giữa; số SKU dưới QR; số lượng và ngày
  // ở cuối tem.
  const productLines = wrapText(payload.productName, 22, 8);
  const product = productLines.map((line, index) =>
    `<text x="12" y="${34 + index * 25}" font-size="22">${escapeXml(line)}</text>`
  ).join("");
  // QR dời xuống dưới khối tên (chừa đệm cho tên dài), tối thiểu y=170 khi tên
  // ngắn. Các khoảng đệm QR→SKU, SKU→vạch kẻ, vạch kẻ→ngày đã được thu hẹp so
  // với bản cũ (36/18/42 → 28/16/28) để nhường đúng phần đó cho dòng tên thứ 8 —
  // tên dài 8 dòng vẫn còn ~17 dot lề dưới cùng, không tràn khỏi mép tem.
  const qrTop = Math.max(170, 34 + productLines.length * 25 + 10);
  const qr = qrRects(payload.sku, { centerX: LABEL_WIDTH / 2, top: qrTop, box: 154 });
  const skuY = qrTop + qr.size + 28;
  const lineY = skuY + 16;
  const footerY = lineY + 28;
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
