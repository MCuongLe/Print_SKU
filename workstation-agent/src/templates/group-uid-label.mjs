import { barcodeRects } from "./code128.mjs";
import { escapeXml, svgDocument, wrapText } from "./common.mjs";

function productLines(payload, maxLines) {
  return wrapText(payload.productName || payload.materialName || "", 26, maxLines);
}

export function renderGroupUidLabel(payload) {
  const topBarcode = barcodeRects(payload.groupUid, { x: 12, y: 15, width: 296, height: 62 });
  const hasSku = Boolean(String(payload.sku || "").trim());
  const bottomBarcode = hasSku ? barcodeRects(payload.sku, { x: 12, y: 352, width: 296, height: 66 }) : null;
  // Vùng SKU bắt đầu ở y=332 nên tên chỉ được 6 dòng khi có SKU; không SKU thì 7 dòng.
  const lines = productLines(payload, hasSku ? 6 : 7).map((line, index) =>
    `<text x="12" y="${145 + index * 25}" font-size="22">${escapeXml(line)}</text>`
  ).join("");
  return svgDocument(
    topBarcode.rects +
    `<text x="160" y="103" font-size="25" text-anchor="middle">${escapeXml(payload.groupUid)}</text>` +
    lines +
    (hasSku ? `<text x="32" y="332" font-size="24">SKU:</text>` +
    `<text x="112" y="332" font-size="24">${escapeXml(payload.sku)}</text>` +
    bottomBarcode.rects : "")
  );
}
