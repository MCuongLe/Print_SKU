import { escapeXml, svgDocument } from "./common.mjs";

export function renderFabricRelaxationLabel(payload) {
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
