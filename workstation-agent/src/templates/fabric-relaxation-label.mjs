import { escapeXml, svgDocument } from "./common.mjs";

export function renderFabricRelaxationLabel(payload) {
  if (!Array.isArray(payload.itemCodes)) {
    const code = String(payload.itemCode || "");
    const lines = code.match(/.{1,16}/g) || [""];
    return svgDocument(
      '<text x="160" y="44" font-size="26" text-anchor="middle">Mã hàng</text>' +
      lines.map((line, index) => `<text x="160" y="${82 + index * 32}" font-size="28" font-family="Courier New,monospace" font-weight="700" text-anchor="middle">${escapeXml(line)}</text>`).join("") +
      ["Ngày", "Giờ", "Lot"].map((name, index) => {
        const y = 225 + index * 100;
        return `<text x="16" y="${y}" font-size="28">${name}:</text><line x1="94" y1="${y}" x2="300" y2="${y}" stroke="#000" stroke-width="2" stroke-dasharray="2 6"/>`;
      }).join("")
    );
  }
  const itemCodes = payload.itemCodes.slice(0, 5);
  const codeSize = code => Math.min(28, Math.floor(460 / Math.max(1, code.length)));
  const blocks = itemCodes.map((rawCode, index) => {
    const code = String(rawCode);
    const codeY = 76 + index * 32;
    return `<text x="160" y="${codeY}" font-size="${codeSize(code)}" font-family="Courier New,monospace" font-weight="700" text-anchor="middle">${escapeXml(code)}</text>`;
  }).join("");
  return svgDocument(
    '<text x="160" y="40" font-size="26" text-anchor="middle">Mã hàng</text>' + blocks +
    ["Ngày", "Giờ", "Lot"].map((name, index) => {
      const y = 270 + index * 70;
      return `<text x="16" y="${y}" font-size="26">${name}:</text><line x1="94" y1="${y}" x2="300" y2="${y}" stroke="#000" stroke-width="2" stroke-dasharray="2 6"/>`;
    }).join("")
  );
}
