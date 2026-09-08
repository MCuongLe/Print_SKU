// Bảng pattern Code 128 được tách từ lõi AuditFactory đã đối chiếu JsBarcode.
// Agent mới sở hữu bản mã này và không đọc AuditFactory khi chạy.
const PATTERNS = '11011001100110011011001100110011010010011000100100011001000100110010011001000100110001001000110010011001001000110010001001100010010010110011100100110111001001100111010111001100100111011001001110011011001110010110010111001100100111011011100100110011101001110110111011101001100111001011001110010011011101100100111001101001110011001011011011000110110001101100011011010100011000100010110001000100011010110001000100011010001000110001011010001000110001010001100010001010110111000101100011101000110111010111011000101110001101000111011011101110110110100011101100010111011011101000110111000101101110111011101011000111010001101110001011011101101000111011000101110001101011101111010110010000101111000101010100110000101000011001001011000010010000110100001011001000010011010110010000101100001001001101000010011000010100001101001000011001011000010010110010100001111011101011000010100100011110101010011110010010111100100100111101011110010010011110100100111100101111010010011110010100111100100101101101111011011110110111101101101010111100010100011110100010111101011110100010111100010111101010001111010001010111011110101111011101110101111011110101110110100001001101001000011010011100';
const STOP = '1100011101011';
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;

const patternOf = (value) => value === 106 ? STOP : PATTERNS.slice(value * 11, value * 11 + 11);

function digitRun(text, at) {
  let end = at;
  while (end < text.length && /\d/.test(text[end])) end += 1;
  return end - at;
}

export function encodeCode128(value) {
  const text = String(value ?? "");
  if (!text || [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)) {
    throw new Error("Barcode Code 128 chỉ hỗ trợ ASCII 32..126");
  }
  const codes = [];
  let mode = "B";
  let index = 0;
  if (/^\d+$/.test(text) && text.length >= 4) {
    if (text.length % 2 === 0) {
      codes.push(START_C);
      mode = "C";
    } else {
      codes.push(START_B, text.charCodeAt(0) - 32, CODE_C);
      index = 1;
      mode = "C";
    }
  } else {
    codes.push(START_B);
  }

  while (index < text.length) {
    if (mode === "B") {
      let run = digitRun(text, index);
      if (run >= 4) {
        if (run % 2 === 1) {
          codes.push(text.charCodeAt(index) - 32);
          index += 1;
          run -= 1;
        }
        codes.push(CODE_C);
        mode = "C";
        continue;
      }
      codes.push(text.charCodeAt(index) - 32);
      index += 1;
      continue;
    }
    const run = digitRun(text, index);
    if (run >= 2) {
      codes.push(Number(text.slice(index, index + 2)));
      index += 2;
    } else {
      codes.push(CODE_B);
      mode = "B";
    }
  }

  let checksum = codes[0];
  for (let i = 1; i < codes.length; i += 1) checksum += codes[i] * i;
  codes.push(checksum % 103, 106);
  return codes.map(patternOf).join("");
}

export function barcodeRects(value, options = {}) {
  const bits = encodeCode128(value);
  const quietModules = options.quietModules ?? 10;
  const maximumWidth = options.width ?? 280;
  const moduleWidth = Math.max(1, Math.floor(maximumWidth / (bits.length + quietModules * 2)));
  const totalWidth = (bits.length + quietModules * 2) * moduleWidth;
  const x = (options.x ?? 0) + Math.max(0, (maximumWidth - totalWidth) / 2) + quietModules * moduleWidth;
  const y = options.y ?? 0;
  const height = options.height ?? 64;
  let output = "";
  let index = 0;
  while (index < bits.length) {
    if (bits[index] === "0") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < bits.length && bits[end] === "1") end += 1;
    output += `<rect x="${x + index * moduleWidth}" y="${y}" width="${(end - index) * moduleWidth}" height="${height}" fill="#000"/>`;
    index = end;
  }
  return { rects: output, moduleWidth, totalWidth, bits };
}
