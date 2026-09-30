import { barcodeRects } from "./code128.mjs";
import { escapeXml, svgDocument, wrapText } from "./common.mjs";

// Khung tên sản phẩm trên tem Group UID. Ở cỡ 22 (mặc định) chân dòng đầu ở
// y=145, mỗi dòng cách 25: có SKU thì dòng cuối ≤ y=270 (6 dòng, chừa vùng SKU
// bắt đầu ở y=332), không SKU thì ≤ y=295 (7 dòng) — đúng như bố cục cũ. Cỡ nhỏ
// hơn giữ nguyên mép trên và mép dưới khung nên chứa được nhiều chữ hơn.
export const GROUP_UID_NAME_LAYOUT = {
  top: 123,
  lastBaselineWithSku: 270,
  lastBaselineNoSku: 295,
};
export const GROUP_UID_NAME_MAX_WIDTH_PX = 296; // vùng chữ: x=12 → x=308, bằng bề rộng barcode

export function groupUidNameBaseline(fontSize, index) {
  return GROUP_UID_NAME_LAYOUT.top + fontSize + index * (fontSize + 3);
}

// Số dòng tên tối đa ở một cỡ chữ — render.mjs dùng đúng hàm này khi chọn cỡ.
export function groupUidMaxLines(fontSize, hasSku) {
  const last = hasSku ? GROUP_UID_NAME_LAYOUT.lastBaselineWithSku : GROUP_UID_NAME_LAYOUT.lastBaselineNoSku;
  return Math.max(1, Math.floor((last - groupUidNameBaseline(fontSize, 0)) / (fontSize + 3)) + 1);
}

export function hasGroupUidSku(payload) {
  return Boolean(String(payload.sku || "").trim());
}

export function renderGroupUidLabel(payload) {
  const topBarcode = barcodeRects(payload.groupUid, { x: 12, y: 15, width: 296, height: 62 });
  const hasSku = hasGroupUidSku(payload);
  const bottomBarcode = hasSku ? barcodeRects(payload.sku, { x: 12, y: 352, width: 296, height: 66 }) : null;
  // Ưu tiên kết quả đo bề rộng THẬT (payload.productNameLines + productNameFontSize,
  // tính ở render.mjs giống tem SKU). Không có thì lùi về cách cũ: đếm 26 ký
  // tự/dòng ở cỡ 22, tối đa 6 dòng khi có SKU, 7 dòng khi không.
  const measured = Array.isArray(payload.productNameLines) && payload.productNameLines.length > 0;
  const fontSize = measured ? Number(payload.productNameFontSize) || 22 : 22;
  const nameLines = measured
    ? payload.productNameLines
    : wrapText(payload.productName || payload.materialName || "", 26, hasSku ? 6 : 7);
  const lines = nameLines.map((line, index) =>
    `<text x="12" y="${groupUidNameBaseline(fontSize, index)}" font-size="${fontSize}">${escapeXml(line)}</text>`
  ).join("");
  // Lot và Roll in ở đáy tem, dưới barcode SKU (kết thúc ở y=418) — đúng chỗ
  // người vận hành vẫn ghi bút. Bỏ trống thì không vẽ, tem giữ nguyên như cũ.
  const lot = String(payload.lot || "").trim();
  const roll = String(payload.roll || "").trim();
  const footer =
    (lot ? `<text x="12" y="452" font-size="24">LOT: ${escapeXml(lot)}</text>` : "") +
    (roll ? `<text x="308" y="452" font-size="24" text-anchor="end">ROLL: ${escapeXml(roll)}</text>` : "");
  return svgDocument(
    topBarcode.rects +
    `<text x="160" y="103" font-size="25" text-anchor="middle">${escapeXml(payload.groupUid)}</text>` +
    lines +
    (hasSku ? `<text x="32" y="332" font-size="24">SKU:</text>` +
    `<text x="112" y="332" font-size="24">${escapeXml(payload.sku)}</text>` +
    bottomBarcode.rects : "") +
    footer
  );
}
