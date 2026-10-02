import { QR_ALPHANUMERIC, qrRects } from "./qr.mjs";
import { escapeXml, LABEL_WIDTH, svgDocument } from "./common.mjs";
import { estimateTextWidth, wrapByWidth } from "./text-layout.mjs";

// Tem mã vị trí 40 × 60 mm (320 × 480 dot) theo mẫu tem dán kệ: QR chứa đúng mã vị trí ở
// trên, mã vị trí Arial đậm ngay dưới QR, tên vị trí Arial thường canh giữa phía dưới.
// Màn MÃ VỊ TRÍ trong index.html vẽ xem trước theo đúng các số này — đổi ở đây thì đổi cả bên đó.
//
// KHÔNG BAO GIỜ bỏ bớt ký tự: mã dài thì ép ngang chữ, tên dài thì xuống dòng/giảm cỡ, dòng
// nào vẫn rộng hơn vùng chữ thì ép ngang riêng dòng đó.
export const LOCATION_LABEL_LAYOUT = {
  qrTop: 40,             // lề trắng trên QR 5 mm = 4 module ở version 1 (chuẩn QR cần ≥ 4)
  qrBox: 224,            // QR ~26 mm như tem mẫu; khoảng trắng hai bên ≥ 4 module ở mọi version 1–4
  codeGap: 36,           // từ đáy QR tới đỉnh chữ mã (≥ 3 module trắng dưới QR)
  maxWidth: 296,         // vùng chữ x=12 → x=308
  codeFontSizes: [44, 40, 36, 32, 28, 24],
  minCondense: 0.6,      // mã dài thì ép ngang chữ (như mẫu in), ưu tiên không hẹp hơn 60%
  nameGap: 18,
  nameFontSizes: [30, 28, 26, 24, 22, 20, 18, 16, 14, 12],
  nameBottom: 464,       // chân chữ thấp nhất (gồm phần dưới dòng) không quá y=464
};

// Đỉnh chữ hoa Arial ≈ 0,72 cỡ chữ; phần dưới dòng (g, y, dấu nặng) ≈ 0,22 cỡ chữ.
const CAP_RATIO = 0.72;
const DESCENT_RATIO = 0.22;

// Bề rộng ký tự Arial Bold (phần nghìn cỡ chữ) cho toàn bộ ký tự được phép trong mã vị trí
// [0-9A-Z._/-]. Đo lại bằng GDI+ (Arial Bold, GenericTypographic) ngày 02/10/2026: khớp từng
// ký tự, lệch < 0,15%; đo nguyên chuỗi bằng đúng tổng các ký tự (không có kerning cộng thêm).
const ARIAL_BOLD = {
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  ".": 278, "_": 556, "/": 278, "-": 333,
};
const CODE_SAFETY = 1.01;

// Bề rộng thật (px) của mã vị trí in Arial Bold ở cỡ `size`; ký tự ngoài bảng tính 1 em.
export function measureLocationCode(code, size) {
  let units = 0;
  for (const char of String(code ?? "")) units += ARIAL_BOLD[char] ?? 1000;
  return (units / 1000) * size * CODE_SAFETY;
}

// Biên an toàn khi xuống dòng tên: số đo GDI+ thật thì chỉ chừa 2%, ước lượng thì 5%.
export const LOCATION_NAME_SAFETY = { measured: 0.98, estimated: 0.95 };

export function fitLocationCode(code, layout = LOCATION_LABEL_LAYOUT) {
  const sizes = layout.codeFontSizes;
  for (const fontSize of sizes) {
    const scale = Math.min(1, layout.maxWidth / measureLocationCode(code, fontSize));
    if (scale >= layout.minCondense) return { fontSize, scale };
  }
  const fontSize = sizes[sizes.length - 1];
  return { fontSize, scale: Math.min(1, layout.maxWidth / measureLocationCode(code, fontSize)) };
}

