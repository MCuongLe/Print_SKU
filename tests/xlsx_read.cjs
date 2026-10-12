// Bộ đọc .xlsx tối giản cho test: giải zip (store/deflate), kiểm CRC, trả về các dòng của sheet đầu tiên.
// Ô chữ (inlineStr / sharedStrings) trả về chuỗi, ô số trả về số; đủ để kiểm file xuất của app, không thay thế trình đọc Excel.
const zlib = require("node:zlib");

function readZip(buffer) {
  const files = {};
  let end = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("không phải file zip");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("thư mục trung tâm zip hỏng");
    const method = buffer.readUInt16LE(cursor + 10), crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32), local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.slice(dataStart, dataStart + compressed);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    if (data.length !== size) throw new Error(`${name}: kích thước giải nén không khớp`);
    if (zlib.crc32(data) !== crc) throw new Error(`${name}: CRC không khớp`);
    files[name] = data;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decode = text => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function readXlsx(buffer) {
  const files = readZip(buffer), names = Object.keys(files), sheetName = names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error("không có worksheet");
  const sheet = files[sheetName].toString("utf8");
  const shared = files["xl/sharedStrings.xml"] ? [...files["xl/sharedStrings.xml"].toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(""))) : [];
  const rows = [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
    const cells = {};
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1], type = /t="([^"]+)"/.exec(c[1])?.[1], inner = c[2] || "";
      let value = "";
      if (type === "inlineStr") value = decode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(""));
      else if (type === "s") value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? "";
      else if (/<v>/.test(inner)) value = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)[1]);
      cells[ref] = value;
    }
    return cells;
  });
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { files, names, sheet, workbook: files["xl/workbook.xml"].toString("utf8"), rows, table: rows.map(r => columns.map(c => r[c] ?? "")) };
}

module.exports = { readZip, readXlsx };
