import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { LABEL_GAP_MM, LABEL_HEIGHT, LABEL_HEIGHT_MM, LABEL_WIDTH, ROW_GAP_MM, ROW_WIDTH } from "./templates/common.mjs";
import { renderLabelSvg } from "./templates/index.mjs";
import { planLocationLabels } from "./location-plan.mjs";
import { formatDate, formatQuantity, LABEL_FONT_FAMILY } from "./templates/common.mjs";
import { SKU_LABEL_LAYOUT, SKU_LABEL_MAX_WIDTH_PX } from "./templates/sku-label.mjs";
import { GROUP_UID_NAME_MAX_WIDTH_PX, groupUidMaxLines, hasGroupUidSku } from "./templates/group-uid-label.mjs";
import {
  DATE_FONT_SIZES, estimateTextWidth, fitFooter, maxLinesForSize, productNameCandidates, QUANTITY_FONT_SIZES, tokenize, verifyLineWidths,
  WRAP_SAFETY_FACTOR
} from "./templates/text-layout.mjs";

// Cac co chu thu theo thu tu tu lon xuong nho khi ten qua dai khong vua ngay
// ca o co mac dinh — xem RULES.md phan "Do chu that". San 16px la con doc duoc
// tren tem nhiet 60mm; khong ha thap hon.
const PRODUCT_NAME_FONT_SIZES = [22, 20, 18, 16];
// Uoc luong du phong khi mot token khong co trong bang da do (khong nen xay ra
// vi da gom truoc, phong khi PowerShell tra ve thieu): trung binh Arial ~11px
// moi ky tu o co 22, ty le tuyen tinh theo co chu (da do that, xem RULES.md).
const AVG_CHAR_WIDTH_AT_22 = 11;

// Khung tên của từng loại tem có tên sản phẩm. Tem fabric_relaxation không in
// tên nên không có ở đây.
const NAME_LAYOUTS = {
  sku: { maxWidthPx: SKU_LABEL_MAX_WIDTH_PX, maxLinesFor: () => (size) => maxLinesForSize(size, SKU_LABEL_LAYOUT) },
  group_uid: { maxWidthPx: GROUP_UID_NAME_MAX_WIDTH_PX, maxLinesFor: (payload) => (size) => groupUidMaxLines(size, hasGroupUidSku(payload)) }
};

/**
 * Tinh truoc so dong va co chu that su cho ten san pham cua moi tem co ten
 * (SKU va Group UID) trong lo, dua theo be rong chu THAT (measureText, thuong
 * la measureTextWidths tu text-metrics.mjs) thay vi dem dau nguoi so ky tu/dong.
 * Gom du lieu can do va goi PowerShell dung HAI LAN cho ca lo (xem RULES.md
 * phan "Do chu that"):
 *
 *   Vong 1 — do tung TOKEN rieng le, dung de wrap SO BO (co bien an toan
 *   WRAP_SAFETY_FACTOR, xem text-layout.mjs). Sum-token KHONG dang tin tuyet
 *   doi: do that ngay 24/09/2026 cho thay tong 5 token rieng cua cum "Opened
 *   end/No.3 Plastic Zipper" la 294,7px, nhung do NGUYEN ca cum la 313,07px —
 *   lech 6,2% vi GDI+ bo "side bearing" o hai dau MOI LAN do doc lap, dem cang
 *   nhieu token thi sai so cang cong don. Tin thang so nay da lam mat chu "r"
 *   cuoi "Zipper" tren tem in that. So luong va ngay o day tem SKU do luon
 *   trong lan goi nay (options.extra).
 *
 *   Vong 2 — do NGUYEN tung dong da wrap o vong 1, o MOI co con lai tu co da
 *   chon tro xuong. Dong nao van vuot thi verifyLineWidths tach bot token cuoi
 *   xuong dong moi; neu vi vay ten vuot so dong cho phep thi chuyen sang co nho
 *   hon (da do san), chi cat khi da o co nho nhat.
 *
 * Van CHI HAI LAN GOI PowerShell CHO CA LO (khong tang theo so tem).
 *
 * Tra ve MANG MOI, khong sua doi `entries` dau vao (mot phan tu co the la
 * chinh `job` goc khi lenh khong phai dang batch, sua tai cho se lam thay doi
 * du lieu cua nguoi goi ngoai y muon).
 *
 * `measureText` khong duoc truyen (mac dinh) thi bo qua buoc nay hoan toan —
 * cac template se tu lui ve cach dem ky tu cu.
 */
