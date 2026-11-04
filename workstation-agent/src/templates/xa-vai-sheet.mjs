import sharp from "sharp";
import { escapeXml, LABEL_FONT_FAMILY } from "./common.mjs";
import { estimateTextWidth } from "./text-layout.mjs";

/**
 * PHIẾU THEO DÕI XẢ VẢI (agent 0.11.0, lệnh xa_vai_sheet v1) — khổ A4 NGANG, 300 dpi = 3508 × 2480 px mỗi trang.
 *
 * In qua driver Windows (powershell/print-bitmap.ps1) nên ảnh phải tự chừa lề: máy laser host-based (HP P1102w)
 * không in được sát mép (~4–5 mm). Lề trong ảnh 12 mm hai bên, 10,6 mm trên/dưới.
 *
 * CONTRACT V3: đầu MỖI trang là biển lớn như tờ treo ở kho — Mã hàng (itemCode) cỡ rất lớn bên trái, "Xả dd/mm/yyyy"
 * (ngày giờ VN của measuredAt, nhiều ngày thì khoảng) lớn bên phải cùng hàng — đọc được từ ~1,5 m; phía trên là dòng nhỏ
 * tiêu đề / IN LẠI / Trang / Ngày in; dưới biển là dòng "SKU … · tên" khi phiếu chỉ một SKU và có tên.
 *
 * Mỗi trang tối đa XA_VAI_ROWS_PER_PAGE dòng (tự tính từ chiều cao biển, dòng 7 mm); chỗ cho dòng TỔNG và hai ô ký được
 * chừa sẵn trên MỌI trang (chỉ vẽ ở trang cuối) nên số trang = ceil(số dòng / XA_VAI_ROWS_PER_PAGE), không bao giờ có trang
 * chỉ chứa phần ký.
 *
 * Bề rộng chữ ước lượng bằng estimateTextWidth (bảng em của Arial, rộng hơn chữ thật ~10–20%) cộng thêm hệ số cho
 * chữ đậm: chữ nào không vừa ô thì thu cỡ rồi mới cắt kèm "…" — không bao giờ tràn ô hay tràn lề.
 */
export const XA_VAI_PAGE = Object.freeze({ width: 3508, height: 2480, dpi: 300, marginX: 142, marginY: 125, margin: 125 });

const W = XA_VAI_PAGE.width;
const H = XA_VAI_PAGE.height;
const MX = XA_VAI_PAGE.marginX;
const MY = XA_VAI_PAGE.marginY;
const CONTENT_W = W - 2 * MX;   // 3224
const BOLD_FACTOR = 1.1;
const CELL_PAD = 18;
const VN_OFFSET_MS = 7 * 3600 * 1000;   // Việt Nam không có giờ mùa hè

// Bố cục dọc (px). Dòng nhỏ 56 · biển 250 · dòng SKU/tên 60 + 10 · tiêu đề bảng 72 · n × 83 · TỔNG 83 · 18 · ô ký 185;
// n = 18 → đáy 2353 ≤ H − MY = 2355.
const INFO_H = 56;              // PHIẾU THEO DÕI XẢ VẢI · IN LẠI | Trang · Ngày in
const BANNER_TOP = MY + INFO_H;
const BANNER_H = 250;           // 21 mm
const CODE_SIZE = 250;          // Mã hàng: cỡ 250 px ≈ chữ hoa cao 15 mm; mã dài thu dần tới 140 rồi mới cắt "…"
const CODE_MIN = 140;
const DATE_SIZE = 150;          // "Xả dd/mm/yyyy": chữ hoa cao ~9 mm; khoảng ngày dài thu tới 130
const DATE_MIN = 130;
const BANNER_GAP = 80;          // khoảng trống tối thiểu giữa Mã hàng và ngày xả
const DATE_MAX_W = 2100;        // trần bề rộng ngày xả (mã hàng luôn còn ≥ 1000 px)
const BANNER_BASELINE = BANNER_TOP + 210;   // Mã hàng và ngày xả cùng đường chân chữ (chữ hoa cỡ 250 cách vạch trên ~3 mm)
const NAME_BAND = 60;           // dòng dưới biển: "Mã hàng: <đầy đủ>" (khi biển phải cắt mã) · "SKU … · tên"
const FULL_CODE_SIZE = 36;
const FULL_CODE_MIN = 26;
const LINE_GAP = 48;            // khoảng giữa "Mã hàng: …" và "SKU … · tên"
const TABLE_TOP = BANNER_TOP + BANNER_H + NAME_BAND + 10;
const HEAD_H = 72;
const ROW_H = 83;               // 7,03 mm
const SIGN_GAP = 18;
const SIGN_H = 185;             // 15,7 mm — chừa trên mọi trang nên luôn vừa dưới số dòng tối đa + dòng tổng

