import test from "node:test";
import assert from "node:assert/strict";
import { renderGroupUidLabel } from "../src/templates/group-uid-label.mjs";
import { renderSkuLabel } from "../src/templates/sku-label.mjs";

test("template Group UID có đủ hai mã", () => {
  const svg = renderGroupUidLabel({ groupUid: "A40000258795", sku: "204900073", productName: "Vải Rayon Tropical Firal" });
  assert.match(svg, /A40000258795/);
  assert.match(svg, /204900073/);
  assert.match(svg, /Vải Rayon/);
});

test("template Group UID không vẽ vùng SKU khi bỏ trống", () => {
  const svg = renderGroupUidLabel({ groupUid: "A40000258795", sku: "", productName: "Vải Rayon Tropical Firal" });
  assert.doesNotMatch(svg, />SKU:</);
});

const LONG_NAME = "Thun nhung 7mm/W.TT.S-07-323H_Triều Vĩ/65%polyester,*35%spandex/None/XANH NAVY KHÓI 19-4117 TCX_ WKF-12473/none/7mm/mm";

test("template SKU: tên sản phẩm nằm trên cùng, tối đa 8 dòng, không đè QR", () => {
  const svg = renderSkuLabel({ sku: "[SKU_DA_XOA]", productName: LONG_NAME, quantity: "", printedDate: "09-09-26" });
  assert.match(svg, /XANH NAVY/);
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)].map(match => Number(match[1]));
  assert.ok(lines.length >= 1 && lines.length <= 8, `số dòng tên = ${lines.length}`);
  assert.ok(Math.min(...lines) < 60, "dòng tên đầu tiên phải ở gần đỉnh tem");
  // rect QR đầu tiên phải nằm dưới dòng tên cuối cùng (không chồng lên chữ)
  const firstRectY = Number(svg.match(/<rect x="\d+" y="(\d+)"/)[1]);
  assert.ok(firstRectY > Math.max(...lines), `QR (y=${firstRectY}) phải dưới dòng tên cuối (y=${Math.max(...lines)})`);
});

test("template SKU: tên dài đúng 8 dòng hiển thị trọn vẹn (không cắt), mọi phần tử nằm trong mép tem", () => {
  const NAME_8_LINES = "Thun nhung 7mm/W.TT.S-07-323H_Triều Vĩ/65%polyester,*35%spandex/None/XANH NAVY KHÓI 19-4117 TCX_ WKF-12473 phu lieu them chi tiet mau sac/none/7mm/mm";
  const svg = renderSkuLabel({ sku: "[SKU_DA_XOA]", productName: NAME_8_LINES, quantity: "12", printedDate: "24-09-26" });
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)];
  assert.equal(lines.length, 8, "tên đủ dài phải hiển thị đúng 8 dòng, không bị cắt bớt");
  assert.match(svg, /mau sac\/none\/7mm\/mm/, "dòng cuối cùng của tên phải còn nguyên trong tem");
  // Không phần tử nào (QR, số SKU, vạch kẻ, số lượng, ngày) được vượt quá mép tem cao 480 dot.
  const allY = [...svg.matchAll(/y="(\d+)"/g), ...svg.matchAll(/y1="(\d+)"/g), ...svg.matchAll(/y2="(\d+)"/g)]
    .map(match => Number(match[1]));
  assert.ok(allY.every(y => y <= 480), `có toạ độ y vượt mép tem (480): ${Math.max(...allY)}`);
  // QR (khối rect) phải nằm hoàn toàn dưới dòng tên cuối cùng, không chồng chữ.
  const lastLineY = Math.max(...lines.map(match => Number(match[1])));
  const firstRectY = Number(svg.match(/<rect x="\d+" y="(\d+)"/)[1]);
  assert.ok(firstRectY > lastLineY, `QR (y=${firstRectY}) phải dưới dòng tên cuối (y=${lastLineY})`);
});

test("template SKU: có mã QR ở giữa và số SKU in đậm dưới QR", () => {
  const svg = renderSkuLabel({ sku: "[SKU_DA_XOA]", productName: "Hóa chất pha Silicon", quantity: "", printedDate: "11-09-26" });
  const rectCount = (svg.match(/<rect /g) || []).length;
  assert.ok(rectCount > 30, `QR phải có nhiều rect, đếm được ${rectCount}`);
  assert.match(svg, /font-size="32" font-weight="700" text-anchor="middle">[SKU_DA_XOA]<\/text>/);
  assert.doesNotMatch(svg, /y="15"/); // không còn barcode Code128 ở đỉnh
});

