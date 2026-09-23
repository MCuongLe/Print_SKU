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
  const itemCodes = Array.isArray(payload.itemCodes)
    ? payload.itemCodes.slice(0, 5)
    : [payload.itemCode || ""];
  const codeSize = code => code.length <= 16 ? 20 : code.length <= 24 ? 15 : code.length <= 32 ? 12 : 10;
  const blocks = itemCodes.map((rawCode, index) => {
    const code = String(rawCode);
    const codeY = 45 + index * 88;
    const fieldY = codeY + 26;
    const lineY = codeY + 38;
    return `<text x="160" y="${codeY}" font-size="${codeSize(code)}" font-family="Courier New,monospace" font-weight="700" text-anchor="middle">${escapeXml(code)}</text>` +
      `<text x="8" y="${fieldY}" font-size="11">Ngày:</text><line x1="42" y1="${fieldY}" x2="106" y2="${fieldY}" stroke="#000" stroke-width="1" stroke-dasharray="2 3"/>` +
      `<text x="112" y="${fieldY}" font-size="11">Giờ:</text><line x1="136" y1="${fieldY}" x2="198" y2="${fieldY}" stroke="#000" stroke-width="1" stroke-dasharray="2 3"/>` +
      `<text x="204" y="${fieldY}" font-size="11">Lot:</text><line x1="226" y1="${fieldY}" x2="312" y2="${fieldY}" stroke="#000" stroke-width="1" stroke-dasharray="2 3"/>` +
      (index < itemCodes.length - 1 ? `<line x1="12" y1="${lineY}" x2="308" y2="${lineY}" stroke="#bbb" stroke-width="1"/>` : "");
  }).join("");
  return svgDocument(
    '<text x="160" y="21" font-size="17" text-anchor="middle">Mã hàng</text>' + blocks
  );
}