/** Số dòng tối đa mỗi trang, tính từ chỗ còn lại sau biển và phần TỔNG + ô ký (chừa trên mọi trang). */
export const XA_VAI_ROWS_PER_PAGE = Math.floor((H - MY - TABLE_TOP - HEAD_H - ROW_H - SIGN_GAP - SIGN_H) / ROW_H);

// Tổng đúng CONTENT_W (3224). Lot và Roll rộng (Roll của WMS thường là Lot + "-" + số cuộn, Lot thật tới ~24 ký tự): mã
// định danh không nên bị cắt trên phiếu — 28 chữ hoa liền vẫn in đủ. Group UID 16 số, SKU 9 số vừa cỡ 34 (CONTRACT V3: cột
// SKU vì một phiếu có thể nhiều SKU). Cột số là mm nguyên (04/11/2026: không đổi mét, bỏ cột Co); "-100.000.000" vừa cỡ 34,
// bề rộng theo tiêu đề "(mm)".
const COLUMNS = Object.freeze([
  { key: "stt", title: "STT", width: 110, align: "middle" },
  { key: "groupUid", title: "Group UID", width: 370, align: "start" },
  { key: "sku", title: "SKU", width: 230, align: "start" },
  { key: "lot", title: "Lot", width: 607, align: "start" },
  { key: "roll", title: "Roll", width: 607, align: "start" },
  { key: "systemMm", title: "Hệ thống (mm)", width: 330, align: "end" },
  { key: "actualMm", title: "Thực tế (mm)", width: 320, align: "end" },
  { key: "diffMm", title: "Chênh lệch (mm)", width: 370, align: "end" },
  { key: "measuredAt", title: "Giờ nhập", width: 280, align: "middle" }
].map((column) => Object.freeze(column)));
export const XA_VAI_COLUMNS = COLUMNS;
// Ô nhãn TỔNG gộp các cột mã (STT … Roll).
const TOTAL_LABEL_SPAN = COLUMNS.findIndex((column) => column.key === "systemMm");

const DASH = "—";

const textWidth = (text, size, bold = false) => estimateTextWidth(text, size) * (bold ? BOLD_FACTOR : 1);

/**
 * mm nguyên kiểu Việt (04/11/2026: phiếu in mm, không đổi mét): nhóm nghìn bằng dấu chấm, 60758 → "60.758",
 * -2734 → "-2.734"; null → "—"; không in "-0".
 */
