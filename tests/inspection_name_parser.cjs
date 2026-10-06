const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("        const stripTrailingCode =");
const end = html.indexOf("        const parsePo =", start);
assert.ok(start >= 0 && end > start, "Không tìm thấy thuật toán parseNameParts trong index.html");

const source = `${html.slice(start, end)}\nresult = { stripTrailingCode, isColourSegment, parseNameParts, inferUnitFromName };`;
const sandbox = { result: null };
vm.runInNewContext(source, sandbox, { filename: "inspection-name-parser.js" });
const { parseNameParts, inferUnitFromName } = sandbox.result;

const aqlStart = html.indexOf("        const aqlSample =");
const aqlEnd = html.indexOf("        const b64ToBytes =", aqlStart);
assert.ok(aqlStart >= 0 && aqlEnd > aqlStart, "Không tìm thấy thuật toán AQL trong index.html");
const aqlSandbox = { result: null };
vm.runInNewContext(`${html.slice(aqlStart, aqlEnd)}\nresult = aqlSample;`, aqlSandbox, { filename: "inspection-aql.js" });

const fixtures = [
  {
    name: "(Combo) Chỉ mẫu/FX-0001_NCC Mẫu/100% Polyester/none/Xám lông chuột HP SBD17 (2)/Tex 24-100D-2/none/cuộn 5000m",
    supplier: "NCC Mẫu",
    colour: "Xám lông chuột"
  },
  {
    name: "Dây kéo mẫu/ZIP-001_NCC Mẫu/100% polyester/None/Dusty Green-Rêu V6S67/67cm/pcs",
    supplier: "NCC Mẫu",
    colour: "Dusty Green-Rêu"
  },
  {
    name: "Vải mẫu/FAB-001_NCC Mẫu/85% Poly 15% Nylon/300gsm-1800mm/Trắng Kem-Off White/m",
    supplier: "NCC Mẫu",
    colour: "Trắng Kem-Off White"
  },
  {
    name: "Vải mẫu/FAB-002_NCC Mẫu/95% Cotton 5% Spandex/165cm, 220gsm/Xanh Navy-Navy 19-4031TCX/Kg",
    supplier: "NCC Mẫu",
    colour: "Xanh Navy-Navy"
  },
  {
    name: "Nhãn care mẫu/93% cotton 7% Spandex LAB001_ACME LABELS/100% Polyester/none/White_TN035/none/25x78mm/pcs",
    supplier: "ACME LABELS",
    colour: "White"
  },
  {
    name: "Dây thun mẫu/ELASTIC-001_NCC Mẫu/60% Nylon 40% Polyester/none/Đen SBD17 (2)/25mm/none/m",
    supplier: "NCC Mẫu",
    colour: "Đen"
  },
  {
    name: "(Combo) Dây thun/CODE123-38 Spica/62% nylon,30% polyester, 8% spandex/None/Black/None/3.8cm/yard",
    supplier: "Spica",
    colour: "Black",
    unit: "yard"
  }
];

for (const fixture of fixtures) {
  const actual = parseNameParts(fixture.name);
  assert.equal(actual.supplier, fixture.supplier, `Sai supplier: ${fixture.name}`);
  assert.equal(actual.colour, fixture.colour, `Sai màu: ${fixture.name}`);
  if (fixture.unit) assert.equal(inferUnitFromName(fixture.name), fixture.unit, `Sai đơn vị: ${fixture.name}`);
}

assert.equal(aqlSandbox.result(3), 3, "Lô 3 yard phải kiểm đủ 3");
assert.equal(aqlSandbox.result(32), 32, "Lô 32 phải kiểm 32");
assert.equal(aqlSandbox.result(280), 32, "Lô 280 áp dụng mẫu chuẩn 32");

console.log(`inspection_name_parser: ${fixtures.length}/${fixtures.length} fixtures passed`);
