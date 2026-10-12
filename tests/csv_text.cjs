// csvText (bộ chung của các màn Admin): mã chỉ gồm chữ số phải ra Excel dưới dạng chữ, không bị đổi thành số khoa học.
// Chạy hàm thật lấy từ index.html trong sandbox; không cần trình duyệt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("        const csvCell=c=>");
const end = html.indexOf("        function download(name,text)", start);
assert.ok(start >= 0 && end > start, "Không tìm thấy csvCell/csvText trong index.html");
const context = { String };
vm.runInNewContext(`${html.slice(start, end)}\nthis.csvText = csvText;`, context);
const csvText = context.csvText;

const text = csvText(["Thời điểm", "Group UID", "SKU", "Số lượng", "Ghi chú"], [
  ["10/10/2026 22:13", "1028260605000272", "422513459", 12000, 'Cắt "đôi"'],
  ["10/10/2026 22:14", "1028260605000299", "0123456789", "0.5", ""],
  ["10/10/2026 22:15", null, "123456789012", "99999999999", "F0-VR-00-00-00-00"],
]);
const lines = text.split("\r\n");
assert.equal(text.charCodeAt(0), 0xfeff, "có BOM UTF-8 để Excel đọc đúng tiếng Việt");
assert.equal(lines.length, 4);
assert.equal(lines[0].slice(1), '"Thời điểm","Group UID","SKU","Số lượng","Ghi chú"');
// Group UID 16 số: dạng ="mã" (trường CSV được rào bằng nháy kép, nháy trong rào gấp đôi)
assert.equal(lines[1], '"10/10/2026 22:13","=""1028260605000272""","422513459","12000","Cắt ""đôi"""');
// Mã bắt đầu bằng 0 giữ số 0; số thập phân và số nhỏ hơn 12 chữ số giữ nguyên
assert.equal(lines[2], '"10/10/2026 22:14","=""1028260605000299""","=""0123456789""","0.5",""');
// 12 chữ số trở lên cũng được bảo vệ; ô rỗng/null ra chuỗi rỗng; số 11 chữ số không bị đụng
assert.equal(lines[3], '"10/10/2026 22:15","","=""123456789012""","99999999999","F0-VR-00-00-00-00"');

// Đọc ngược bằng bộ phân tích CSV chuẩn: trường vẫn là ="mã" nguyên vẹn (Excel đọc công thức này thành chữ)
const parse = line => { const out = []; let cur = "", quoted = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; } else if (c === '"') quoted = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; };
assert.deepEqual(parse(lines[1]), ["10/10/2026 22:13", '="1028260605000272"', "422513459", "12000", 'Cắt "đôi"']);

console.log("csv_text: Group UID 16 số và mã có số 0 đầu ra dạng chữ cho Excel, các ô khác giữ nguyên passed");
