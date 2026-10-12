// Xuất Excel của bộ công cụ dùng chung (AdminSyncUI.xlsxBlob): chạy hàm thật lấy từ index.html trong sandbox, không cần trình duyệt.
// Group UID 16 số phải ra Excel là chữ đủ chữ số (không thành 1.02826E+15), số ra số, "dd/mm/yyyy hh:mm" ra ngày giờ thật.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readXlsx } = require("./xlsx_read.cjs");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const slice = (from, to) => {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `Không tìm thấy đoạn mã: ${from.slice(0, 50)}`);
  return html.slice(a, b);
};
const zipSource = slice("const crcTable = (() =>", "window.PrintSkuZip.buildZip = buildZip;") + "window.PrintSkuZip.buildZip = buildZip;";
const toolkitSource = slice("        // Xuất Excel (.xlsx) cho mọi bảng", "        function download(name,blob)");
const context = { window: { PrintSkuZip: {} }, TextEncoder, Uint8Array, Int32Array, Blob, Number, String, Date, Math, Array, Object };
vm.runInNewContext(`${zipSource}\n${toolkitSource}\nthis.xlsxBlob = xlsxBlob;`, context);

(async () => {
  const head = ["Thời điểm", "Group UID", "SKU", "Sản phẩm", "Tồn", "Vị trí", "Ghi chú"];
  const rows = [
    ["10/10/2026 22:13", "1028260605000272", "422513459", "Vải Single /HP SV18/60% Cotton & 40% Polyester <190gsm>", 12000.5, "F0-VR-00-00-00-00", 'Cắt "đôi" \'x\''],
    ["31/09/2026 10:00", "0123456789012345", "0123", "Ngày sai", 7, "—", ""],
    ["08/10/2026 09:43", "1028260605000299", "422513460", null, 0, "F0-KHO-503-02-04-01", "tab\u0001ctl"],
  ];
  const blob = context.xlsxBlob(head, rows, "Lịch sử: UID/1");
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const book = readXlsx(Buffer.from(await blob.arrayBuffer())); // đọc cả CRC và kích thước từng phần

  assert.deepEqual(book.names, ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
  assert.equal(book.table.length, 4, "tiêu đề + 3 dòng");
  assert.deepEqual(book.table[0], head);
  assert.equal(book.table[1][1], "1028260605000272", "Group UID 16 số là chữ, đủ chữ số");
  assert.equal(book.table[2][1], "0123456789012345", "mã có số 0 đầu giữ nguyên");
  assert.equal(book.table[2][2], "0123");
  assert.equal(typeof book.table[1][4], "number");
  assert.equal(book.table[1][4], 12000.5, "số ra số");
  // 10/10/2026 22:13 = 46305 + 22:13/24 ngày (Excel xếp ngày 01/01/1900 = 1, có tính ngày nhuận giả 29/02/1900)
  assert.ok(Math.abs(book.table[1][0] - (46305 + (22 * 60 + 13) / 1440)) < 1e-9, "ngày giờ ra số ngày của Excel");
  assert.equal(book.table[2][0], "31/09/2026 10:00", "ngày không có thật thì giữ nguyên là chữ");
  assert.equal(book.table[3][3], "", "ô rỗng/null ra chuỗi rỗng");
  assert.equal(book.table[1][3], "Vải Single /HP SV18/60% Cotton & 40% Polyester <190gsm>", "ký tự XML đặc biệt được thoát và đọc lại nguyên vẹn");
  assert.equal(book.table[1][6], 'Cắt "đôi" \'x\'');
  assert.equal(book.table[3][6], "tabctl", "ký tự điều khiển bị bỏ để Excel không báo lỗi file");

  // Định dạng: dòng tiêu đề dính, có bộ lọc, độ rộng cột theo nội dung (10–60), kiểu ô
  assert.match(book.sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(book.sheet, /<autoFilter ref="A1:G4"\/>/);
  assert.match(book.sheet, /<col min="1" max="1" width="18" customWidth="1"\/>/);
  assert.match(book.sheet, /<col min="4" max="4" width="57" customWidth="1"\/>/);
  assert.match(book.sheet, /<pageSetup orientation="landscape" paperSize="9"/);
  assert.match(book.sheet, /<c r="A2" s="4"><v>[\d.]+<\/v><\/c>/);
  assert.match(book.sheet, /<c r="B2" s="2" t="inlineStr">/);
  assert.match(book.sheet, /<c r="E2" s="3"><v>12000.5<\/v><\/c>/);
  assert.match(book.workbook, /<sheet name="Lịch sử UID1" sheetId="1" r:id="rId1"\/>/, "tên sheet bỏ ký tự Excel cấm");
  assert.match(book.workbook, /_xlnm\._FilterDatabase.*\$A\$1:\$G\$4/);
  assert.match(book.files["xl/styles.xml"].toString("utf8"), /formatCode="dd\/mm\/yyyy\\ hh:mm"/);

  // Bảng rỗng vẫn ra file hợp lệ (chỉ tiêu đề)
  const empty = readXlsx(Buffer.from(await context.xlsxBlob(["A", "B"], []).arrayBuffer()));
  assert.deepEqual(empty.table, [["A", "B"]]);
  assert.match(empty.sheet, /<autoFilter ref="A1:B1"\/>/);
  console.log("xlsx_export: Group UID 16 số là chữ đủ chữ số, số/ngày giờ đúng kiểu, định dạng bảng, file rỗng và zip/CRC hợp lệ passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
