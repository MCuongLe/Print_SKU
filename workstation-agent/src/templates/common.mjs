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

export function svgDocument(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}" shape-rendering="crispEdges" font-family="Arial,Helvetica,sans-serif"><rect width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" fill="#fff"/>${body}</svg>`;
}

export function formatDate(date = new Date()) {
  const two = (number) => String(number).padStart(2, "0");
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${String(date.getFullYear()).slice(-2)}`;
}