export async function planProductNames(entries, config, measureText, logger) {
  if (!measureText) return entries;
  const nameEntries = entries.filter((entry) => NAME_LAYOUTS[entry.type] && entry.payload?.productName);
  if (!nameEntries.length) return entries;
  const skuEntries = nameEntries.filter((entry) => entry.type === "sku");

  const allTokens = new Set();
  for (const entry of nameEntries) for (const token of tokenize(entry.payload.productName)) allTokens.add(token);
  // Số lượng và ngày ở đáy tem SKU đo luôn trong lần gọi vòng 1 (cỡ chữ riêng),
  // không thêm lần gọi PowerShell nào.
  const footerTexts = new Map(skuEntries.map((entry) => [entry, {
    quantity: formatQuantity(entry.payload.quantity),
    date: String(entry.payload.printedDate || formatDate())
  }]));

  let tokenWidths;
  try {
    tokenWidths = await measureText(config, [...allTokens], PRODUCT_NAME_FONT_SIZES, {
      extra: [
        { texts: [...footerTexts.values()].map((footer) => footer.quantity), sizes: QUANTITY_FONT_SIZES },
        { texts: [...footerTexts.values()].map((footer) => footer.date), sizes: DATE_FONT_SIZES }
      ]
    });
  } catch (error) {
    logger?.warn?.(`Đo chữ thật thất bại (vòng 1), dùng cách đếm ký tự cũ: ${String(error?.message || error).slice(0, 200)}`);
    return entries;
  }
  const measureAt = (text, size) =>
    tokenWidths.get(text)?.get(size) ?? text.length * AVG_CHAR_WIDTH_AT_22 * (size / 22);
  const [quantityWidths, dateWidths] = tokenWidths.extra ?? [];
  const measureFooter = (widths) => (text, size) => widths?.get(text)?.get(size) ?? estimateTextWidth(text, size);

  const plans = new Map(nameEntries.map((entry) => {
    const layout = NAME_LAYOUTS[entry.type];
    const footer = footerTexts.get(entry);
    return [entry, {
      maxWidthPx: layout.maxWidthPx,
      candidates: productNameCandidates(entry.payload.productName, {
        measureAt,
        maxWidthPx: layout.maxWidthPx,
        fontSizes: PRODUCT_NAME_FONT_SIZES,
        maxLinesFor: layout.maxLinesFor(entry.payload),
        // Dùng đủ khung trước, thận trọng sau; vòng 2 đo lại nguyên dòng nên không tràn.
        widthFactors: [1, WRAP_SAFETY_FACTOR]
      }),
      footerFit: footer && fitFooter(footer.quantity, footer.date, {
        measureQuantity: measureFooter(quantityWidths),
        measureDate: measureFooter(dateWidths)
      })
    }];
  }));
  const withPlan = (entry, lines, fontSize, plan) => ({
    ...entry,
    payload: { ...entry.payload, productNameLines: lines, productNameFontSize: fontSize, ...(plan.footerFit ? { footerFit: plan.footerFit } : {}) }
  });

  // Vong 2: do nguyen tung dong cua moi phuong an con lai, o DUNG co chu cua phuong an do.
  // 0.8.6: truoc day do moi dong o moi co dang dung (buoc chon chi doc dong o co cua chinh no)
  // — gap ~4 lan so phep do va so muc text-cache phai luu. Moi co la mot nhom do them (extra)
  // trong CUNG mot lan goi PowerShell, nen van dung hai lan goi cho ca lo.
  const linesBySize = new Map();
  for (const { candidates } of plans.values()) {
    for (const candidate of candidates) {
      const lines = linesBySize.get(candidate.fontSize) ?? new Set();
      for (const line of candidate.lines) lines.add(line);
      linesBySize.set(candidate.fontSize, lines);
    }
  }

  let lineWidths;
  try {
    const [[firstSize, firstLines], ...otherSizes] = [...linesBySize.entries()];
    const measured = await measureText(config, [...firstLines], [firstSize], {
      extra: otherSizes.map(([size, lines]) => ({ texts: [...lines], sizes: [size] }))
    });
    lineWidths = new Map();
    for (const group of [measured, ...(measured?.extra ?? [])]) {
      for (const [text, bySize] of group ?? []) {
        const row = lineWidths.get(text) ?? new Map();
        for (const [size, width] of bySize) row.set(size, width);
        lineWidths.set(text, row);
      }
    }
  } catch (error) {
    // Vong 1 da co (an toan hon ban cu), nhung chua xac nhan — van hon han
    // cach dem ky tu, nen dung tam ket qua vong 1 thay vi bo het.
    logger?.warn?.(`Đo chữ thật thất bại (vòng 2, xác nhận), dùng kết quả wrap sơ bộ: ${String(error?.message || error).slice(0, 200)}`);
    return entries.map((entry) => {
      const plan = plans.get(entry);
      if (!plan) return entry;
      const [first] = plan.candidates;
      return withPlan(entry, first.lines.slice(0, first.maxLines), first.fontSize, plan);
    });
  }

  return entries.map((entry) => {
    const plan = plans.get(entry);
    if (!plan) return entry;
    // Chọn phương án vừa khung ở cỡ lớn nhất; cùng cỡ thì ưu tiên phương án
    // không phải tách dòng ở bước xác nhận (tách dòng để lại dòng ngắn lẻ).
    let pick = null;
    let last = null;
    for (const candidate of plan.candidates) {
      const { fontSize } = candidate;
      const measureWholeLine = (text) => lineWidths.get(text)?.get(fontSize) ?? Infinity;
      const measureToken = (text) => measureAt(text, fontSize);
      const verified = verifyLineWidths(candidate.lines, { measureWholeLine, measureToken }, plan.maxWidthPx);
      last = { candidate, verified };
      if (verified.length > candidate.maxLines) continue;
      const clean = verified.length === candidate.lines.length;
      if (clean && (!pick || pick.candidate.fontSize === fontSize)) { pick = last; break; }
      if (!pick) pick = last;
      else if (pick.candidate.fontSize !== fontSize) break;
    }
    const { candidate: chosen, verified } = pick ?? last;
    if (verified.length > chosen.maxLines) {
      logger?.warn?.(`Tên sản phẩm quá dài, cỡ ${chosen.fontSize} vẫn cần ${verified.length}/${chosen.maxLines} dòng — cắt bớt: ${entry.payload.productName.slice(0, 80)}`);
    }
    return withPlan(entry, verified.slice(0, chosen.maxLines), chosen.fontSize, plan);
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
  // innerSvg bỏ thẻ <svg> của từng tem, mất luôn font-family của nó; phải khai
  // báo lại ở gốc hàng, nếu không tem in thật ra font mặc định có chân (lỗi có
  // từ bản đầu, sửa 30/09/2026) trong khi preview tem đơn vẫn là Arial.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ROW_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${ROW_WIDTH} ${LABEL_HEIGHT}" shape-rendering="crispEdges" font-family="${LABEL_FONT_FAMILY}"><rect width="${ROW_WIDTH}" height="${LABEL_HEIGHT}" fill="#fff"/><g>${first}</g>${second ? `<g transform="translate(${secondX},0)">${second}</g>` : ""}</svg>`;
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
  entries = await planProductNames(entries, config, measureText, logger);
  entries = await planLocationLabels(entries, config, measureText, logger);
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
  entries = await planProductNames(entries, config, measureText, logger);
  entries = await planLocationLabels(entries, config, measureText, logger);
  await sharp(Buffer.from(renderLabelSvg(entries[0]))).png().toFile(outputFile);
  return outputFile;
}
