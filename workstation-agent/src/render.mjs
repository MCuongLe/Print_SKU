import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { LABEL_GAP_MM, LABEL_HEIGHT, LABEL_HEIGHT_MM, LABEL_WIDTH, ROW_GAP_MM, ROW_WIDTH } from "./templates/common.mjs";
import { renderLabelSvg } from "./templates/index.mjs";
import { SKU_LABEL_LAYOUT, SKU_LABEL_MAX_WIDTH_PX } from "./templates/sku-label.mjs";
import { fitProductName, maxLinesForSize, tokenize, verifyLineWidths } from "./templates/text-layout.mjs";

// Cac co chu thu theo thu tu tu lon xuong nho khi ten qua dai khong vua ngay
// ca o co mac dinh — xem RULES.md phan "Do chu that". San 16px la con doc duoc
// tren tem nhiet 60mm; khong ha thap hon.
const PRODUCT_NAME_FONT_SIZES = [22, 20, 18, 16];
// Uoc luong du phong khi mot token khong co trong bang da do (khong nen xay ra
// vi da gom truoc, phong khi PowerShell tra ve thieu): trung binh Arial ~11px
// moi ky tu o co 22, ty le tuyen tinh theo co chu (da do that, xem RULES.md).
const AVG_CHAR_WIDTH_AT_22 = 11;

/**
 * Tinh truoc so dong va co chu that su cho tung tem SKU trong lo, dua theo be
 * rong chu THAT (measureText, thuong la measureTextWidths tu text-metrics.mjs)
 * thay vi dem dau nguoi 22 ky tu/dong. Gom du lieu can do va goi PowerShell
 * dung HAI LAN cho ca lo (xem RULES.md phan "Do chu that"):
 *
 *   Vong 1 — do tung TOKEN rieng le, dung de wrap SO BO (co bien an toan
 *   WRAP_SAFETY_FACTOR, xem text-layout.mjs). Sum-token KHONG dang tin tuyet
 *   doi: do that ngay 24/09/2026 cho thay tong 5 token rieng cua cum "Opened
 *   end/No.3 Plastic Zipper" la 294,7px, nhung do NGUYEN ca cum la 313,07px —
 *   lech 6,2% vi GDI+ bo "side bearing" o hai dau MOI LAN do doc lap, dem cang
 *   nhieu token thi sai so cang cong don. Tin thang so nay da lam mat chu "r"
 *   cuoi "Zipper" tren tem in that.
 *
 *   Vong 2 — do NGUYEN tung dong da wrap o vong 1, xac nhan lai bang so that.
 *   Dong nao van vuot (hiem, nho da co bien an toan) thi verifyLineWidths tach
 *   bot token cuoi xuong dong moi — an toan tuyet doi vi bot noi dung luon lam
 *   dong hep hon, khong phu thuoc dac tinh do cua GDI+.
 *
 * Van CHI HAI LAN GOI PowerShell CHO CA LO (khong tang theo so tem) — ~1,6-1,8
 * giay tong cong, khong dang ke so voi thoi gian render/spool ca lo.
 *
 * Tra ve MANG MOI, khong sua doi `entries` dau vao (mot phan tu co the la
 * chinh `job` goc khi lenh khong phai dang batch, sua tai cho se lam thay doi
 * du lieu cua nguoi goi ngoai y muon).
 *
 * `measureText` khong duoc truyen (mac dinh) thi bo qua buoc nay hoan toan —
 * cac ham renderSkuLabel se tu lui ve cach dem ky tu cu. Do la duong dung cho
 * moi test hien co va cho cac loi goi chua can nang cap.
 */
