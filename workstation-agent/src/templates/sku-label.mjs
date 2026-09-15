import { qrRects } from "./qr.mjs";
import { escapeXml, formatDate, LABEL_WIDTH, svgDocument, wrapText } from "./common.mjs";

export function renderSkuLabel(payload) {
  const sku = escapeXml(payload.sku);
  // Tên sản phẩm ở trên cùng (tối đa 7 dòng); mã QR ở giữa; số SKU dưới QR; số lượng và ngày ở cuối tem.
  const productLines = wrapText(payload.productName, 22, 7);
  const product = productLines.map((line, index) =>
    `<text x="12" y="${34 + index * 25}" font-size="22">${escapeXml(line)}</text>`
  ).join("");
  // QR dời xuống dưới khối tên (chừa ~2 hàng đệm cho tên dài), tối thiểu y=170.
  const qrTop = Math.max(170, 34 + productLines.length * 25 + 14);
  const qr = qrRects(payload.sku, { centerX: LABEL_WIDTH / 2, top: qrTop, box: 154 });
  const skuY = qrTop + qr.size + 36;
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
    `<line x1="20" y1="424" x2="300" y2="424" stroke="#000" stroke-width="2"/>` +
    (quantity ? `<text x="20" y="466" font-size="${quantityFont}" font-weight="700">${quantity}</text>` : "") +
    `<text x="300" y="466" font-size="17" text-anchor="end">${printedDate}</text>`
  );
}