export function formatViMm(mm) {
  if (mm === null || mm === undefined || mm === "" || !Number.isFinite(Number(mm))) return DASH;
  const value = Math.round(Number(mm));
  if (value === 0) return "0";
  const integer = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}${integer}`;
}

function vnParts(iso) {
  const time = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(time)) return null;
  const date = new Date(time + VN_OFFSET_MS);
  const two = (number) => String(number).padStart(2, "0");
  return { day: two(date.getUTCDate()), month: two(date.getUTCMonth() + 1), year: date.getUTCFullYear(), hour: two(date.getUTCHours()), minute: two(date.getUTCMinutes()) };
}

/** "dd/mm/yyyy hh:mm" theo giờ Việt Nam. */
export function formatViDateTime(iso) {
  const p = vnParts(iso);
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : "";
}

function formatViShort(iso) {
  const p = vnParts(iso);
  return p ? `${p.hour}:${p.minute} ${p.day}/${p.month}` : "";
}

/**
 * Ngày xả trên biển (CONTRACT V3) = ngày giờ Việt Nam của measuredAt các dòng, từ nhỏ nhất tới lớn nhất của CẢ phiếu:
 * một ngày "Xả 04/11/2026"; nhiều ngày cùng năm "Xả 04/11 – 05/11/2026"; khác năm "Xả 31/12/2026 – 01/01/2027".
 */
export function xaVaiReleaseLabel(items) {
  const days = (Array.isArray(items) ? items : []).map((entry) => vnParts(entry?.measuredAt)).filter(Boolean)
    .map((p) => ({ ...p, key: `${p.year}${p.month}${p.day}` }));
  if (!days.length) return "";
  days.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const first = days[0];
  const last = days[days.length - 1];
  if (first.key === last.key) return `Xả ${first.day}/${first.month}/${first.year}`;
  if (first.year === last.year) return `Xả ${first.day}/${first.month} – ${last.day}/${last.month}/${last.year}`;
  return `Xả ${first.day}/${first.month}/${first.year} – ${last.day}/${last.month}/${last.year}`;
}

function hasSystem(item) {
  return item.systemMm !== null && item.systemMm !== undefined && Number.isFinite(Number(item.systemMm));
}

const toMm = (value) => Math.round(Number(value));

/** Giá trị đã định dạng (mm nguyên) của các cột số + giờ của một dòng. Chênh lệch = thực tế − hệ thống. */
export function xaVaiRowCells(item) {
  const actual = toMm(item.actualMm);
  const system = hasSystem(item) ? toMm(item.systemMm) : null;
  return {
    systemMm: system === null ? DASH : formatViMm(system),
    actualMm: formatViMm(actual),
    diffMm: system === null ? DASH : formatViMm(actual - system),
    measuredAt: formatViShort(item.measuredAt)
  };
}

/**
 * Dòng TỔNG (mm nguyên). Hệ thống chỉ cộng các dòng có số. Chênh lệch so thực tế với hệ thống CỦA CÙNG các dòng có
 * mét hệ thống — trộn cả thực tế của dòng thiếu mét hệ thống sẽ ra "chênh lệch" ảo. Khi mọi dòng đều có mét hệ thống
 * thì đúng bằng (tổng thực tế − tổng hệ thống). Tổng thực tế cộng mọi dòng.
 */
export function xaVaiTotals(items) {
  let actual = 0;
  let system = 0;
  let pairedActual = 0;
  let paired = 0;
  for (const item of items) {
    actual += toMm(item.actualMm);
    if (hasSystem(item)) {
      paired += 1;
      system += toMm(item.systemMm);
      pairedActual += toMm(item.actualMm);
    }
  }
  return {
    count: items.length,
    comparedCount: paired,
    systemMm: paired ? system : null,
    actualMm: actual,
    diffMm: paired ? pairedActual - system : null
  };
}

export function paginateXaVai(items) {
  const pages = [];
  for (let index = 0; index < items.length; index += XA_VAI_ROWS_PER_PAGE) pages.push(items.slice(index, index + XA_VAI_ROWS_PER_PAGE));
  return pages;
}

// Thu cỡ chữ tới minSize rồi mới cắt kèm "…", để chữ luôn nằm trong maxWidth.
function fitText(text, maxWidth, size, { minSize = Math.round(size * 0.7), bold = false } = {}) {
  const value = String(text ?? "");
  for (let current = size; current >= minSize; current -= 2) {
    if (textWidth(value, current, bold) <= maxWidth) return { text: value, size: current };
  }
  return { text: truncate(value, maxWidth, minSize, bold), size: minSize };
}

function truncate(value, maxWidth, size, bold) {
  const chars = [...value];
  while (chars.length && textWidth(`${chars.join("").trimEnd()}…`, size, bold) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

function textEl(x, y, value, { size, bold = false, anchor = "start", role = "" }) {
  return `<text x="${x}" y="${y}" font-size="${size}"${bold ? ' font-weight="bold"' : ""}${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}${role ? ` data-role="${role}"` : ""}>${escapeXml(value)}</text>`;
}

function cellText(column, left, rowTop, rowHeight, value, { size = 34, bold = false } = {}) {
  const maxWidth = column.width - 2 * CELL_PAD;
  const fitted = fitText(value, maxWidth, size, { bold });
  const x = column.align === "middle" ? left + column.width / 2 : column.align === "end" ? left + column.width - CELL_PAD : left + CELL_PAD;
  const y = Math.round(rowTop + rowHeight / 2 + fitted.size * 0.36);
  return textEl(Math.round(x), y, fitted.text, { size: fitted.size, bold, anchor: column.align });
}

// SKU chung của phiếu khi mọi dòng cùng một SKU, còn lại null.
function singleSku(items) {
  const skus = new Set(items.map((entry) => entry.sku));
  return skus.size === 1 ? [...skus][0] : null;
}

/** Đầu trang: dòng nhỏ (tiêu đề, IN LẠI, Trang, Ngày in) + biển lớn (Mã hàng | Xả …) + dòng "SKU … · tên" (tuỳ phiếu). */
function headerSvg(payload, releaseLabel, pageIndex, pageCount) {
  const parts = [];
  const right = W - MX;
  const infoBaseline = MY + 36;
  const title = "PHIẾU THEO DÕI XẢ VẢI";
  parts.push(textEl(MX, infoBaseline, title, { size: 34, bold: true }));
  if (payload.reprint) {
    const boxX = Math.ceil(MX + textWidth(title, 34, true) + 36);
    const boxW = 150;
    // Nền đen chữ trắng: nhìn lướt cũng thấy đây là bản in lại.
    parts.push(`<rect x="${boxX}" y="${MY}" width="${boxW}" height="48" fill="#000"/>`);
    parts.push(`<text x="${boxX + boxW / 2}" y="${infoBaseline + 1}" font-size="30" font-weight="bold" text-anchor="middle" fill="#fff">IN LẠI</text>`);
  }
  const printed = `Ngày in ${formatViDateTime(payload.printedAt)}`;
  parts.push(textEl(right, infoBaseline, printed, { size: 32, anchor: "end" }));
  parts.push(textEl(Math.floor(right - textWidth(printed, 32) - 56), infoBaseline, `Trang ${pageIndex + 1}/${pageCount}`, { size: 34, bold: true, anchor: "end" }));
  parts.push(`<line x1="${MX}" y1="${MY + INFO_H}" x2="${right}" y2="${MY + INFO_H}" stroke="#000" stroke-width="2" shape-rendering="crispEdges"/>`);

  // Biển: Mã hàng là chữ chính — ngày xả nhường trước (150 → 130) để mã giữ cỡ 250; mã chỉ thu (tới 140, quá nữa cắt "…")
  // khi ngày đã ở 130. Ngày xả không bao giờ bị cắt: khoảng dài nhất (khác năm) ở cỡ 130 cần ~1960 px < DATE_MAX_W.
  const codeFull = textWidth(payload.itemCode, CODE_SIZE, true);
  let dateSize = DATE_SIZE;
  while (dateSize > DATE_MIN && textWidth(releaseLabel, dateSize, true) + BANNER_GAP + codeFull > CONTENT_W) dateSize -= 2;
  const date = fitText(releaseLabel, DATE_MAX_W, dateSize, { minSize: DATE_MIN, bold: true });
  const codeRoom = CONTENT_W - textWidth(date.text, date.size, true) - BANNER_GAP;
  const code = fitText(payload.itemCode, codeRoom, CODE_SIZE, { minSize: CODE_MIN, bold: true });
  parts.push(textEl(MX, BANNER_BASELINE, code.text, { size: code.size, bold: true, role: "item-code" }));
  parts.push(textEl(right, BANNER_BASELINE, date.text, { size: date.size, bold: true, anchor: "end", role: "release-date" }));
  const bannerBottom = BANNER_TOP + BANNER_H;
  parts.push(`<line x1="${MX}" y1="${bannerBottom}" x2="${right}" y2="${bannerBottom}" stroke="#000" stroke-width="6" shape-rendering="crispEdges"/>`);

  // Một SKU + có tên: "SKU … · tên" một dòng (thu cỡ / cắt "…"). Nhiều SKU thì cột SKU của bảng đã đủ.
  // Review vòng 3: biển chỉ chứa ~16 ký tự ở cỡ 140 nhưng mã hợp lệ tới 40 — biển phải cắt "…" thì hai mã chỉ khác đuôi
  // (…-L / …-XL) ra cùng một biển. Khi đó in MÃ ĐẦY ĐỦ ở dòng dưới biển ("Mã hàng: …", đậm, cỡ 36 → tối thiểu 26, không
  // bao giờ cắt), đứng trước dòng "SKU … · tên" trên cùng hàng; tên sản phẩm bị cắt trước.
  const lineBaseline = bannerBottom + 46;
  let lineX = MX;
  if (code.text !== payload.itemCode) {
    const label = `Mã hàng: ${payload.itemCode}`;
    let size = FULL_CODE_SIZE;
    while (size > FULL_CODE_MIN && textWidth(label, size, true) > CONTENT_W) size -= 2;
    // Mã ≤ 40 ký tự (validator) rộng nhất ~1.600 px ở cỡ 36 nên không tới đây; giữ chốt chặn để không bao giờ in mã cụt.
    if (textWidth(label, size, true) > CONTENT_W) throw new Error("Mã hàng quá dài, không in đủ được trên phiếu");
    parts.push(textEl(MX, lineBaseline, label, { size, bold: true, role: "item-code-full" }));
    lineX = Math.ceil(MX + textWidth(label, size, true) + LINE_GAP);
  }
  const sku = payload.productName ? singleSku(payload.items) : null;
  if (sku && W - MX - lineX >= 200) {
    const line = fitText(`SKU ${sku} · ${payload.productName}`, W - MX - lineX, 36, { minSize: 28 });
    parts.push(textEl(lineX, lineBaseline, line.text, { size: line.size, role: "product-line" }));
  }
  return parts.join("");
}

function tableSvg(rows, startIndex, totals) {
  const parts = [];
  const lines = [];
  const lefts = [];
  let x = MX;
  for (const column of COLUMNS) { lefts.push(x); x += column.width; }
  const bodyTop = TABLE_TOP + HEAD_H;
  const bodyBottom = bodyTop + rows.length * ROW_H;
  const tableBottom = totals ? bodyBottom + ROW_H : bodyBottom;

  // Nền: hàng tiêu đề xám, dòng chẵn xám rất nhạt.
  parts.push(`<rect x="${MX}" y="${TABLE_TOP}" width="${CONTENT_W}" height="${HEAD_H}" fill="#dcdcdc"/>`);
  rows.forEach((_, index) => {
    if (index % 2 === 1) parts.push(`<rect x="${MX}" y="${bodyTop + index * ROW_H}" width="${CONTENT_W}" height="${ROW_H}" fill="#f0f0f0"/>`);
  });

  COLUMNS.forEach((column, index) => parts.push(cellText(column, lefts[index], TABLE_TOP, HEAD_H, column.title, { size: 30, bold: true })));
  rows.forEach((item, index) => {
    const top = bodyTop + index * ROW_H;
    const cells = xaVaiRowCells(item);
    const values = { stt: String(startIndex + index + 1), groupUid: item.groupUid, sku: item.sku, lot: item.lot, roll: item.roll, ...cells };
    COLUMNS.forEach((column, columnIndex) => parts.push(cellText(column, lefts[columnIndex], top, ROW_H, values[column.key])));
  });

  // Kẻ ngang mỗi dòng.
  for (let index = 1; index <= rows.length; index += 1) lines.push(`<line x1="${MX}" y1="${bodyTop + index * ROW_H}" x2="${W - MX}" y2="${bodyTop + index * ROW_H}" stroke-width="2"/>`);
  lines.push(`<line x1="${MX}" y1="${bodyTop}" x2="${W - MX}" y2="${bodyTop}" stroke-width="4"/>`);

  if (totals) {
    const top = bodyBottom;
    const spanColumns = TOTAL_LABEL_SPAN;   // STT · Group UID · SKU · Lot · Roll gộp làm ô nhãn
    const labelWidth = COLUMNS.slice(0, spanColumns).reduce((sum, column) => sum + column.width, 0);
    // Có UID thiếu mét hệ thống thì hai tổng không trừ ra đúng chênh lệch: ghi rõ chênh lệch tính trên bao nhiêu UID.
    const note = totals.comparedCount === totals.count ? ""
      : totals.comparedCount ? ` · chênh lệch: ${totals.comparedCount}/${totals.count} UID có mét hệ thống` : " · không có mét hệ thống để so";
    parts.push(cellText({ width: labelWidth, align: "start" }, MX, top, ROW_H, `TỔNG (${totals.count} UID)${note}`, { bold: true, size: note ? 28 : undefined }));
    const values = {
      systemMm: formatViMm(totals.systemMm), actualMm: formatViMm(totals.actualMm),
      diffMm: formatViMm(totals.diffMm), measuredAt: ""
    };
    COLUMNS.slice(spanColumns).forEach((column, offset) => parts.push(cellText(column, lefts[spanColumns + offset], top, ROW_H, values[column.key], { bold: true })));
    lines.push(`<line x1="${MX}" y1="${top}" x2="${W - MX}" y2="${top}" stroke-width="5"/>`);
  }

  // Kẻ dọc: trong dòng tổng bỏ các vạch giữa các cột của ô nhãn gộp.
  COLUMNS.forEach((column, index) => {
    if (index === 0) return;
    const bottom = totals && index < TOTAL_LABEL_SPAN ? bodyBottom : tableBottom;
    lines.push(`<line x1="${lefts[index]}" y1="${TABLE_TOP}" x2="${lefts[index]}" y2="${bottom}" stroke-width="2"/>`);
  });
  lines.push(`<rect x="${MX}" y="${TABLE_TOP}" width="${CONTENT_W}" height="${tableBottom - TABLE_TOP}" fill="none" stroke-width="4"/>`);
  return { svg: `${parts.join("")}<g stroke="#000" fill="none" shape-rendering="crispEdges">${lines.join("")}</g>`, bottom: tableBottom };
}

function signatureSvg(top) {
  const boxW = 760;
  const boxH = SIGN_H;
  const parts = [];
  ["Người xả", "Người kiểm"].forEach((label, index) => {
    const x = W - MX - (2 - index) * boxW - (1 - index) * 40;
    parts.push(`<rect x="${x}" y="${top}" width="${boxW}" height="${boxH}" fill="none" stroke="#000" stroke-width="3" shape-rendering="crispEdges"/>`);
    parts.push(textEl(x + boxW / 2, top + 44, label, { size: 32, bold: true, anchor: "middle" }));
  });
  return parts.join("");
}

/** SVG của từng trang phiếu (payload đã qua normalizeJob). */
export function renderXaVaiSheetSvgs(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const pages = paginateXaVai(items);
  const totals = xaVaiTotals(items);
  const releaseLabel = xaVaiReleaseLabel(items);   // cùng một chuỗi trên mọi trang
  return pages.map((rows, pageIndex) => {
    const last = pageIndex === pages.length - 1;
    const table = tableSvg(rows, pageIndex * XA_VAI_ROWS_PER_PAGE, last ? totals : null);
    // Ô ký ngay dưới dòng tổng; trang đủ số dòng tối đa thì đáy ô ký vẫn ≤ H − MY (XA_VAI_ROWS_PER_PAGE tính theo đó).
    const body = `${headerSvg({ ...payload, items }, releaseLabel, pageIndex, pages.length)}${table.svg}${last ? signatureSvg(table.bottom + SIGN_GAP) : ""}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${LABEL_FONT_FAMILY}" fill="#000"><rect width="${W}" height="${H}" fill="#fff"/>${body}</svg>`;
  });
}

/** PNG xám 300 dpi của từng trang, theo thứ tự. onProgress(trang đã dựng, tổng trang) chỉ để hiển thị. */
export async function renderXaVaiSheetPages(job, config = null, onProgress = null) {
  const svgs = renderXaVaiSheetSvgs(job.payload);
  const pages = [];
  for (const svg of svgs) {
    pages.push(await sharp(Buffer.from(svg)).flatten({ background: "#fff" }).greyscale().withMetadata({ density: XA_VAI_PAGE.dpi }).png({ compressionLevel: 6 }).toBuffer());
    if (onProgress) await onProgress(pages.length, svgs.length);
  }
  return pages;
}
