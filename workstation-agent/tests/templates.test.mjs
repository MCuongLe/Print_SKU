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

test("template SKU: tên sản phẩm nằm trên cùng, tối đa 5 dòng", () => {
  const svg = renderSkuLabel({ sku: "422486996", productName: LONG_NAME, quantity: "", printedDate: "09-09-26" });
  assert.match(svg, /XANH NAVY/);
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)].map(match => Number(match[1]));
  assert.ok(lines.length >= 1 && lines.length <= 5, `số dòng tên = ${lines.length}`);
  assert.ok(Math.min(...lines) < 60, "dòng tên đầu tiên phải ở gần đỉnh tem");
});

test("template SKU: có mã QR ở giữa và số SKU in đậm dưới QR", () => {
  const svg = renderSkuLabel({ sku: "422486790", productName: "Hóa chất pha Silicon", quantity: "", printedDate: "11-09-26" });
  const rectCount = (svg.match(/<rect /g) || []).length;
  assert.ok(rectCount > 30, `QR phải có nhiều rect, đếm được ${rectCount}`);
  assert.match(svg, /font-size="32" font-weight="700" text-anchor="middle">422486790<\/text>/);
  assert.doesNotMatch(svg, /y="15"/); // không còn barcode Code128 ở đỉnh
});

test("template Group UID có SKU giữ tên tối đa 6 dòng, không tràn vào vùng SKU", () => {
  const svg = renderGroupUidLabel({ groupUid: "1028260903000012", sku: "422486996", productName: LONG_NAME });
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)].map(match => Number(match[1]));
  assert.ok(lines.length <= 6, `số dòng tên = ${lines.length}`);
  assert.ok(Math.max(...lines) < 332, `dòng cuối y=${Math.max(...lines)}`);
  assert.match(svg, /XANH NAVY/);
});

test("template SKU escape nội dung HTML", () => {
  const svg = renderSkuLabel({ sku: "204900073", productName: "Áo & quần <test>", quantity: "12", printedDate: "08-09-26" });
  assert.match(svg, /Áo &amp; quần &lt;test&gt;/);
});

test("template SKU giữ số lượng và ngày ở cuối tem như tem cũ", () => {
  const svg = renderSkuLabel({ sku: "204900073", productName: "Sản phẩm mẫu", quantity: "12", printedDate: "08-09-26" });
  assert.match(svg, /x="12" y="34" font-size="22">Sản phẩm mẫu<\/text>/);
  assert.match(svg, /y="466" font-size="40"[^>]*>12<\/text>/);
  assert.match(svg, /y="466" font-size="17"[^>]*>08-09-26<\/text>/);
  assert.match(svg, /<line x1="20" y1="424"/);
});

test("template SKU thu nhỏ font số lượng khi nhiều ký tự", () => {
  const short = renderSkuLabel({ sku: "204900073", productName: "SP", quantity: "500", printedDate: "11-09-26" });
  const long = renderSkuLabel({ sku: "204900073", productName: "SP", quantity: "1.200,50 mét", printedDate: "11-09-26" });
  const fontOf = svg => Number(svg.match(/y="466" font-size="(\d+)" font-weight="700"/)[1]);
  assert.equal(fontOf(short), 40);
  assert.ok(fontOf(long) < 40, `font dài phải nhỏ hơn 40, đang là ${fontOf(long)}`);
});