// Vị trí QR, chữ mã và mép trên khối tên — dùng chung cho template và bước đo chữ của agent.
export function locationGeometry(code, layout = LOCATION_LABEL_LAYOUT) {
  const qr = qrRects(code, { centerX: LABEL_WIDTH / 2, top: layout.qrTop, box: layout.qrBox, mode: QR_ALPHANUMERIC.test(code) ? "Alphanumeric" : "Byte" });
  const codeFit = fitLocationCode(code, layout);
  const codeY = layout.qrTop + qr.size + layout.codeGap + Math.round(codeFit.fontSize * CAP_RATIO);
  return { qr, codeFit, codeY, nameTop: codeY + layout.nameGap };
}

/**
 * Chọn cỡ chữ và cách xuống dòng cho tên vị trí (Arial thường). `measure(text, size)` trả bề
 * rộng px — agent truyền số đo GDI+ thật (location-plan.mjs), không có thì dùng ước lượng.
 * Ưu tiên ít dòng (tem mẫu in tên một dòng): 1 dòng tới cỡ 24, rồi 2 dòng tới cỡ 22, cuối cùng
 * mọi cỡ còn lại. Trả về cả bề rộng từng dòng để template ép ngang dòng nào còn quá rộng.
 */
export function fitLocationName(name, top, { measure = estimateTextWidth, safety = LOCATION_NAME_SAFETY.estimated, layout = LOCATION_LABEL_LAYOUT } = {}) {
  const text = String(name ?? "").trim();
  const maxWidth = layout.maxWidth * safety;
  const plan = (fontSize) => {
    const lineHeight = Math.round(fontSize * 1.2);
    const lines = measure(text, fontSize) <= maxWidth ? [text] : wrapByWidth(text, (part) => measure(part, fontSize), maxWidth);
    const bottom = top + fontSize + (lines.length - 1) * lineHeight + Math.ceil(fontSize * DESCENT_RATIO);
    return { fontSize, lineHeight, lines, widths: lines.map((line) => measure(line, fontSize)), fits: bottom <= layout.nameBottom };
  };
  const plans = layout.nameFontSizes.map(plan);
  for (const [maxLines, minSize] of [[1, 24], [2, 22], [Infinity, 0]]) {
    const found = plans.find((candidate) => candidate.fits && candidate.lines.length <= maxLines && candidate.fontSize >= minSize);
    if (found) return found;
  }
  // Tên ≤ 60 ký tự luôn vừa trước cỡ nhỏ nhất; nếu vẫn không vừa thì giữ ĐỦ mọi dòng ở cỡ nhỏ nhất.
  return plans[plans.length - 1];
}

// Đặt chữ canh giữa tại (tâm, y); rộng hơn vùng chữ thì ép ngang quanh tâm tem.
function centeredText(text, y, fontSize, width, maxWidth, weight = "") {
  const scale = width > maxWidth ? maxWidth / width : 1;
  const placement = scale < 1
    ? `transform="translate(${LABEL_WIDTH / 2} ${y}) scale(${scale.toFixed(3)} 1)" x="0" y="0"`
    : `x="${LABEL_WIDTH / 2}" y="${y}"`;
  return `<text ${placement} font-size="${fontSize}"${weight} text-anchor="middle">${escapeXml(text)}</text>`;
}

export function renderLocationLabel(payload, layout = LOCATION_LABEL_LAYOUT) {
  const code = String(payload.code ?? "");
  const { qr, codeFit, codeY, nameTop } = locationGeometry(code, layout);
  const nameFit = payload.nameFit ?? fitLocationName(payload.name, nameTop, { layout });
  const codeWidth = measureLocationCode(code, codeFit.fontSize);
  const nameLines = nameFit.lines.map((line, index) => centeredText(
    line, nameTop + nameFit.fontSize + index * nameFit.lineHeight, nameFit.fontSize,
    nameFit.widths?.[index] ?? estimateTextWidth(line, nameFit.fontSize), layout.maxWidth
  )).join("");
  return svgDocument(
    qr.rects +
    centeredText(code, codeY, codeFit.fontSize, codeWidth, layout.maxWidth, ' font-weight="700"') +
    nameLines
  );
}