export async function planSkuProductNames(entries, config, measureText, logger) {
  if (!measureText) return entries;
  const skuEntries = entries.filter((entry) => entry.type === "sku" && entry.payload?.productName);
  if (!skuEntries.length) return entries;

  const allTokens = new Set();
  for (const entry of skuEntries) for (const token of tokenize(entry.payload.productName)) allTokens.add(token);

  let tokenWidths;
  try {
    tokenWidths = await measureText(config, [...allTokens], PRODUCT_NAME_FONT_SIZES);
  } catch (error) {
    logger?.warn?.(`Đo chữ thật thất bại (vòng 1), dùng cách đếm ký tự cũ: ${String(error?.message || error).slice(0, 200)}`);
    return entries;
  }
  const measureAt = (text, size) =>
    tokenWidths.get(text)?.get(size) ?? text.length * AVG_CHAR_WIDTH_AT_22 * (size / 22);

  const plans = skuEntries.map((entry) => ({
    entry,
    fit: fitProductName(entry.payload.productName, {
      measureAt,
      maxWidthPx: SKU_LABEL_MAX_WIDTH_PX,
      fontSizes: PRODUCT_NAME_FONT_SIZES,
      layout: SKU_LABEL_LAYOUT
    })
  }));

  // Vong 2: do nguyen tung dong da wrap so bo, o dung co chu se in ra.
  const lineTexts = new Set();
  const usedSizes = new Set();
  for (const { fit } of plans) {
    for (const line of fit.lines) lineTexts.add(line);
    usedSizes.add(fit.fontSize);
  }

  let lineWidths;
  try {
    lineWidths = await measureText(config, [...lineTexts], [...usedSizes]);
  } catch (error) {
    // Vong 1 da co (an toan hon ban cu), nhung chua xac nhan — van hon han
    // cach dem ky tu, nen dung tam ket qua vong 1 thay vi bo het.
    logger?.warn?.(`Đo chữ thật thất bại (vòng 2, xác nhận), dùng kết quả wrap sơ bộ: ${String(error?.message || error).slice(0, 200)}`);
    return entries.map((entry) => {
      const plan = plans.find((p) => p.entry === entry);
      if (!plan) return entry;
      return { ...entry, payload: { ...entry.payload, productNameLines: plan.fit.lines, productNameFontSize: plan.fit.fontSize } };
    });
  }

  return entries.map((entry) => {
    const plan = plans.find((p) => p.entry === entry);
    if (!plan) return entry;
    const { fontSize, lines } = plan.fit;
    const measureWholeLine = (text) => lineWidths.get(text)?.get(fontSize) ?? Infinity;
    const measureToken = (text) => measureAt(text, fontSize);
    const verified = verifyLineWidths(lines, { measureWholeLine, measureToken }, SKU_LABEL_MAX_WIDTH_PX)
      .slice(0, maxLinesForSize(fontSize, SKU_LABEL_LAYOUT));
    return { ...entry, payload: { ...entry.payload, productNameLines: verified, productNameFontSize: fontSize } };
  });
}

function innerSvg(svg) {
  return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

export function renderRowSvg(jobs, count = 2) {
  const pair = (Array.isArray(jobs) ? jobs : [jobs, count > 1 ? jobs : null]).slice(0, 2).filter(Boolean);
  const secondX = LABEL_WIDTH + LABEL_GAP_MM * 8;
  const first = innerSvg(renderLabelSvg(pair[0]));
  const second = pair[1] ? innerSvg(renderLabelSvg(pair[1])) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ROW_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${ROW_WIDTH} ${LABEL_HEIGHT}" shape-rendering="crispEdges"><rect width="${ROW_WIDTH}" height="${LABEL_HEIGHT}" fill="#fff"/><g>${first}</g>${second ? `<g transform="translate(${secondX},0)">${second}</g>` : ""}</svg>`;
}

export function rawToMonochrome(raw, width, height, threshold = 170) {
  const bytesPerRow = Math.ceil(width / 8);
  // TSPL BITMAP uses 0 for a printed (black) dot and 1 for an unprinted (white) dot.
  const bitmap = Buffer.alloc(bytesPerRow * height, 0xff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (raw[y * width + x] < threshold) bitmap[y * bytesPerRow + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return { bitmap, bytesPerRow };
}

async function rowBitmap(jobs) {
  const svg = renderRowSvg(jobs);
  const { data, info } = await sharp(Buffer.from(svg)).flatten({ background: "#fff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { ...rawToMonochrome(data, info.width, info.height), width: info.width, height: info.height };
}

function tsplHeader(config) {
  const rowWidthMm = 40 * 2 + LABEL_GAP_MM;
  return Buffer.from(`SIZE ${rowWidthMm} mm,${LABEL_HEIGHT_MM} mm\r\nGAP ${ROW_GAP_MM} mm,0\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nDENSITY ${config.density}\r\nSPEED ${config.speed}\r\n`, "ascii");
}

export async function renderJobTspl(job, config, onProgress = null, { measureText, logger } = {}) {
  const pieces = [tsplHeader(config)];
  let entries = Array.isArray(job.payload?.items)
    ? job.payload.items.map((item) => ({ ...job, copies: item.copies, payload: item }))
    : [job];
  entries = await planSkuProductNames(entries, config, measureText, logger);
  // Trải phẳng mọi tem của lệnh rồi ghép 2 tem liền kề (kể cả khác nội dung) vào một hàng giấy 2 tem.
  const labels = [];
  for (const entry of entries) for (let i = 0; i < entry.copies; i += 1) labels.push(entry);
  const total = labels.length;
  let rendered = 0;
  for (let index = 0; index < labels.length; index += 2) {
    const row = await rowBitmap(labels.slice(index, index + 2));
    pieces.push(Buffer.from(`CLS\r\nBITMAP 0,0,${row.bytesPerRow},${row.height},0,`, "ascii"));
    pieces.push(row.bitmap);
    pieces.push(Buffer.from("\r\nPRINT 1\r\n", "ascii"));
    rendered = Math.min(index + 2, total);
    if (onProgress && (rendered % 20 === 0 || rendered === total)) await onProgress(rendered, total);
  }
  return Buffer.concat(pieces);
}

export async function writePreview(job, outputFile, { config, measureText, logger } = {}) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  let entries = Array.isArray(job.payload?.items)
    ? [{ ...job, payload: job.payload.items[0] }]
    : [job];
  entries = await planSkuProductNames(entries, config, measureText, logger);
  await sharp(Buffer.from(renderLabelSvg(entries[0]))).png().toFile(outputFile);
  return outputFile;
}