test("template Group UID có SKU giữ tên tối đa 6 dòng, không tràn vào vùng SKU", () => {
  const svg = renderGroupUidLabel({ groupUid: "[UID_DA_XOA]", sku: "[SKU_DA_XOA]", productName: LONG_NAME });
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)].map(match => Number(match[1]));
  assert.ok(lines.length <= 6, `số dòng tên = ${lines.length}`);
  assert.ok(Math.max(...lines) < 332, `dòng cuối y=${Math.max(...lines)}`);
  assert.match(svg, /XANH NAVY/);
});

test("template SKU escape nội dung HTML", () => {
  const svg = renderSkuLabel({ sku: "204900073", productName: "Áo & quần <test>", quantity: "12", printedDate: "08-09-26" });
  assert.match(svg, /Áo &amp; quần &lt;test&gt;/);
});

test("template SKU giữ số lượng và ngày ở cuối tem, cùng hàng với vạch kẻ", () => {
  const svg = renderSkuLabel({ sku: "204900073", productName: "Sản phẩm mẫu", quantity: "12", printedDate: "08-09-26" });
  assert.match(svg, /x="12" y="34" font-size="22">Sản phẩm mẫu<\/text>/);
  // Tên 1 dòng dùng vị trí sàn (không phụ thuộc số dòng); số lượng/ngày phải nằm
  // trên cùng một hàng và đúng dưới vạch kẻ — không khẳng định cứng toạ độ tuyệt
  // đối vì đó là chi tiết cài đặt có thể đổi khi tinh chỉnh khoảng đệm.
  const lineY = Number(svg.match(/<line x1="20" y1="(\d+)"/)[1]);
  const qtyY = Number(svg.match(/y="(\d+)" font-size="40"[^>]*>12<\/text>/)[1]);
  const dateY = Number(svg.match(/y="(\d+)" font-size="17"[^>]*>08-09-26<\/text>/)[1]);
  assert.equal(qtyY, dateY, "số lượng và ngày phải cùng một hàng");
  assert.ok(dateY > lineY, "ngày phải nằm dưới vạch kẻ");
  assert.ok(dateY <= 480, "ngày không được tràn khỏi mép tem");
});

test("template SKU thu nhỏ font số lượng khi nhiều ký tự", () => {
  const fontOfQuantity = (svg, quantity) => {
    const escaped = quantity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = svg.match(new RegExp(`x="20" y="\\d+" font-size="(\\d+)" font-weight="700">${escaped}<`));
    assert.ok(match, `không tìm thấy ô số lượng cho "${quantity}"`);
    return Number(match[1]);
  };
  const short = renderSkuLabel({ sku: "204900073", productName: "SP", quantity: "500", printedDate: "11-09-26" });
  const long = renderSkuLabel({ sku: "204900073", productName: "SP", quantity: "1.200,50 mét", printedDate: "11-09-26" });
  assert.equal(fontOfQuantity(short, "500"), 40);
  const longFont = fontOfQuantity(long, "1.200,50 mét");
  assert.ok(longFont < 40, `font dài phải nhỏ hơn 40, đang là ${longFont}`);
});

test("tem Group UID in Lot va Roll o day tem", () => {
  const svg = renderGroupUidLabel({
    groupUid: "[UID_DA_XOA]", sku: "[SKU_DA_XOA]",
    productName: "Vai Pique/SK9115_Shaoxing Sukun/88% Nylon 12% Spandex",
    lot: "B", roll: "56"
  });
  assert.match(svg, /LOT: B/);
  assert.match(svg, /ROLL: 56/);
  // phai nam duoi barcode SKU (ket thuc y=418) va trong long tem (cao 480)
  const y = Number(svg.match(/y="(\d+)"[^>]*>LOT: B/)?.[1] ?? svg.match(/<text x="12" y="(\d+)"[^>]*>LOT/)?.[1]);
  assert.ok(y > 418 && y < 480, `LOT phai o day tem, dang o y=${y}`);
});

test("tem Group UID bo trong Lot/Roll thi khong ve gi them", () => {
  const svg = renderGroupUidLabel({
    groupUid: "[UID_DA_XOA]", sku: "[SKU_DA_XOA]", productName: "Vai Pique"
  });
  assert.ok(!svg.includes("LOT:"), "khong duoc ve LOT khi bo trong");
  assert.ok(!svg.includes("ROLL:"), "khong duoc ve ROLL khi bo trong");
});

test("tem Group UID chi co Lot, khong co Roll", () => {
  const svg = renderGroupUidLabel({
    groupUid: "[UID_DA_XOA]", productName: "Vai Pique", lot: "B"
  });
  assert.match(svg, /LOT: B/);
  assert.ok(!svg.includes("ROLL:"));
});
