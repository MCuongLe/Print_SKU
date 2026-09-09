import { barcodeRects } from "./code128.mjs";
import { escapeXml, formatDate, LABEL_HEIGHT, LABEL_WIDTH, svgDocument, wrapText } from "./common.mjs";

export function renderSkuLabel(payload) {
  const sku = escapeXml(payload.sku);
  const barcode = barcodeRects(payload.sku, { x: 12, y: 15, width: 296, height: 62 });
  const productLines = wrapText(payload.productName, 26, 7);
  const product = productLines.map((line, index) =>
    `<text x="12" y="${145 + index * 25}" font-size="22">${escapeXml(line)}</text>`
  ).join("");
  const quantity = escapeXml(payload.quantity || "");
  const printedDate = escapeXml(payload.printedDate || formatDate());
  return svgDocument(
    `<rect x="2" y="2" width="316" height="476" fill="none" stroke="#000" stroke-width="2"/>` +
    barcode.rects +
    `<text x="160" y="103" font-size="25" text-anchor="middle">${sku}</text>` +
    product +
    `<line x1="20" y1="424" x2="300" y2="424" stroke="#000" stroke-width="2"/>` +
    (quantity ? `<text x="20" y="466" font-size="40" font-weight="700">${quantity}</text>` : "") +
    `<text x="300" y="466" font-size="17" text-anchor="end">${printedDate}</text>`
  );
}
