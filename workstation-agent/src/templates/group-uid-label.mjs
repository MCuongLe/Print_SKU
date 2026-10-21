import { barcodeRects } from "./code128.mjs";
import { escapeXml, svgDocument, wrapText } from "./common.mjs";
import { fitTextBlock } from "./text-layout.mjs";

// Bố cục tem Group UID 40×60 mm (320×480 chấm), từ 0.10.0 (21/10/2026), từ trên xuống:
//   barcode Group UID y=14→68, số UID chân y=94
//   tên sản phẩm: dòng đầu chân y=122 ở cỡ 22, mỗi dòng cách 25, dòng cuối ≤ y=247 (6 dòng cỡ 22)
//   khối chữ đậm Số lô / Số cuộn / RFID: chân y=274, 297, 320 (dòng trống bị bỏ, các dòng còn lại dồn lên)
//   ô hai cột SỐ PO | NGÀY NHẬN: y=332→376 (chỉ vẽ khi có PO hoặc ngày nhận; cột trống để viết bút)
//   barcode SKU y=392→436, "SKU: …" chân y=462 (không SKU thì bỏ barcode và dòng SKU)
// Cỡ nhỏ hơn của tên giữ nguyên mép trên (y=100) và mép dưới (y=247) của khung nên chứa được nhiều dòng hơn.
export const GROUP_UID_NAME_LAYOUT = { top: 100, lastBaseline: 247 };
export const GROUP_UID_NAME_MAX_WIDTH_PX = 296; // vùng chữ: x=12 → x=308, bằng bề rộng barcode
export const GROUP_UID_INFO_LAYOUT = { baselines: [274, 297, 320], x: 12, maxWidthPx: 296 };
export const GROUP_UID_BOX_LAYOUT = {
  left: 12, right: 308, top: 332, bottom: 376, divider: 184, // viền 2 chấm nằm trong khung x=12→308, y=332→376
  labelSize: 13, labelY: 347, valueY: 370, padding: 11,
  valueSizes: [18, 17, 16, 15, 14, 13, 12] // cỡ đậm thường gặp 18 cho cả hai cột; chuỗi dài mới thu nhỏ, từng cột riêng
};
export const GROUP_UID_SKU_LAYOUT = { barcodeY: 392, barcodeHeight: 44, textY: 462, textSize: 22 };

export function groupUidNameBaseline(fontSize, index) {
  return GROUP_UID_NAME_LAYOUT.top + fontSize + index * (fontSize + 3);
}

// Số dòng tên tối đa ở một cỡ chữ — render.mjs dùng đúng hàm này khi chọn cỡ.
export function groupUidMaxLines(fontSize) {
  return Math.max(1, Math.floor((GROUP_UID_NAME_LAYOUT.lastBaseline - groupUidNameBaseline(fontSize, 0)) / (fontSize + 3)) + 1);
}

export function hasGroupUidSku(payload) {
  return Boolean(String(payload.sku || "").trim());
}

function infoBlock(payload) {
  const text = (value) => String(value ?? "").trim();
  const rows = [
    text(payload.lot) ? `Số lô: ${text(payload.lot)}` : "",
    text(payload.roll) ? `Số cuộn: ${text(payload.roll)}` : "",
    text(payload.rfid) ? `RFID: ${text(payload.rfid)}` : ""
  ].filter(Boolean);
  if (!rows.length) return "";
  const size = fitTextBlock(rows, GROUP_UID_INFO_LAYOUT.maxWidthPx);
  return rows.map((row, index) =>
    `<text x="${GROUP_UID_INFO_LAYOUT.x}" y="${GROUP_UID_INFO_LAYOUT.baselines[index]}" font-size="${size}" font-weight="700">${escapeXml(row)}</text>`
  ).join("");
}

// Ô SỐ PO | NGÀY NHẬN. Có một trong hai thì vẽ cả ô, cột không có giá trị để trống cho người vận hành ghi bút.
function poDateBox(payload) {
  const po = String(payload.po ?? "").trim();
  const date = String(payload.receivedDate ?? "").trim();
  if (!po && !date) return "";
  const b = GROUP_UID_BOX_LAYOUT;
  const poX = b.left + b.padding, dateX = b.divider + b.padding;
  const label = (x, text) => `<text x="${x}" y="${b.labelY}" font-size="${b.labelSize}">${text}</text>`;
  const value = (x, text, maxWidthPx) => text
    ? `<text x="${x}" y="${b.valueY}" font-size="${fitTextBlock([text], maxWidthPx, { sizes: b.valueSizes })}" font-weight="700">${escapeXml(text)}</text>`
    : "";
  return `<rect x="${b.left + 1}" y="${b.top + 1}" width="${b.right - b.left - 2}" height="${b.bottom - b.top - 2}" rx="5" fill="none" stroke="#000" stroke-width="2"/>` +
    `<line x1="${b.divider}" y1="${b.top + 1}" x2="${b.divider}" y2="${b.bottom - 1}" stroke="#000" stroke-width="2"/>` +
    label(poX, "SỐ PO") + value(poX, po, b.divider - b.padding - poX) +
    label(dateX, "NGÀY NHẬN") + value(dateX, date, b.right - b.padding / 2 - dateX);
}

export function renderGroupUidLabel(payload) {
  const topBarcode = barcodeRects(payload.groupUid, { x: 12, y: 14, width: 296, height: 54 });
  const hasSku = hasGroupUidSku(payload);
  const sku = GROUP_UID_SKU_LAYOUT;
  const bottomBarcode = hasSku ? barcodeRects(payload.sku, { x: 12, y: sku.barcodeY, width: 296, height: sku.barcodeHeight }) : null;
  // Ưu tiên kết quả đo bề rộng THẬT (payload.productNameLines + productNameFontSize,
  // tính ở render.mjs giống tem SKU). Không có thì lùi về cách cũ: đếm 26 ký
  // tự/dòng ở cỡ 22, tối đa 6 dòng.
  const measured = Array.isArray(payload.productNameLines) && payload.productNameLines.length > 0;
  const fontSize = measured ? Number(payload.productNameFontSize) || 22 : 22;
  const nameLines = measured
    ? payload.productNameLines
    : wrapText(payload.productName || payload.materialName || "", 26, groupUidMaxLines(22));
  const lines = nameLines.map((line, index) =>
    `<text x="12" y="${groupUidNameBaseline(fontSize, index)}" font-size="${fontSize}">${escapeXml(line)}</text>`
  ).join("");
  return svgDocument(
    topBarcode.rects +
    `<text x="160" y="94" font-size="24" text-anchor="middle">${escapeXml(payload.groupUid)}</text>` +
    lines +
    infoBlock(payload) +
    poDateBox(payload) +
    (hasSku ? bottomBarcode.rects +
    `<text x="160" y="${sku.textY}" font-size="${sku.textSize}" text-anchor="middle">SKU: ${escapeXml(payload.sku)}</text>` : "")
  );
}
