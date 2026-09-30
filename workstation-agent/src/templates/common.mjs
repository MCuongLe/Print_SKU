export const DOTS_PER_MM = 8;
export const LABEL_WIDTH_MM = 40;
export const LABEL_HEIGHT_MM = 60;
export const LABEL_GAP_MM = 2;
export const ROW_GAP_MM = 3;
export const LABEL_WIDTH = LABEL_WIDTH_MM * DOTS_PER_MM;
export const LABEL_HEIGHT = LABEL_HEIGHT_MM * DOTS_PER_MM;
export const ROW_WIDTH = (LABEL_WIDTH_MM * 2 + LABEL_GAP_MM) * DOTS_PER_MM;

export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function wrapText(value, maxCharacters, maxLines = 4) {
  const tokens = String(value ?? "").trim().match(/[^\s/]*[\s/]|[^\s/]+$/g) || [];
  const lines = [];
  let current = "";
  for (let token of tokens) {
    while (token.trimEnd().length > maxCharacters) {
      if (current.trim()) lines.push(current.trimEnd());
      current = "";
      lines.push(token.slice(0, maxCharacters));
      token = token.slice(maxCharacters);
    }
    if ((current + token).trimEnd().length > maxCharacters) {
      if (current.trim()) lines.push(current.trimEnd());
      current = token;
    } else current += token;
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.slice(0, maxLines);
}

// Font của mọi tem; đo chữ thật (GDI+) cũng đo đúng font này.
export const LABEL_FONT_FAMILY = "Arial,Helvetica,sans-serif";

export function svgDocument(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}" shape-rendering="crispEdges" font-family="${LABEL_FONT_FAMILY}"><rect width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" fill="#fff"/>${body}</svg>`;
}

// Số lượng trên tem dùng dấu chấm phân cách hàng nghìn kiểu Việt Nam: 1.000.000.
// Chỉ nhóm dãy chữ số nguyên từ 4 chữ số trở lên đứng riêng; không động vào số
// đã có dấu chấm (1.000), phần sau dấu phẩy thập phân (1234,5 → 1.234,5), số
// kiểu 12.5, dãy dính sau chữ cái (mã hàng) hay dãy bắt đầu bằng 0.
export function formatQuantity(value) {
  return String(value ?? "").trim().replace(/(?<![\d\p{L}.,])\d{4,}(?!\.\d)/gu, (digits) =>
    digits.startsWith("0") ? digits : digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  );
}

export function formatDate(date = new Date()) {
  const two = (number) => String(number).padStart(2, "0");
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${String(date.getFullYear()).slice(-2)}`;
}
